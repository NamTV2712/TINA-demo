import { createHash, randomUUID } from 'node:crypto';
import { TranscriptionClient } from '@tina/transcribe-whisper';
import { normalizeTranscript, RevisionConflict, type TranscriptJournal } from './transcript-journal.js';
import type { Meeting } from './desktop.js';
import type { TranscriptionConfig } from './transcription-settings.js';

export interface RefinementItem {
  segment_id: string; expected_revision: number; state: 'pending' | 'ready' | 'skipped' | 'failed' | 'applied';
  text?: string; audio_sha256?: string; reason?: string;
}
export interface RefinementJob {
  version: 'transcript-refinement.v1';
  id: string; meeting: string; status: 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  model: string; backend: string; created_at: string; glossary?: string[]; items: RefinementItem[]; error?: string;
}
const digest = (wav: Buffer) => createHash('sha256').update(wav).digest('hex');
const terminal = (meeting: Meeting) => ['completed', 'failed', 'interrupted'].includes(meeting.status);

/** One background second pass. Suggestions never mutate live ASR or manual revisions. */
export class TranscriptRefiner {
  private active: RefinementJob | null = null;
  private task: Promise<void> = Promise.resolve();
  private closing = false;
  get busy(): boolean { return this.active !== null; }
  constructor(private journal: TranscriptJournal, private isLive: () => boolean) {}
  private stopped(job: RefinementJob): boolean { return this.closing || job.status === 'cancelling'; }

  start(meeting: Meeting, config: TranscriptionConfig, glossary: string[] = []): RefinementJob {
    if (!Array.isArray(glossary) || glossary.length > 40 || glossary.some(t => typeof t !== "string" || !t.trim() || t.length > 80 || /[\x00-\x1f]/u.test(t)) || glossary.join(", ").length > 700) throw new RangeError("Use up to 40 vocabulary terms, 80 characters each, 700 characters total");
    glossary = [...new Set(glossary.map(normalizeTranscript))];
    if (this.closing || this.active || this.isLive() || !terminal(meeting)) {
      throw new RevisionConflict('Stop capture and wait for the current refinement before starting.');
    }
    if (!config.url) throw new Error('No transcription backend configured');
    if (meeting.archive_error) throw new Error('Audio archive is incomplete; refinement is unavailable for this meeting.');
    const doc = this.journal.document(meeting) as { segments: Array<{ segment_id: string; revision: number }> };
    if (!doc.segments.length) throw new Error('No confirmed transcript to refine');
    const job: RefinementJob = { version: 'transcript-refinement.v1', id: randomUUID(), meeting: `${meeting.platform}/${meeting.native_meeting_id}`,
      glossary, status: 'running', model: config.model, backend: config.summary.label, created_at: new Date().toISOString(),
      items: doc.segments.map(s => ({ segment_id: s.segment_id, expected_revision: s.revision, state: 'pending' })) };
    this.journal.saveRefinement(job); this.active = job;
    const client = new TranscriptionClient({ serviceUrl: config.url, apiToken: config.token, model: config.model,
      requestTimeoutMs: 30000, maxRetries: 0 });
    this.task = this.run({ ...meeting, segments: meeting.segments.map(s => ({ ...s })) }, job, client).catch(() => {
      job.status = 'failed'; job.error = 'Refinement could not be saved; the original transcript is unchanged.';
      try { this.journal.saveRefinement(job); } catch { /* storage fault remains visible in the returned job */ }
    }).finally(() => { this.active = null; });
    return structuredClone(job);
  }
  current(key: string): RefinementJob | null {
    if (this.active?.meeting === key) return structuredClone(this.active);
    const job = this.journal.refinement(key);
    // A failed progress write must not leave the UI polling a worker that already stopped.
    return job && ['running', 'paused', 'cancelling'].includes(job.status)
      ? { ...job, status: 'interrupted', error: 'Worker stopped before progress could be saved; start a new refinement to retry.' } : job;
  }
  cancel(key: string): RefinementJob | null {
    if (this.active?.meeting === key) {
      this.active.status = 'cancelling'; this.journal.saveRefinement(this.active);
    }
    return this.current(key);
  }
  apply(meeting: Meeting, jobId: string, segmentId: string, expected: number): void {
    if (!terminal(meeting)) throw new RevisionConflict('Stop capture before applying refinement.');
    if (this.active?.id === jobId) throw new RevisionConflict('Wait for refinement to finish before applying.');
    const key = `${meeting.platform}/${meeting.native_meeting_id}`, job = this.current(key);
    const item = job?.items.find(s => s.segment_id === segmentId);
    if (!job || job.id !== jobId || !item || item.state !== 'ready' || !item.text || item.expected_revision !== expected) {
      throw new RevisionConflict('Refinement changed or is unavailable; reload before applying.');
    }
    const segment = meeting.segments.find(s => s.segment_id === segmentId);
    const audio = segment && this.journal.clip(key, segment);
    if (!segment || !audio || digest(audio) !== item.audio_sha256) throw new RevisionConflict('Source audio changed; run refinement again.');
    this.journal.applyRefinement(job, segment, item);
  }
  private async run(meeting: Meeting, job: RefinementJob, client: TranscriptionClient): Promise<void> {
    for (const item of job.items) {
      while (this.isLive() && !this.stopped(job)) {
        job.status = 'paused'; this.journal.saveRefinement(job);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (this.stopped(job)) break;
      job.status = 'running';
      const segment = meeting.segments.find(s => s.segment_id === item.segment_id);
      // shortcut: bounded utterance re-decode only, add aligned long-window decoding before supporting >30s.
      const audio = segment && segment.end - segment.start <= 30 && this.journal.clip(job.meeting, segment);
      if (!audio) { item.state = 'skipped'; item.reason = 'Source audio is unavailable, ambiguous or longer than 30 seconds.'; }
      else {
        try {
          const pcm = new Float32Array((audio.length - 44) / 4);
          for (let i = 0; i < pcm.length; i++) pcm[i] = audio.readFloatLE(44 + i * 4);
          // Vocabulary hints are optional; never force a language or pass the reference transcript.
          const result = await client.transcribe(pcm, undefined, job.glossary?.length ? "Vocabulary: " + job.glossary.join(", ") : undefined);
          if (this.stopped(job)) break;
          const text = typeof result.text === 'string' ? normalizeTranscript(result.text) : '';
          if (!text || text.length > 10000) throw new Error('Invalid ASR result');
          item.text = text; item.audio_sha256 = digest(audio); item.state = 'ready';
        } catch {
          item.state = 'failed'; item.reason = 'ASR failed, timed out or returned empty text. Start a new refinement to retry.';
        }
      }
      this.journal.saveRefinement(job);
    }
    if (job.status === 'cancelling') job.status = 'cancelled';
    else if (this.closing) job.status = 'interrupted';
    else job.status = job.items.some(i => i.state === 'ready' || i.state === 'applied') ? 'completed' : 'failed';
    this.journal.saveRefinement(job);
  }
  async close(): Promise<void> { this.closing = true; await this.task; }
}
