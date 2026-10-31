/**
 * @tina/capture-codec — the ONE binary-frame + JSON-event serialization shared by
 * both capture lanes (gmeet-capture.v1, mixed-capture.v1). The sender stamps
 * capture-time into every frame; the receiver NEVER restamps. Pure, zero-dep,
 * drift-gated — bot-captured and extension-captured fixtures are byte-identical.
 *
 *   audio frame (binary), two BACKWARD-COMPATIBLE shapes:
 *     no name : [Int32LE track≥0][Float64LE ts][Float32LE pcm…]            (mixed)
 *     w/ name : [Int32LE track|HIGHBIT][Float64LE ts][Int32LE nameLen]
 *               [UTF-8 name, zero-padded to 4B][Float32LE pcm…]           (gmeet)
 *   The high bit of `track` (never set by real track ids 0..1002) flags a named
 *   frame: legacy frames decode unchanged. gmeet binds the glow name HERE at the
 *   source; mixed omits it and names downstream from hints.
 *
 *   event frame (text) : JSON.stringify(MeetingEvent)
 */

/** A meeting event crossing the seam (no audio payload) — chat + lifecycle +
 *  the mixed lane's active-speaker hints all ride this one JSON envelope. */
export interface MeetingEvent {
  kind: 'speaker-joined' | 'speaker-left' | 'active-speaker' | 'caption'
      | 'segment' | 'lifecycle' | 'track-lock' | 'chat';
  ts: number;                 // CAPTURE epoch ms
  speaker?: string;           // active-speaker name / chat sender display name
  text?: string;              // caption / segment / chat text
  detail?: Record<string, unknown>; // active-speaker → {hint:'dom-active'|'dom-outline'|'caption', isEnd, index}
}

// ── capture.v1 MODEL — this brick is the capture.v1 contract: model + serialization. ──

/** One audio chunk crossing the capture→pipeline seam, on ONE channel. */
export interface AudioChunk {
  startSample?: number;       // source-local sample index, when provided by the capture clock
  speakerId: string;          // derived per-channel id, e.g. "spk-3" (not on the wire)
  speakerIndex: number;       // CHANNEL id — raw track index (999 = the mixed channel)
  samples: Float32Array;      // 16 kHz mono PCM
  ts: number;                 // CAPTURE epoch ms — set at the source, carried on the wire
  speakerName?: string;       // name bound AT THE SOURCE when known (gmeet glow); empty ⇒ attribute downstream
}

/** Per-meeting capture meta — platform + the replay topology selecting the downstream strategy. */
export interface CaptureMeta {
  platform?: string;
  nativeMeetingId?: string | number;
  language?: string | null;
  topology?: 'per-participant' | 'mixed';
  sampleRate?: number;
}

/** Native AEC retains the original mic on this archive-only source. */
export const AEC_RAW_MIC_CHANNEL = 1002;

/** Desktop acknowledges an exact source range only after durable PCM storage. */
export const AUDIO_ACK_MODE = 'sample-range.v1';
export interface AudioSampleAck {
  type: 'audio-ack';
  capture_session: string;
  source: number;
  start_sample: number;
  end_sample: number;
}

/** The capture.v1 contract-in port: the pipeline consumes it; the recorder tees it. */
export interface CaptureV1Sink {
  audioChunk(chunk: AudioChunk): void;
  event(ev: MeetingEvent): void;
  finalize(): void | Promise<void>;
}

/** Compose sinks: emit each message to all (the recorder is just another sink). */
export function tee(...sinks: (CaptureV1Sink | null | undefined)[]): CaptureV1Sink {
  const live = sinks.filter(Boolean) as CaptureV1Sink[];
  return {
    audioChunk: (c) => { for (const s of live) try { s.audioChunk(c); } catch { /* */ } },
    event: (e) => { for (const s of live) try { s.event(e); } catch { /* */ } },
    finalize: async () => { for (const s of live) try { await s.finalize(); } catch { /* */ } },
  };
}

const AUDIO_HEADER_BYTES = 12;     // no-name header: Int32 track (4) + Float64 ts (8)
const NAMED_HEADER_BYTES = 16;     // + Int32 nameLen (4), when the name flag is set
const NAME_FLAG = 0x80000000 | 0;  // high bit of track ⇒ trailing name present

/** Encode an audio chunk for the wire — capture-time rides in the header, and the
 *  source-bound speaker name (gmeet glow) rides after it when present. */
export function encodeAudioFrame(speakerIndex: number, ts: number, pcm: Float32Array, speakerName?: string, startSample?: number): ArrayBuffer {
  if (!Number.isSafeInteger(speakerIndex) || speakerIndex < 0 || speakerIndex >= 0x40000000 || !Number.isFinite(ts) ||
      (startSample !== undefined && (!Number.isSafeInteger(startSample) || startSample < 0))) throw new Error('Invalid capture header');
  const name = speakerName ? new TextEncoder().encode(speakerName) : new Uint8Array();
  const indexed = startSample !== undefined;
  const base = AUDIO_HEADER_BYTES + (indexed ? 8 : 0);
  const header = base + (name.length ? 4 : 0);
  const padded = (name.length + 3) & ~3;
  const buf = new ArrayBuffer(header + padded + pcm.length * 4);
  const view = new DataView(buf);
  view.setInt32(0, speakerIndex | (name.length ? NAME_FLAG : 0) | (indexed ? 0x40000000 : 0), true);
  view.setFloat64(4, ts, true);
  if (indexed) view.setFloat64(12, startSample!, true);
  if (name.length) { view.setInt32(base, name.length, true);new Uint8Array(buf,header,name.length).set(name); }
  new Float32Array(buf,header+padded).set(pcm);
  return buf;
}

