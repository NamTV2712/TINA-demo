import { createHash, randomUUID } from 'node:crypto';
import type { Meeting } from './desktop.js';
import { RevisionConflict, type TranscriptJournal } from './transcript-journal.js';
import { attributedVoice, sourceChannel, type DiarizationTurn } from './speaker-registry.js';

export interface DiarizationConfig { url: string; token: string }
interface AudioPart { session: string; start_sample: number; end_sample: number; start_ms: number; offset_ms: number }
export interface DiarizationJob {
  version: 'speaker-analysis.v1'; id: string; meeting: string; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  created_at: string; registry_revision: number; audio_sha256: string; num_speakers: number; model: string | null;
  parts: AudioPart[]; turns: DiarizationTurn[]; applied_at?: string; error?: string;
  items: Array<{ segment_id: string; expected_revision: number; start_ms: number; end_ms: number;
    worker_start_ms: number | null; worker_end_ms: number | null; cluster: number | null }>;
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const stopped = (meeting: Meeting) => ['completed', 'failed', 'interrupted'].includes(meeting.status);

/** Keep original sample clocks and gaps; only the system mix is analyzed, never mic/raw-AEC sidecars. */
export function diarizationInput(journal: TranscriptJournal, key: string): { audio: Buffer; parts: AudioPart[]; duration_ms: number } {
  const spans = journal.speakerSourceSpans(key);
  if (!spans.length) throw new RangeError('Verified system-audio samples are required for speaker analysis');
  const parts: AudioPart[] = [], buffers: Buffer[] = [];
  let samples = 0;
  for (const span of spans) {
    if (parts.length) { buffers.push(Buffer.alloc(16000)); samples += 8000; }
    parts.push({ ...span, offset_ms: samples / 16 });
    for (let start = span.start_sample; start < span.end_sample; start += 480000) {
      const end = Math.min(span.end_sample, start + 480000);
      const { samples: pcm, missing } = journal.readSamples(key, span.session, 999, start, end);
      if (!pcm || missing.length) throw new RangeError('System audio has missing samples');
      const bytes = Buffer.allocUnsafe(pcm.length * 2);
      for (let i = 0; i < pcm.length; i++) {
        const value = Math.max(-1, Math.min(1, pcm[i]));
        bytes.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
      }
      buffers.push(bytes); samples += pcm.length;
      if (samples > 1800 * 16000) throw new RangeError('Speaker analysis supports at most 30 minutes including gap padding');
    }
  }
  const header = Buffer.alloc(44), size = samples * 2;
  header.write('RIFF'); header.writeUInt32LE(size + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(size, 40);
  return { audio: Buffer.concat([header, ...buffers]), parts, duration_ms: samples / 16 };
}
export function validateDiarization(value: unknown, audio: Buffer, duration: number): { model: string; turns: DiarizationTurn[] } {
  const result = value as { model?: unknown; audio_sha256?: unknown; duration_ms?: unknown; turns?: unknown } | null;
  if (!result || result.audio_sha256 !== sha(audio) || typeof result.model !== 'string' || !result.model || result.model.length > 256
      || typeof result.duration_ms !== 'number' || !Number.isFinite(result.duration_ms) || Math.abs(result.duration_ms - duration) > 20 || !Array.isArray(result.turns) || result.turns.length > 30000) throw new Error('Invalid speaker-worker provenance');
  const turns = result.turns.map((turn: DiarizationTurn) => {
    if (!turn || !Number.isFinite(turn.start_ms) || !Number.isFinite(turn.end_ms) || turn.start_ms < 0
        || turn.start_ms >= duration || turn.end_ms <= turn.start_ms || turn.end_ms > duration + 20
        || !Number.isSafeInteger(turn.speaker) || turn.speaker < 0 || turn.speaker >= 100) throw new Error('Invalid speaker-worker interval');
    return { start_ms: turn.start_ms, end_ms: Math.min(turn.end_ms, duration), speaker: turn.speaker };
  });
  return { model: result.model, turns };
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Speaker worker failed');
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > 4 * 1024 * 1024) throw new Error('Speaker worker response exceeds limit');
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export class DesktopDiarizer {
  private active: { job: DiarizationJob; controller: AbortController } | null = null;
  private task: Promise<void> | null = null;
  private closing = false;
  get busy(): boolean { return this.task !== null; }
  constructor(private journal: TranscriptJournal, private isLive: () => boolean, private config?: DiarizationConfig) {
    if (config?.url) {
      const url = new URL(config.url);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || !config.token) throw new Error('Desktop diarization requires an authenticated loopback worker');
    }
  }
  get configured(): boolean { return Boolean(this.config?.url && this.config.token); }
  current(key: string): DiarizationJob | null {
    if (this.active?.job.meeting === key) return structuredClone(this.active.job);
    const job = this.journal.diarization(key);
    if (job?.status === 'running') {
      job.status = 'interrupted'; job.error = 'Desktop restarted; start speaker analysis again'; this.journal.saveDiarization(job);
    }
    return job;
  }
  start(meeting: Meeting, numSpeakers: number = -1): DiarizationJob {
    if (!Number.isSafeInteger(numSpeakers) || numSpeakers !== -1 && (numSpeakers < 1 || numSpeakers > 20)) throw new RangeError('Use automatic (-1) or 1–20 speakers');
    if (!this.configured) throw new RangeError('Configure the local diarization worker before analyzing speakers');
    if (this.closing || this.task || this.isLive() || !stopped(meeting)) throw new RevisionConflict('Stop capture and wait for speaker analysis to finish');
    if (meeting.archive_error || meeting.segments.length > 2000) throw new RangeError('Speaker analysis requires a complete archive with at most 2000 segments');
    const key = `${meeting.platform}/${meeting.native_meeting_id}`, input = diarizationInput(this.journal, key);
    const document = this.journal.document(meeting) as { segments: Array<{ segment_id: string; revision: number; start_ms: number; end_ms: number }> };
    const items = document.segments.filter(s => {
      const segment = meeting.segments.find(t => t.segment_id === s.segment_id);
      return segment?.completed === true && sourceChannel(segment) === 999;
    }).map(s => {
      const matches = input.parts.filter(p => s.start_ms >= p.start_ms && s.end_ms <= p.start_ms + (p.end_sample - p.start_sample) / 16);
      const part = matches.length === 1 ? matches[0] : null;
      return { segment_id: s.segment_id, expected_revision: s.revision, start_ms: s.start_ms, end_ms: s.end_ms,
        worker_start_ms: part ? part.offset_ms + s.start_ms - part.start_ms : null,
        worker_end_ms: part ? part.offset_ms + s.end_ms - part.start_ms : null, cluster: null };
    });
    if (!items.length) throw new RangeError('No finalized system-audio segments to analyze');
    const job: DiarizationJob = { version: 'speaker-analysis.v1', id: randomUUID(), meeting: key, status: 'running', created_at: new Date().toISOString(),
      registry_revision: this.journal.speakerState(key).revision, audio_sha256: sha(input.audio), num_speakers: numSpeakers, model: null,
      parts: input.parts, items, turns: [] };
    const controller = new AbortController(); this.active = { job, controller }; this.journal.saveDiarization(job);
    this.task = this.run(job, input, controller).catch(() => {
      job.status = 'failed'; job.error = 'Speaker analysis could not be saved; existing assignments remain unchanged';
    }).finally(() => { this.active = null; this.task = null; });
    return structuredClone(job);
  }
  private async run(job: DiarizationJob, input: ReturnType<typeof diarizationInput>, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    try {
      const form = new FormData(); form.set('file', new Blob([new Uint8Array(input.audio)], { type: 'audio/wav' }), 'system-audio.wav');
      form.set('num_speakers', String(job.num_speakers));
      const response = await fetch(this.config!.url.replace(/\/+$/, '') + '/diarize', { method: 'POST', headers: { Authorization: `Bearer ${this.config!.token}` }, body: form, signal: controller.signal });
      const result = validateDiarization(await boundedJson(response), input.audio, input.duration_ms);
      if (job.num_speakers !== -1 && new Set(result.turns.map(turn => turn.speaker)).size > job.num_speakers) throw new Error('Worker exceeded requested speaker count');
      if (controller.signal.aborted || job.status === 'cancelled') return;
      job.model = result.model; job.turns = result.turns;
      for (const item of job.items) if (item.worker_start_ms !== null && item.worker_end_ms !== null) item.cluster = attributedVoice(item.worker_start_ms, item.worker_end_ms, result.turns);
      job.status = 'completed'; this.journal.saveDiarization(job);
    } catch {
      if (job.status !== 'cancelled') { job.status = this.closing ? 'interrupted' : 'failed'; job.error = 'Speaker analysis failed; audio and assignments remain unchanged'; this.journal.saveDiarization(job); }
    } finally { clearTimeout(timer); }
  }
  cancel(key: string): DiarizationJob | null {
    if (this.active?.job.meeting === key) { this.active.job.status = 'cancelled'; this.active.controller.abort(); this.journal.saveDiarization(this.active.job); }
    return this.current(key);
  }
  apply(meeting: Meeting, id: string): void {
    if (this.isLive() || !stopped(meeting)) throw new RevisionConflict('Stop capture before applying speaker groups');
    const key = `${meeting.platform}/${meeting.native_meeting_id}`, job = this.current(key);
    if (!job || job.id !== id || job.status !== 'completed') throw new RevisionConflict('Speaker analysis is unavailable or changed');
    if (job.applied_at) return;
    const input = diarizationInput(this.journal, key);
    if (sha(input.audio) !== job.audio_sha256 || JSON.stringify(input.parts) !== JSON.stringify(job.parts)) throw new RevisionConflict('Source audio changed; run analysis again');
    this.journal.applyDiarization(meeting, job);
  }
  async close(): Promise<void> { this.closing = true; this.active?.controller.abort(); await this.task; }
}
