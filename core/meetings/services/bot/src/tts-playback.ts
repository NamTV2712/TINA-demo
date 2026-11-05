/**
 * TTS playback adapter (2b) — the OS-level half of the SPEAK path.  // L4 (O6/VM).
 *
 * The browser half (unmute the meeting-UI mic) lives in capture-bridge.ts's SpeakController; this
 * is the audio half: synthesize `text` via the TINA TTS service and play the returned PCM through
 * the container's PulseAudio `tts_sink` (→ `virtual_mic`, which Chromium captures as its mic). The
 * `tts_sink → virtual_mic` graph is created by entrypoint.sh; here we only unmute it during
 * playback, stream PCM to `paplay`, and re-mute after.
 *
 * Ported (focused: the streaming-PCM path only — no ffmpeg) from the production bot
 *   services/tina-bot/core/src/services/tts-playback.ts (synthesizeViaTtsService + (un)mute).
 * acts.v1 `speak` already carries {text, voice} — no contract change. Config is infrastructure
 * (the TTS service URL/token), read from env like production (TTS_SERVICE_URL / TTS_API_TOKEN),
 * NOT the sealed invocation.v1. Gated by the SpeakController on inv.voiceAgentEnabled.
 *
 * Node-only (child_process + http/https) — no DOM, no workspace imports → gate:isolation-clean.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import type { ClientRequest } from 'node:http';

const PAPLAY_ARGS = ['--raw', '--format=s16le', '--rate=24000', '--channels=1', '--device=tts_sink'];

function setTtsMute(muted: boolean, log: (m: string) => void): void {
  const v = muted ? '1' : '0';
  try {
    execSync(`pactl set-sink-mute tts_sink ${v}`, { stdio: 'pipe' });
    execSync(`pactl set-source-mute virtual_mic ${v}`, { stdio: 'pipe' });
  } catch (err) {
    log(`[tts] pactl ${muted ? 'mute' : 'unmute'} failed: ${(err as Error).message}`);
    throw new Error('TTS microphone control failed');
  }
}

export interface TtsPlayback {
  /** Synthesize `text` (voice optional) and play it into the meeting via tts_sink. Resolves when
   *  playback finishes. Best-effort: a synthesis/playback failure logs + resolves (never throws out
   *  — the voice handler must not break the orchestrator). */
  speak(text: string, voice?: string, onStarted?: () => void): Promise<PlaybackOutcome | void>;
  /** Interrupt any in-flight playback (barge-in) + re-mute. */
  stop(): void;
}

export type PlaybackOutcome = 'completed' | 'failed' | 'stopped';

export interface TtsPlaybackOptions {
  /** Injected by offline tests; production uses the PulseAudio mute helper. */
  setMute?: (muted: boolean) => void;
  /** Deterministic process boundary for tests; production always spawns paplay. */
  spawnProcess?: () => ChildProcess;
  /** Total synthesis + playback budget, below the coordinator's 175 s receipt wait. */
  requestTimeoutMs?: number;
}

