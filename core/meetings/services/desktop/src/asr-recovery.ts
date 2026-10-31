import { createHash } from 'node:crypto';
import { createGmeetPipeline, type TranscriptSegment } from '@tina/gmeet-pipeline';
import { TranscriptionClient } from '@tina/transcribe-whisper';
import { hallucinationRule } from '@tina/mixed-pipeline';
import type { Meeting } from './desktop.js';
import type { TranscriptJournal, AsrWindow } from './transcript-journal.js';
import type { TranscriptionConfig } from './transcription-settings.js';

/** Only the digest is persisted: never put provider tokens or capture API keys in SQLite. */
export const asrRoute = (config: TranscriptionConfig, subject: string): string => createHash('sha256')
  .update(JSON.stringify([subject, config.url, config.token, config.model, config.summary.backend])).digest('hex');

/** One recovery worker; live capture wins, and every committed window owns an exact sample range. */
export class AsrRecovery {
  private routes = new Map<string, TranscriptionConfig>();
  private task: Promise<void> | null = null;
  private closing = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private journal: TranscriptJournal, private isLive: () => boolean,
    private meeting: (key: string) => Meeting | undefined,
    private publish: (key: string, segments: TranscriptSegment[]) => void,
    private fault: (key: string, detail: string, kind?: string) => void) {
    this.timer = setInterval(() => this.kick(), 1000);
  }
  register(config: TranscriptionConfig, subject: string): string {
    const route = asrRoute(config, subject);
    if (config.url) {
      this.routes.set(route, config);
      if (this.routes.size > 32) this.routes.delete(this.routes.keys().next().value!);
    }
    return route;
  }
  kick(): void {
    if (this.closing || this.task || this.isLive()) return;
    this.task = this.run().catch(() => {
      // Journal or worker faults must never silently checkpoint the source audio.
      try { for (const session of this.journal.asrSessions()) this.fault(session.meeting, 'ASR recovery interrupted; audio remains queued.'); }
      catch { this.fault('', 'ASR recovery journal unavailable; source checkpoints were not advanced.'); }
    }).finally(() => { this.task = null; });
  }
  private async run(): Promise<void> {
    for (let count = 0; count < 64 && !this.closing && !this.isLive(); count++) {
      for (const session of this.journal.asrSessions()) {
        if (!this.routes.has(session.route)) {
          this.journal.asrSessionError(session.session, 'Pinned ASR settings unavailable; reconnect using the original API key and settings.');
          this.fault(session.meeting, 'ASR recovery is waiting for the original capture credentials/settings.');
          continue;
        }
        this.journal.asrSessionError(session.session, null);
        this.journal.planAsrWindow(session.session);
      }
      const job = this.journal.nextAsrWindow([...this.routes.keys()]);
      if (!job) return;
      this.journal.startAsrWindow(job.id);
      try {
        const segments = await this.decode(job, this.routes.get(job.route)!);
        if (this.closing || this.isLive()) { this.journal.retryAsrWindow(job); return; }
        const meeting = this.meeting(job.meeting);
        if (!meeting) throw new Error('Meeting missing');
        const next = { ...meeting, segments: [...meeting.segments] };
        for (const segment of segments) {
          const index = next.segments.findIndex(s => s.segment_id === segment.segment_id);
          if (index < 0) next.segments.push(segment); else next.segments[index] = segment;
        }
        if (this.journal.commitAsrWindow(job, next, segments)) {
          meeting.segments = next.segments;
          this.publish(job.meeting, segments);
        }
      } catch {
        this.journal.retryAsrWindow(job);
        this.fault(job.meeting, 'ASR recovery failed; source audio is retained for automatic retry.');
      }
    }
  }
  private async decode(job: AsrWindow, config: TranscriptionConfig): Promise<TranscriptSegment[]> {
    const { samples, missing } = this.journal.readSamples(job.meeting, job.session, job.source, job.start_sample, job.end_sample);
    if (!samples || missing.length) throw new Error('Recovery audio range unavailable');
    const client = new TranscriptionClient({ serviceUrl: config.url, apiToken: config.token, model: config.model,
      requestTimeoutMs: 15000, maxRetries: 0, sampleRate: 16000, maxSpeechDurationSec: 15 });
    const segments: TranscriptSegment[] = [];
    let failure: unknown;
    // A mixed source cannot prove a person's identity. Keep it unknown rather than guess from text.
    const platform = job.meeting.split('/')[0];
    const mixed = ['zoom', 'teams', 'msteams', 'youtube'].includes(platform);
    const name = job.source === 1000 ? 'You' : mixed ? undefined : job.speaker_name || undefined;
    const pipeline = createGmeetPipeline({
      sessionId: `recovery-${job.id}`, config: { minAudioDuration: .2, maxBufferDuration: 15, submitInterval: 15, callbackStampedFrames: true,
        hallucinationFilter: (text: string) => hallucinationRule(text) !== null },
      transcribe: async (pcm, prompt) => {
        const result = await client.transcribe(pcm, job.language === 'auto' ? undefined : job.language, prompt);
        if (result.language_review) {
          this.journal.saveLanguageReview(job.meeting, job.session, pcm, result.language_review);
          this.fault(job.meeting, 'Đoạn âm thanh cần kiểm tra ngôn ngữ. Mở Transcript review.', 'language_review');
        }
        return result;
      },
      sink: { segment: segment => segments.push({ ...segment, segment_id: `recovery-${job.id}:${segment.segment_id}`,
        speaker_key: `ch-${job.source}:recovery-${job.id}`, ...(name ? {} : { speaker: '', source: 'provisional-cluster-id' as const, confidence: 0 }) }), finalize() {} },
      onError: error => { failure = error; },
    });
    try { pipeline.feedAudio(job.source, name, samples, job.start_ms, undefined, job.start_sample); }
    finally { await pipeline.dispose(); }
    if (failure) throw failure;
    return segments;
  }
  async close(): Promise<void> { this.closing = true; clearInterval(this.timer); await this.task; }
}
