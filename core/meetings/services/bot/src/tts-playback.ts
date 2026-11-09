/** Authenticated PCM stream -> bounded prebuffer -> PulseAudio virtual microphone. */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import http from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';

const PAPLAY_ARGS = ['--raw', '--format=s16le', '--rate=24000', '--channels=1', '--device=tts_sink'];
const PREBUFFER = 24000 * 2 * .15;
const MAX_BYTES = 24000 * 2 * 120;
function setTtsMute(muted: boolean): void {
  execSync(`pactl set-sink-mute tts_sink ${muted ? '1' : '0'}`, { stdio: 'pipe' });
  // The source must stay available to Chromium; Meet UI + the dedicated TTS sink gate speech.
  execSync('pactl set-source-mute virtual_mic 0', { stdio: 'pipe' });
}
export type PlaybackOutcome = 'completed' | 'failed' | 'stopped';
export interface PreparedSpeech {
  ready: Promise<boolean>;
  readonly failedBeforePlayback?: boolean;
  play(onStarted?: () => void): Promise<PlaybackOutcome>;
  cancel(): void;
}
export interface TtsPlayback {
  speak(text: string, voice?: string, onStarted?: () => void, timeoutMs?: number): Promise<PlaybackOutcome | void>;
  prepare?(text: string, voice?: string, timeoutMs?: number): PreparedSpeech;
  stop(): void;
}
export interface TtsPlaybackOptions {
  meetingId?: number;
  setMute?: (muted: boolean) => void;
  spawnProcess?: () => ChildProcess;
  requestTimeoutMs?: number;
  service?: (text:string) => {baseUrl:string;token:string;revision:number;requestId:string} | undefined;
}

export function createTtsPlayback(log: (m: string) => void = () => {}, options: TtsPlaybackOptions = {}): TtsPlayback {
  const mute = (value: boolean): boolean => {
    try { (options.setMute ?? setTtsMute)(value); return true; }
    catch { log('[tts] microphone control failed'); return false; }
  };
  const spawnProcess = options.spawnProcess ?? (() => spawn('paplay', PAPLAY_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] }));
  const handles = new Set<PreparedSpeech>();
  let active: PreparedSpeech | undefined;
  function prepare(text: string, voice = 'auto', timeoutMs?: number): PreparedSpeech {
    const buffer = new PassThrough({ highWaterMark: 24000 });
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, proc: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, settled = false, ended = false, bytes = 0, playing = false;
    let failedBeforePlayback = false;
    let readyResolve!: (ready: boolean) => void, doneResolve!: (outcome: PlaybackOutcome) => void;
    const ready = new Promise<boolean>(resolve => { readyResolve = resolve; });
    const done = new Promise<PlaybackOutcome>(resolve => { doneResolve = resolve; });
    const finish = (outcome: PlaybackOutcome) => {
      if (settled) return;
      failedBeforePlayback = outcome === 'failed' && !playing;
      settled = true; clearTimeout(timer); handles.delete(handle); readyResolve(false);
      request?.destroy(); response?.destroy(); buffer.destroy();
      try { proc?.stdin?.destroy(); proc?.kill('SIGKILL'); } catch { /* Cleanup must settle cancellation. */ }
      if (active === handle || !active) { active = undefined; if (!mute(true) && outcome === 'completed') outcome = 'failed'; }
      doneResolve(outcome);
    };
    const handle: PreparedSpeech = {
      ready,
      get failedBeforePlayback() { return failedBeforePlayback; },
      cancel: () => finish('stopped'),
      async play(onStarted) {
        await ready;
        if (settled) return done;
        if (playing) return done;
        if (active && active !== handle) { finish('failed'); return done; }
        playing = true; active = handle;
        if (!mute(false)) { finish('failed'); return done; }
        try { proc = spawnProcess(); } catch { finish('failed'); return done; }
        const player = proc;
        player.stderr?.on('data', () => { log('[tts] player diagnostic'); });
        player.stdin?.on('error', () => finish('failed'));
        player.once('spawn', () => { if (!settled) { try { onStarted?.(); } catch { finish('failed'); } } });
        player.once('error', () => finish('failed'));
        player.once('exit', code => {
          // Null the exited child before cleanup so cancellation cannot re-kill it.
          proc = undefined;
          finish(code === 0 && ended && bytes > 0 && bytes % 2 === 0 ? 'completed' : 'failed');
        });
        buffer.removeAllListeners('readable');
        buffer.pipe(player.stdin!);
        return done;
      },
    };
    buffer.on('error', () => finish('failed'));
    // Current stream + exactly one lookahead, never a private-answer cache.
    if (handles.size >= 2) { finish('failed'); return handle; }
    handles.add(handle);
    const service = options.service?.(text);
    const base = service?.baseUrl ?? process.env.TTS_SERVICE_URL?.trim();
    let url: URL;
    try { if (!base) throw new Error(); url = new URL(base.replace(/\/$/, '') + '/v1/audio/speech'); }
    catch { finish('failed'); return handle; }
    const data = JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'pcm',
      ...(Number.isSafeInteger(options.meetingId) && options.meetingId! > 0 ? { meeting_id: options.meetingId } : {}) });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) };
    if (service) {
      headers.Authorization = `Bearer ${service.token}`;
      headers['X-Voice-Revision'] = String(service.revision);
      headers['X-Voice-Request-Id'] = service.requestId;
    } else if (process.env.TTS_API_TOKEN?.trim()) headers['X-API-Key'] = process.env.TTS_API_TOKEN.trim();
    try {
      request = (url.protocol === 'https:' ? https : http).request({ hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers }, res => {
        response = res;
        if (settled) { res.destroy(); return; }
        if (res.statusCode !== 200 || (res.headers['x-audio-sample-rate'] && res.headers['x-audio-sample-rate'] !== '24000')
            || (res.headers['x-audio-channels'] && res.headers['x-audio-channels'] !== '1')) {
          log(`[tts] service status ${res.statusCode}`); finish('failed'); return;
        }
        res.on('aborted', () => finish('failed')); res.on('error', () => finish('failed'));
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) finish('failed');
        });
        buffer.on('readable', () => { if (buffer.readableLength >= PREBUFFER) readyResolve(true); });
        res.on('end', () => {
          ended = true;
          if (!bytes || bytes % 2) finish('failed'); else readyResolve(true);
        });
        res.pipe(buffer);
      });
      request.on('error', () => finish('failed'));
      timer = setTimeout(() => finish('failed'), Math.min(options.requestTimeoutMs ?? 150000, timeoutMs ?? 150000));
      request.end(data);
    } catch { finish('failed'); }
    return handle;
  }
  const stop = () => { for (const handle of [...handles]) handle.cancel(); mute(true); };
  return { prepare, stop, async speak(text, voice, onStarted, timeoutMs) { if (handles.size) stop(); return prepare(text, voice, timeoutMs).play(onStarted); } };
}
