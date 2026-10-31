import { randomUUID } from 'node:crypto';
import type { Meeting } from './desktop.js';
import { RevisionConflict, type TranscriptJournal } from './transcript-journal.js';
import { alignmentHash, validateAlignment, type AlignmentItem, type AlignmentJob } from './alignment-model.js';

export interface AlignmentConfig { url: string; token: string }

export class DesktopAligner {
  private active: { key: string; job: AlignmentJob; controller: AbortController } | null = null;
  private task: Promise<void> | null = null;
  private closing = false;
  constructor(private journal: TranscriptJournal, private isLive: () => boolean, private otherBusy: () => boolean, private config?: AlignmentConfig) {
    if (config?.url) {
      const url = new URL(config.url);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || !config.token) throw new Error('Alignment requires an authenticated loopback worker');
    }
  }
  get busy(): boolean { return Boolean(this.task); }
  get available(): boolean { return Boolean(this.config?.url && this.config.token); }
  current(key: string) {
    let job = this.active?.key === key ? structuredClone(this.active.job) : this.journal.alignmentJob(key);
    if (job && ['running', 'paused'].includes(job.status) && this.active?.key !== key) {
      job.status = 'interrupted'; job.error = 'Desktop restarted; run alignment again'; this.journal.saveAlignmentJob(key, job);
    }
    const meeting = job && this.journal.load().find(m => `${m.platform}/${m.native_meeting_id}` === key);
    if (job) for (const item of job.items) {
      if (item.state === 'aligned' && (!meeting || !this.journal.alignmentMatches(meeting, item))) item.state = 'stale';
    }
    return { version: 'transcript-alignment.v1', available: this.available, job };
  }
  start(meeting: Meeting): AlignmentJob {
    if (!this.available) throw new RangeError('Configure the local alignment worker first');
    if (this.closing || this.task || this.otherBusy() || this.isLive() || !['completed', 'failed', 'interrupted'].includes(meeting.status)) throw new RevisionConflict('Stop capture and wait for current audio processing');
    if (meeting.archive_error || !meeting.segments.length || meeting.segments.length > 2000) throw new RangeError('Alignment requires a complete archive with 1–2000 segments');
    const key = `${meeting.platform}/${meeting.native_meeting_id}`, items: AlignmentItem[] = [];
    let tokens = 0;
    for (const segment of meeting.segments) {
      const input = this.journal.alignmentSource(meeting, segment.segment_id);
      if (!input) continue;
      tokens += input.text.match(/\S+/gu)?.length ?? 0;
      if (tokens > 20000) throw new RangeError('Alignment supports at most 20000 tokens per job');
      items.push({ segment_id: segment.segment_id, state: 'pending', expected_revision: input.revision,
        text_sha256: alignmentHash(input.text), audio_sha256: alignmentHash(input.audio), capture: input.capture });
    }
    if (!items.length) throw new RangeError('No finalized segments with verified continuous audio up to 30 seconds');
    const job: AlignmentJob = { version: 'transcript-alignment.v1', id: randomUUID(), status: 'running', backend: 'mfa', model: 'pending', text_kind: 'accepted', created_at: new Date().toISOString(), items };
    this.journal.saveAlignmentJob(key, job);
    const controller = new AbortController(); this.active = { key, job, controller };
    this.task = this.run(meeting, key, job, controller).catch(() => {
      job.status = 'failed'; job.error = 'Alignment progress could not be saved';
      try { this.journal.saveAlignmentJob(key, job); } catch { /* Existing accepted metadata remains intact. */ }
    }).finally(() => { this.active = null; this.task = null; });
    return structuredClone(job);
  }
  private async run(meeting: Meeting, key: string, job: AlignmentJob, controller: AbortController) {
    for (let index = 0; index < job.items.length && !controller.signal.aborted; index += 20) {
      while (this.isLive() && !controller.signal.aborted) { job.status = 'paused'; this.journal.saveAlignmentJob(key, job); await new Promise(r => setTimeout(r, 250)); }
      if (controller.signal.aborted) break;
      job.status = 'running';
      const batch = job.items.slice(index, index + 20).flatMap(item => {
        const input = this.journal.alignmentSource(meeting, item.segment_id);
        if (!input || !this.journal.alignmentMatches(meeting, item) || alignmentHash(input.audio) !== item.audio_sha256) { item.state = 'stale'; item.reason = 'Transcript or source changed'; return []; }
        return [{ item, input }];
      });
      if (!batch.length) continue;
      const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      try {
        const form = new FormData();
        for (const { input } of batch) form.append('files', new Blob([new Uint8Array(input.audio)], { type: 'audio/wav' }), 'segment.wav');
        form.set('texts', JSON.stringify(batch.map(b => b.input.text)));
        const response = await fetch(this.config!.url.replace(/\/+$/, '') + '/align-batch', { method: 'POST', headers: { Authorization: `Bearer ${this.config!.token}` }, body: form, signal: controller.signal, redirect: 'error' });
        if (!response.ok || !response.body) throw new Error('Alignment worker failed');
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 8 * 1024 * 1024) throw new Error('Alignment response too large'); chunks.push(next.value); } }
        finally { await reader.cancel().catch(() => {}); }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(result.results) || result.results.length !== batch.length) throw new Error('Invalid alignment batch');
        // Validate the entire batch before publishing any result from this response.
        const clean = batch.map(({ input }, i) => validateAlignment(result.results[i], input.audio, input.text));
        if (controller.signal.aborted) break;
        for (let i = 0; i < batch.length; i++) {
          const { item, input } = batch[i]; Object.assign(item, clean[i]); job.model = item.model!;
          const current = this.journal.alignmentSource(meeting, item.segment_id);
          if (!current || !this.journal.alignmentMatches(meeting, item) || alignmentHash(current.audio) !== alignmentHash(input.audio)) { item.state = 'stale'; item.reason = 'Transcript or source changed while aligning'; continue; }
          if (!item.words?.some(w => w.aligned)) { item.state = 'skipped'; item.reason = 'No reliable word times; OOV stays unaligned'; continue; }
          try { this.journal.publishAlignment(meeting, job.id, { ...item, state: 'aligned' }); item.state = 'aligned'; }
          catch (error) { if (error instanceof RevisionConflict) { item.state = 'stale'; item.reason = 'Transcript or source changed'; } else throw error; }
        }
      } catch {
        if (!controller.signal.aborted) for (const { item } of batch) if (item.state === 'pending') { item.state = 'skipped'; item.reason = 'Alignment failed or returned invalid provenance'; }
      } finally { clearTimeout(timer); }
      this.journal.saveAlignmentJob(key, job);
    }
    job.status = controller.signal.aborted ? this.closing ? 'interrupted' : job.status === 'cancelled' ? 'cancelled' : 'failed'
      : job.items.some(i => i.state === 'aligned') ? 'completed' : 'failed';
    job.finished_at = new Date().toISOString(); this.journal.saveAlignmentJob(key, job);
  }
  cancel(key: string) { if (this.active?.key === key) { this.active.job.status = 'cancelled'; this.active.controller.abort(); this.journal.saveAlignmentJob(key, this.active.job); } return this.current(key); }
  async close() { this.closing = true; this.active?.controller.abort(); await this.task; }
}
