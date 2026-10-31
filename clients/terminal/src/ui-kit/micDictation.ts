/** micDictation — REAL-TIME streaming dictation for the chat composer.
 *
 *  Ports the meetings pipeline's delivery mechanism (see
 *  core/meetings/modules/gmeet-pipeline/src/speaker-streams.ts and
 *  core/meetings/modules/buffer — LocalAgreement) to the single-speaker case:
 *
 *   - capture 16 kHz PCM (same ScriptProcessor technique as @tina/mixed-capture-core);
 *   - a sliding window: every SUBMIT_MS the UNCONFIRMED audio
 *     is re-submitted to /api/stt with the confirmed text as the Whisper prompt
 *     (context continuity, exactly like the meeting pipeline);
 *   - LocalAgreement-2: words stable across two consecutive passes CONFIRM; confirmed
 *     audio is trimmed through the last confirmed word's end timestamp;
 *     the unstable tail is published as the live
 *     PENDING draft;
 *   - a window cap force-confirms so pending text is never stranded (the pipeline's
 *     TTL idle-finalize equivalent).
 *
 *  Duplicated rather than imported because the terminal image is a self-contained
 *  npm build (no @tina/* workspace deps — see clients/terminal/Dockerfile).
 *  Transcription stays server-side (/api/stt) so STT credentials never reach the
 *  browser.
 */

import { recordAsrTiming, type BrowserAsrTiming } from "../lib/asrTelemetry";

export interface SttWord { word: string; start: number; end: number }

export interface StreamingDictation {
  /** Stop capturing, flush the last window, and resolve the FULL final text. */
  stop(): Promise<string>;
  /** Abort immediately: release the mic, discard everything. */
  cancel(): void;
}

export interface StreamingDictationOptions {
  /** Live progress: confirmed text + the unstable pending tail. */
  onUpdate?: (confirmed: string, pending: string) => void;
  /** Non-fatal mid-stream STT failures (the window is retried on the next tick). */
  onError?: (message: string) => void;
}