/** Build a TtsPlayback that streams the TTS service's PCM straight to paplay. */
export function createTtsPlayback(
  log: (m: string) => void = () => { /* */ },
  options: TtsPlaybackOptions = {},
): TtsPlayback {
  const mute = options.setMute ?? ((muted: boolean) => setTtsMute(muted, log));
  const setMute = (muted: boolean): boolean => {
    try { mute(muted); return true; }
    catch { log('[tts] microphone control failed'); return false; }
  };
  const spawnProcess = options.spawnProcess ?? (() => spawn('paplay', PAPLAY_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] }));
  let proc: ChildProcess | null = null;
  let request: ClientRequest | null = null;
  let cancelActive: (() => void) | null = null;
  let generation = 0;

  const stop = (): void => {
    generation++;
    const child = proc;
    proc = null;
    const cancel = cancelActive;
    cancelActive = null;
    if (cancel) {
      cancel();
    } else if (request) {
      const currentRequest = request;
      request = null;
      try { currentRequest.destroy(new Error('TTS playback stopped')); } catch { /* */ }
    }
    if (child) {
      try { child.stdin?.destroy(); child.kill('SIGKILL'); } catch { /* */ }
    }
    setMute(true);
  };

  const speak = async (text: string, voice = 'auto', onStarted?: () => void): Promise<PlaybackOutcome> => {
    // A newer speech command supersedes any request or playback still in flight.
    if (request || proc) stop();
    const base = process.env.TTS_SERVICE_URL?.trim();
    if (!base) { log('[tts] TTS_SERVICE_URL not set — speak is a no-op'); return 'failed'; }
    const speechGeneration = ++generation;
    const postData = JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'pcm' });
    let url: URL;
    try { url = new URL(`${base.replace(/\/$/, '')}/v1/audio/speech`); }
    catch { log('[tts] bad TTS_SERVICE_URL'); return 'failed'; }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(postData)),
    };
    const token = process.env.TTS_API_TOKEN?.trim();
    if (token) headers['X-API-Key'] = token;

    return await new Promise<PlaybackOutcome>((resolve) => {
      let settled = false;
      let req: ClientRequest;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: PlaybackOutcome = 'failed'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (request === req) request = null;
        if (cancelActive === cancel) cancelActive = null;
        resolve(outcome);
      };
      const cancel = (): void => {
        if (settled) return;
        try { req.destroy(new Error('TTS playback stopped')); } catch { /* */ }
        finish('stopped');
      };
      const fail = (): void => {
        if (settled) return;
        finish('failed');
        if (speechGeneration !== generation) return;
        req.destroy();
        const child = proc;
        proc = null;
        try { child?.stdin?.destroy(); child?.kill('SIGKILL'); } catch { /* */ }
        setMute(true);
      };
      req = (url.protocol === 'https:' ? https : http).request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      }, (res) => {
        if (speechGeneration !== generation) {
          res.resume();
          finish('stopped');
          return;
        }
        if (res.statusCode !== 200) {
          let responseBytes = 0;
          res.on('data', (chunk: Buffer) => { responseBytes += chunk.length; });
          res.on('end', () => {
            if (speechGeneration === generation) log(`[tts] service ${res.statusCode}: ${responseBytes} response bytes`);
            finish();
          });
          res.on('aborted', finish);
          return;
        }
        if (!setMute(false)) { setMute(true); res.resume(); finish('failed'); return; }
        let p: ChildProcess;
        try { p = spawnProcess(); }
        catch { fail(); return; }
        proc = p;
        p.stderr?.on('data', (d: Buffer) => log(`[tts] paplay: ${d.toString().trim()}`));
        let bytes = 0;
        let received = false;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 24000 * 2 * 120) {
            res.destroy(); p.kill('SIGKILL');
          }
        });
        res.on('end', () => { received = bytes > 0 && bytes % 2 === 0; });
        res.on('aborted', () => { p.kill('SIGKILL'); });
        res.on('error', () => { p.kill('SIGKILL'); });
        p.stdin?.on('error', () => { p.kill('SIGKILL'); });
        p.once('spawn', () => {
          if (!settled && speechGeneration === generation) {
            try { onStarted?.(); }
            catch { fail(); }
          }
        });
        const done = (code: number | null = null) => {
          if (proc === p) proc = null;
          const muted = speechGeneration !== generation || setMute(true);
          finish(speechGeneration !== generation ? 'stopped' : code === 0 && received && muted ? 'completed' : 'failed');
        };
        p.on('exit', done);
        p.on('error', (e) => { log(`[tts] paplay error: ${String(e)}`); done(); });
        res.pipe(p.stdin!);                           // stream PCM straight to the mic sink
      });
      request = req;
      cancelActive = cancel;
      req.on('error', (e) => {
        if (speechGeneration === generation) log(`[tts] request error: ${String(e)}`);
        fail();
      });
      deadline = setTimeout(fail, options.requestTimeoutMs ?? 150_000);
      req.write(postData); req.end();
    });
  };

  return { speak, stop };
}