/** Old byte layouts are unchanged; bit 30 adds a source-local Float64 safe integer sample index. */
export function decodeAudioFrame(buf: ArrayBufferLike, byteOffset = 0, byteLength?: number):
    { speakerIndex: number; ts: number; samples: Float32Array; speakerName?: string; startSample?: number } | null {
  const len = byteLength ?? buf.byteLength - byteOffset;
  if (len < AUDIO_HEADER_BYTES || byteOffset < 0 || byteOffset+len > buf.byteLength) return null;
  const view = new DataView(buf as ArrayBuffer,byteOffset,len);
  const raw=view.getInt32(0,true), ts=view.getFloat64(4,true);
  const indexed=!!(raw & 0x40000000), named=!!(raw & NAME_FLAG);
  const base=AUDIO_HEADER_BYTES+(indexed?8:0);
  if (!Number.isFinite(ts) || len<base+(named?4:0)) return null;
  const startSample=indexed?view.getFloat64(12,true):undefined;
  if (startSample!==undefined && (!Number.isSafeInteger(startSample)||startSample<0)) return null;
  const nameLen=named?view.getInt32(base,true):0;
  if (nameLen<0 || nameLen>4096) return null;
  const header=base+(named?4:0), padded=(nameLen+3)&~3, pcmStart=header+padded;
  if (len<pcmStart || (len-pcmStart)%4 || len-pcmStart>16000*90*4) return null;
  const samples=new Float32Array((len-pcmStart)/4);
  for(let i=0;i<samples.length;i++) { samples[i]=view.getFloat32(pcmStart+i*4,true);if(!Number.isFinite(samples[i]))return null; }
  const speakerIndex=raw & 0x3fffffff;
  return {speakerIndex,ts,samples,...(named?{speakerName:new TextDecoder().decode(new Uint8Array(buf as ArrayBuffer,byteOffset+header,nameLen))}:{}),...(indexed?{startSample}:{})};
}

/** Encode / decode a meeting event for the wire (text frame). */
export function encodeEvent(ev: MeetingEvent): string { return JSON.stringify(ev); }
export function decodeEvent(json: string): MeetingEvent | null {
  try {
    const e = JSON.parse(json);
    if (typeof e?.kind !== 'string' || typeof e?.ts !== 'number') return null;
    return e as MeetingEvent;
  } catch { return null; }
}

// ───────────────────────────────────────────────────────────────────────
// recording-chunk frame (binary) — recording.v1 over the same ingest WS.
//
// DEPLOYMENT NOTE — this is the DESKTOP transport for recording.v1. The bot /
// production alternative is the HTTP path (@tina/recording RecordingService.
// uploadChunk → meeting-api /internal/recordings/upload). Same recording.v1
// chunk contract, two wires by deployment (deliberate): the all-Node desktop has
// no meeting-api HTTP endpoint, so recording chunks ride the existing ingest WS.
//
// A meeting RECORDING (the combined media, WebM/WAV) is NOT transcription audio:
// it rides the same WS but as its own frame, keyed by a leading magic so the
// receiver tells it apart from an audio frame. The magic (0x52454331 'REC1') is
// a large positive Int32 — never a real track id (0..1002) and never the audio
// name-flag (high bit) — so decodeRecordingChunk returns null on an audio frame
// (the receiver tries it first, then falls back to decodeAudioFrame).
// ───────────────────────────────────────────────────────────────────────

const REC_MAGIC = 0x52454331;     // 'REC1'
const REC_HEADER_BYTES = 16;      // magic(4) + seq(4) + isFinal(4) + formatCode(4)
const REC_FORMATS = ['webm', 'wav'] as const;
export type RecordingFormat = typeof REC_FORMATS[number];

/** Encode one recording chunk for the wire. `bytes` is the raw media (WebM/WAV);
 *  the final chunk may be empty (isFinal=true is the COMPLETED signal). */
export function encodeRecordingChunk(seq: number, isFinal: boolean, format: RecordingFormat, bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(REC_HEADER_BYTES + bytes.length);
  const view = new DataView(buf);
  view.setInt32(0, REC_MAGIC, true);
  view.setInt32(4, seq, true);
  view.setInt32(8, isFinal ? 1 : 0, true);
  const code = REC_FORMATS.indexOf(format);
  view.setInt32(12, code < 0 ? 0 : code, true);
  if (bytes.length) new Uint8Array(buf, REC_HEADER_BYTES).set(bytes);
  return buf;
}

/** Decode a recording-chunk frame. Returns null if the magic doesn't match (i.e.
 *  this is NOT a recording frame) so the receiver can fall through to audio. */
export function decodeRecordingChunk(buf: ArrayBufferLike, byteOffset = 0, byteLength?: number):
    { seq: number; isFinal: boolean; format: RecordingFormat; bytes: Uint8Array } | null {
  const len = byteLength ?? (buf as ArrayBuffer).byteLength - byteOffset;
  if (len < REC_HEADER_BYTES) return null;
  const view = new DataView(buf as ArrayBuffer, byteOffset, len);
  if (view.getInt32(0, true) !== REC_MAGIC) return null;     // not a recording frame
  const seq = view.getInt32(4, true);
  const isFinal = view.getInt32(8, true) === 1;
  const format = REC_FORMATS[view.getInt32(12, true)] ?? 'webm';
  const bytes = new Uint8Array(buf as ArrayBuffer, byteOffset + REC_HEADER_BYTES, len - REC_HEADER_BYTES);
  return { seq, isFinal, format, bytes };
}