const SAMPLE_RATE = 16000;
const SUBMIT_MS = 2500;               // meeting pipeline submits ~every 2s; dictation matches
const MIN_WINDOW_SAMPLES = SAMPLE_RATE; // ≥1s of unconfirmed audio before a submission
const FORCE_CONFIRM_SEC = 25;         // window cap: force-confirm so pending never strands

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Longest common word prefix across two passes (the buffer module's agreement core). */
function agreedPrefixLen(prev: SttWord[], cur: SttWord[]): number {
  let n = 0;
  while (n < prev.length && n < cur.length && norm(prev[n].word) === norm(cur[n].word)) n++;
  return n;
}

export async function startStreamingDictation(opts: StreamingDictationOptions = {}): Promise<StreamingDictation> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);

  const chunks: Float32Array[] = [];
  let totalSamples = 0;
  let capturedAtMs = 0;
  proc.onaudioprocess = (e: AudioProcessingEvent) => {
    const copy = new Float32Array(e.inputBuffer.getChannelData(0));  // copy — the buffer is reused
    chunks.push(copy);
    totalSamples += copy.length;
    capturedAtMs = Date.now();
  };
  source.connect(proc);
  proc.connect(ctx.destination);  // pull the processor (outputs silence)
  void ctx.resume().catch(() => { /* best-effort */ });

  // Chunks hold only audio that has not been confirmed yet.
  let confirmedText = "";
  let prevWords: SttWord[] = [];
  let inFlight = false;
  let stopped = false;

  const windowEnd = () => Math.min(totalSamples, FORCE_CONFIRM_SEC * SAMPLE_RATE);
  const windowPcm = (end: number): Float32Array => {
    const out = new Float32Array(end);
    let off = 0;
    for (const c of chunks) {
      const count = Math.min(c.length, end - off);
      out.set(c.subarray(0, count), off);
      off += count;
      if (off === end) break;
    }
    return out;
  };

  const consumeAudio = (samples: number) => {
    let remaining = Math.min(Math.max(samples, 0), totalSamples);
    totalSamples -= remaining;
    let count = 0;
    while (count < chunks.length && remaining >= chunks[count].length) {
      remaining -= chunks[count].length;
      count++;
    }
    chunks.splice(0, count);
    if (remaining > 0) chunks[0] = chunks[0].slice(remaining);
  };

  const transcribeWindow = async (pcm: Float32Array): Promise<{ text: string; words: SttWord[] }> => {
    const submittedAt = performance.now();
    const audioEndMs = capturedAtMs - (totalSamples - pcm.length) / SAMPLE_RATE * 1000;
    const q = confirmedText ? `?prompt=${encodeURIComponent(confirmedText.slice(-400))}` : "";
    const r = await fetch(`/api/stt${q}`, { method: "POST", headers: {
      "Content-Type": "audio/wav", "X-ASR-Capture-Ms": String(Math.max(0, Date.now() - audioEndMs)),
    }, body: pcmToWav(pcm) });
    const d = (await r.json().catch(() => ({}))) as { text?: string; words?: SttWord[]; error?: string };
    const receivedAt = performance.now();
    const timing: BrowserAsrTiming = { source: "dictation", at_ms: Date.now(),
      request_id: r.headers.get("X-ASR-Request-ID") ?? undefined,
      http_ms: receivedAt - submittedAt, frame_ms: null };
    recordAsrTiming(timing);
    if (timing.request_id && !document.hidden && document.hasFocus()) {
      requestAnimationFrame(() => {
        if (!document.hidden && document.hasFocus()) recordAsrTiming({ ...timing, frame_ms: performance.now() - receivedAt });
      });
    }
    if (!r.ok) throw new Error(d.error || `transcription failed (${r.status})`);
    return { text: (d.text ?? "").trim(), words: d.words ?? [] };
  };

  const joinWords = (ws: SttWord[]) => ws.map((w) => w.word).join("").trim();

  const submit = async () => {
    if (inFlight || stopped) return;
    if (totalSamples < MIN_WINDOW_SAMPLES) return;
    inFlight = true;
    try {
      const submittedSamples = windowEnd();
      const { text, words } = await transcribeWindow(windowPcm(submittedSamples));
      if (stopped) return;
      if (words.length === 0) {
        prevWords = [];
        if (submittedSamples >= FORCE_CONFIRM_SEC * SAMPLE_RATE) {
          // Text-only backends confirm a whole submitted window; newly captured audio stays buffered.
          if (text) confirmedText = confirmedText ? `${confirmedText} ${text}` : text;
          consumeAudio(submittedSamples);
          opts.onUpdate?.(confirmedText, "");
        } else {
          opts.onUpdate?.(confirmedText, text);
        }
        return;
      }
      const windowSec = submittedSamples / SAMPLE_RATE;
      let n = agreedPrefixLen(prevWords, words);
      if (n === 0 && windowSec >= FORCE_CONFIRM_SEC) n = words.length;
      if (n > 0) {
        const confirmed = joinWords(words.slice(0, n));
        if (confirmed) confirmedText = confirmedText ? `${confirmedText} ${confirmed}` : confirmed;
        consumeAudio(Math.min(Math.round(words[n - 1].end * SAMPLE_RATE), submittedSamples));
        prevWords = [];                                      // window moved — old pass is incomparable
      } else {
        prevWords = words;
      }
      opts.onUpdate?.(confirmedText, joinWords(words.slice(n)));
    } catch (e) {
      opts.onError?.(e instanceof Error ? e.message : "transcription failed");
    } finally { inFlight = false; }
  };

  const timer = setInterval(() => { void submit(); }, SUBMIT_MS);

  const release = () => {
    clearInterval(timer);
    try { proc.disconnect(); proc.onaudioprocess = null; } catch { /* */ }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => { /* */ });
  };

  const waitIdle = async () => { while (inFlight) await new Promise((r) => setTimeout(r, 60)); };

  return {
    async stop(): Promise<string> {
      stopped = true;
      release();
      await waitIdle();
      // Flush bounded windows until all remaining audio is covered.
      while (totalSamples >= MIN_WINDOW_SAMPLES / 4) {
        try {
          const submittedSamples = windowEnd();
          const { text } = await transcribeWindow(windowPcm(submittedSamples));
          if (text) confirmedText = confirmedText ? `${confirmedText} ${text}` : text;
          consumeAudio(submittedSamples);
        } catch (e) {
          opts.onError?.(e instanceof Error ? e.message : "transcription failed");
          break;
        }
      }
      opts.onUpdate?.(confirmedText, "");
      return confirmedText;
    },
    cancel(): void { stopped = true; release(); },
  };
}

/** 16-bit PCM mono WAV (mirrors the whisper module's float32ToWav). */
export function pcmToWav(samples: Float32Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const dataSize = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
