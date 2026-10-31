import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { TranscriptionResult } from '@tina/transcribe-whisper';
import { chmodSync } from 'node:fs';
import { fingerprint, snapshotBase } from './foundation.js';
import type { Meeting } from './desktop.js';
import type { TranscriptSegment } from '@tina/gmeet-pipeline';
import type { RefinementJob, RefinementItem } from './refinement.js';
import { AEC_RAW_MIC_CHANNEL } from '@tina/capture-codec';
import { isArchiveOnlyCaptureSource } from './audio-routing.js';
import { emptySpeakers, observeSpeakers, renameSpeaker, assignSpeaker, registerSpeaker, recordSpeaker, speakerFor, sourceChannel,
  type SpeakerState, type SpeakerEntry } from './speaker-registry.js';
import { conversationMemory, type CanonicalTranscript, type CanonicalSegment } from './meeting-memory.js';
import type { DiarizationJob } from './speaker-diarization.js';
import { alignmentHash, projectAlignment, type AlignmentJob, type AlignmentItem, type AlignmentResult, type CaptureReference } from './alignment-model.js';

// node:sqlite ships with the required Node >=22.13; Node 20 type declarations omit it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
export const normalizeTranscript = (text: string): string => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
export class RevisionConflict extends Error {}
export interface AsrWindow {
  id: string; session: string; meeting: string; route: string; language: string;
  source: number; start_sample: number; end_sample: number; start_ms: number;
  speaker_name: string | null; attempts: number;
}
export interface TranscriptRevisionEvent {
  version: 'transcript-revision.v1'; type: 'transcript.revised'; event_id: string; meeting_id: number;
  platform: string; native_meeting_id: string; segment_id: string; revision: number;
  kind: 'manual' | 'restore' | 'refinement' | 'alignment'; at: string;
}
export interface SpeakerRevisionEvent {
  version: 'speaker-revision.v1'; type: 'speaker.revised'; event_id: string; meeting_id: number;
  platform: string; native_meeting_id: string; speaker_id: string; revision: number; kind: 'speaker'; at: string;
}

/** Local durable carrier. PCM is appended once per captured frame, never once per ASR retry. */
export class TranscriptJournal {
  private db: any;
  private appendAudio: any;
  private bytes = new Map<string, number>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meetings (key TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS foundation_versions (meeting TEXT PRIMARY KEY, sequence INTEGER NOT NULL, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_records (
        meeting TEXT NOT NULL, segment TEXT NOT NULL, raw TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(meeting,segment));
      CREATE TABLE IF NOT EXISTS audio_chunks (
        id TEXT PRIMARY KEY, meeting TEXT NOT NULL, session TEXT NOT NULL, channel INTEGER NOT NULL,
        start_ms REAL NOT NULL, end_ms REAL NOT NULL, pcm BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS audio_timeline ON audio_chunks(meeting,start_ms,end_ms);
      CREATE TABLE IF NOT EXISTS audio_capture_sessions (
        meeting TEXT NOT NULL, client_session TEXT NOT NULL, session TEXT NOT NULL UNIQUE,
        PRIMARY KEY(meeting,client_session));
      CREATE TABLE IF NOT EXISTS asr_sessions(session TEXT PRIMARY KEY,meeting TEXT NOT NULL,route TEXT NOT NULL,language TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS asr_coverage(session TEXT NOT NULL,source INTEGER NOT NULL,start_sample INTEGER NOT NULL,end_sample INTEGER NOT NULL,PRIMARY KEY(session,source,start_sample));
      CREATE TABLE IF NOT EXISTS asr_windows(id TEXT PRIMARY KEY,session TEXT NOT NULL,source INTEGER NOT NULL,start_sample INTEGER NOT NULL,end_sample INTEGER NOT NULL,start_ms REAL NOT NULL,speaker_name TEXT,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE INDEX IF NOT EXISTS asr_window_session ON asr_windows(session,source,start_sample);
      CREATE TABLE IF NOT EXISTS refinement_jobs (id TEXT PRIMARY KEY, meeting TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS refinement_meeting ON refinement_jobs(meeting);
      CREATE TABLE IF NOT EXISTS asr_language_reviews (id TEXT PRIMARY KEY, meeting TEXT NOT NULL, document TEXT NOT NULL, pcm BLOB NOT NULL, UNIQUE(meeting,id));
      CREATE TABLE IF NOT EXISTS transcript_outbox(id TEXT PRIMARY KEY, meeting TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS speaker_registries(meeting TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diarization_jobs(meeting TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS canonical_projections(meeting TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alignment_jobs(meeting TEXT PRIMARY KEY,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alignment_results(meeting TEXT NOT NULL,segment TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(meeting,segment));
      CREATE TABLE IF NOT EXISTS transcript_sequences(meeting TEXT NOT NULL,segment TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(meeting,segment));
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search USING fts5(meeting UNINDEXED, segment UNINDEXED, text, tokenize='unicode61 remove_diacritics 0');`);
    const columns=new Set(this.db.prepare('PRAGMA table_info(audio_chunks)').all().map((row:any)=>row.name));
    for(const [name,type] of [['start_sample','INTEGER'],['end_sample','INTEGER'],['source_capture_ms','REAL'],['clock_quality','TEXT'],['speaker_name','TEXT']])
      if(!columns.has(name))this.db.exec(`ALTER TABLE audio_chunks ADD COLUMN ${name} ${type}`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS audio_sample_range ON audio_chunks(meeting,session,channel,start_sample,end_sample);
      CREATE TABLE IF NOT EXISTS audio_timeline_events(id INTEGER PRIMARY KEY,meeting TEXT NOT NULL,session TEXT NOT NULL,source TEXT NOT NULL,kind TEXT NOT NULL,start_sample INTEGER NOT NULL,end_sample INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS audio_timeline_event_session ON audio_timeline_events(meeting,session,id);`);
    // Rebuild only the derived text index at startup; PCM is never read or rewritten.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM transcript_search');
      for (const meeting of this.load()) for (const segment of meeting.segments)
        this.index(`${meeting.platform}/${meeting.native_meeting_id}`, segment.segment_id, this.current(`${meeting.platform}/${meeting.native_meeting_id}`, segment).text);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.appendAudio = this.db.prepare('INSERT INTO audio_chunks(id,meeting,session,channel,start_ms,end_ms,pcm,start_sample,end_sample,source_capture_ms,clock_quality,speaker_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    this.db.prepare('INSERT OR IGNORE INTO journal_metadata VALUES (?,?)').run('instance_id', randomUUID());
    this.db.exec("UPDATE asr_windows SET state='retry',next_attempt_ms=0,error='Desktop restarted during ASR' WHERE state='running'");
    for (const row of this.db.prepare('SELECT document FROM refinement_jobs').all()) {
      const job: RefinementJob = JSON.parse(row.document);
      if (['running', 'paused', 'cancelling'].includes(job.status)) {
        job.status = 'interrupted'; job.error = 'Desktop restarted; start a new refinement to retry unfinished segments.';
        this.saveRefinement(job);
      }
    }
  }
  load(): Meeting[] {
    return this.db.prepare('SELECT document FROM meetings').all().map((r: any) => {
      const meeting = JSON.parse(r.document);
      if (meeting.status === 'active') meeting.status = 'interrupted';
      return meeting;
    });
  }
  save(meeting: Meeting, segment?: TranscriptSegment, captureSession?: string): void {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    const initial = !this.db.prepare('SELECT 1 FROM meetings WHERE key=?').get(key);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO meetings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document')
        .run(key, JSON.stringify(meeting));
      for (const s of initial ? meeting.segments : segment ? [segment] : []) {
        this.db.prepare('INSERT OR IGNORE INTO transcript_records(meeting,segment,raw) VALUES (?,?,?)')
          .run(key, s.segment_id, s.text);
        this.index(key, s.segment_id, this.current(key, s).text);
      }
      if (segment && captureSession && this.db.prepare('SELECT 1 FROM asr_sessions WHERE session=?').get(captureSession)) {
        const source = Number(segment.speaker_key?.match(/^ch-(\d+):/)?.[1]);
        const origin = Number.isSafeInteger(source) ? this.db.prepare('SELECT start_ms,start_sample FROM audio_chunks WHERE session=? AND channel=? AND start_sample IS NOT NULL ORDER BY start_sample LIMIT 1').get(captureSession, source) : null;
        if (origin && Number.isFinite(segment.start) && segment.end > segment.start) {
          const start = Math.max(0, origin.start_sample + Math.round((segment.start * 1000 - origin.start_ms) * 16));
          const end = origin.start_sample + Math.round((segment.end * 1000 - origin.start_ms) * 16);
          if (end > start) this.coverAsr(captureSession, source, start, end);
        }
      }
      this.observeSpeakerSegments(meeting, segment ? [segment] : undefined, captureSession);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  capture(key: string, session: string, channel: number, startMs:number,pcm:Float32Array,startSample?:number,sourceCaptureMs?:number,clock?:'samples'|'legacy',speakerName?:string):void {
    if (!Number.isSafeInteger(channel) || channel < 0 || !Number.isFinite(startMs) || pcm.length === 0
        || pcm.length > 16000 * 90 || pcm.some(v => !Number.isFinite(v))) throw new Error('Invalid archive audio frame');
    if(startSample!==undefined && (!Number.isSafeInteger(startSample)||startSample<0||!Number.isSafeInteger(startSample+pcm.length)))throw new Error('Invalid archive sample index');
    if(sourceCaptureMs!==undefined&&!Number.isFinite(sourceCaptureMs))throw new Error('Invalid source clock');
    const size = (this.bytes.get(session) ?? this.db.prepare('SELECT COALESCE(SUM(length(pcm)),0) AS size FROM audio_chunks WHERE session=?').get(session).size) + pcm.byteLength;
    // Bound disk growth per capture session; the caller surfaces a visible archive fault at the cap.
    if (size > 2 * 1024 ** 3) throw new Error('Audio archive reached the 2 GiB session limit');
    const bytes = Buffer.allocUnsafe(pcm.byteLength);
    for (let i = 0; i < pcm.length; i++) bytes.writeFloatLE(pcm[i], i * 4);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.appendAudio.run(randomUUID(), key, session, channel, startMs, startMs+pcm.length/16,bytes,startSample??null,startSample===undefined?null:startSample+pcm.length,sourceCaptureMs??null,clock??null,speakerName?.slice(0,512) || null);
      // A late frame accepted during Stop must remain recoverable even if the previous tail settled.
      this.db.prepare("UPDATE asr_sessions SET state='pending' WHERE session=? AND state='completed'").run(session);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.bytes.set(session, size);
  }
  captureSession(key: string, clientSession: string): string {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(clientSession)) throw new Error('Invalid client capture session');
    this.db.prepare('INSERT OR IGNORE INTO audio_capture_sessions VALUES (?,?,?)').run(key, clientSession, randomUUID());
    return this.db.prepare('SELECT session FROM audio_capture_sessions WHERE meeting=? AND client_session=?').get(key, clientSession).session;
  }
  receivePcm(key: string, session: string, source: number, start: number, captureMs: number, pcm: Float32Array, speakerName?: string): { duplicate: boolean; captureMs: number } {
    const end = start + pcm.length;
    if (!Number.isSafeInteger(source) || source < 0 || source >= 0x40000000 || !Number.isSafeInteger(start) || start < 0
        || !Number.isSafeInteger(end) || end <= start || pcm.length > 16000 * 30 || !Number.isFinite(captureMs) || pcm.some(v => !Number.isFinite(v))) throw new Error('Invalid acknowledged PCM frame');
    const bytes = Buffer.allocUnsafe(pcm.byteLength);
    for (let i = 0; i < pcm.length; i++) bytes.writeFloatLE(pcm[i], i * 4);
    const previous = this.db.prepare('SELECT pcm,start_ms,source_capture_ms FROM audio_chunks WHERE meeting=? AND session=? AND channel=? AND start_sample=? AND end_sample=?').get(key, session, source, start, end);
    if (previous) {
      if (!Buffer.from(previous.pcm).equals(bytes) || previous.source_capture_ms !== captureMs) throw new Error('PCM replay changed an existing sample range');
      return { duplicate: true, captureMs: previous.start_ms };
    }
    // Accepted ranges never overlap, so only the nearest predecessor can intersect this range.
    const predecessor = this.db.prepare('SELECT end_sample FROM audio_chunks WHERE meeting=? AND session=? AND channel=? AND start_sample<? ORDER BY start_sample DESC LIMIT 1').get(key, session, source, end);
    if (predecessor?.end_sample > start) throw new Error('Overlapping PCM replay range');
    const first = this.db.prepare('SELECT start_ms,start_sample FROM audio_chunks WHERE meeting=? AND session=? AND channel=? ORDER BY start_sample LIMIT 1').get(key, session, source);
    const canonicalMs = first ? first.start_ms + (start - first.start_sample) / 16 : captureMs;
    // One SQLite FULL-synchronous insert is the receipt; ACK never precedes this write.
    this.capture(key, session, source, canonicalMs, pcm, start, captureMs, 'samples', speakerName);
    return { duplicate: false, captureMs: canonicalMs };
  }
  registerAsrSession(meeting: string, session: string, route: string, language: string): boolean {
    const previous = this.db.prepare('SELECT meeting,route,language FROM asr_sessions WHERE session=?').get(session);
    // Historical PCM has no trustworthy pinned backend; a reconnect must not retroactively assign one.
    if (!previous && this.db.prepare('SELECT 1 FROM audio_chunks WHERE session=? LIMIT 1').get(session)) return false;
    if (previous && (previous.meeting !== meeting || previous.route !== route || previous.language !== language)) throw new Error('Capture ASR settings changed; restore the original settings before reconnecting');
    this.db.prepare("INSERT INTO asr_sessions(session,meeting,route,language) VALUES (?,?,?,?) ON CONFLICT(session) DO UPDATE SET state='pending',error=NULL").run(session, meeting, route, language);
    return !previous;
  }
  private coverAsr(session: string, source: number, start: number, end: number): void {
    const overlaps = this.db.prepare('SELECT start_sample,end_sample FROM asr_coverage WHERE session=? AND source=? AND start_sample<=? AND end_sample>=?').all(session, source, end, start);
    for (const row of overlaps) { start = Math.min(start, row.start_sample); end = Math.max(end, row.end_sample); }
    this.db.prepare('DELETE FROM asr_coverage WHERE session=? AND source=? AND start_sample<=? AND end_sample>=?').run(session, source, end, start);
    this.db.prepare('INSERT INTO asr_coverage VALUES (?,?,?,?)').run(session, source, start, end);
  }
  finishAsrCapture(session: string): void {
    // Capture receipt is not ASR coverage; only processed ranges may close the recovery session.
    this.planAsrWindow(session);
  }
  asrSessions(): Array<{session: string; meeting: string; route: string}> {
    return this.db.prepare("SELECT session,meeting,route FROM asr_sessions WHERE state!='completed' ORDER BY rowid LIMIT 128").all();
  }
  /** Plan at most one bounded window per call, never bridge a sample gap or captured name change. */
  planAsrWindow(session: string): boolean {
    this.db.prepare("UPDATE asr_windows SET state='superseded',error=NULL WHERE session=? AND source=? AND state IN ('queued','running','retry')").run(session, AEC_RAW_MIC_CHANNEL);
    const sources = this.db.prepare('SELECT channel,MIN(start_sample) AS first FROM audio_chunks WHERE session=? AND start_sample IS NOT NULL GROUP BY channel').all(session);
    for (const {channel: source, first} of sources) {
      if (isArchiveOnlyCaptureSource(source)) continue;
      const covered = this.db.prepare("SELECT start_sample,end_sample FROM asr_coverage WHERE session=? AND source=? UNION ALL SELECT start_sample,end_sample FROM asr_windows WHERE session=? AND source=? AND state IN ('queued','running','retry') ORDER BY start_sample,end_sample").all(session, source, session, source);
      let cursor = first;
      for (;;) {
        for (const range of covered) if (range.start_sample <= cursor && range.end_sample > cursor) cursor = range.end_sample;
        let chunk = this.db.prepare('SELECT start_sample,end_sample,start_ms,speaker_name FROM audio_chunks WHERE session=? AND channel=? AND start_sample<=? ORDER BY start_sample DESC LIMIT 1').get(session, source, cursor);
        if (!chunk || chunk.end_sample <= cursor) chunk = this.db.prepare('SELECT start_sample,end_sample,start_ms,speaker_name FROM audio_chunks WHERE session=? AND channel=? AND start_sample>=? ORDER BY start_sample LIMIT 1').get(session, source, cursor);
        if (!chunk) break;
        if (chunk.start_sample > cursor) { cursor = chunk.start_sample; continue; }
        const barrier = covered.find((range: any) => range.end_sample > cursor);
        if (barrier?.start_sample <= cursor) continue;
        const limit = Math.min(cursor + 16000 * 15, barrier?.start_sample ?? Infinity);
        let end = Math.min(chunk.end_sample, limit);
        for (const next of this.db.prepare('SELECT start_sample,end_sample,speaker_name FROM audio_chunks WHERE session=? AND channel=? AND start_sample>? AND start_sample<? ORDER BY start_sample').iterate(session, source, chunk.start_sample, limit)) {
          if (next.start_sample !== end || next.speaker_name !== chunk.speaker_name) break;
          end = Math.min(next.end_sample, limit);
        }
        const id = createHash('sha256').update(`${session}:${source}:${cursor}:${end}`).digest('hex');
        this.db.prepare('INSERT OR IGNORE INTO asr_windows(id,session,source,start_sample,end_sample,start_ms,speaker_name) VALUES (?,?,?,?,?,?,?)').run(id, session, source, cursor, end, chunk.start_ms + (cursor - chunk.start_sample) / 16, chunk.speaker_name);
        return true;
      }
    }
    if (!this.db.prepare("SELECT 1 FROM asr_windows WHERE session=? AND state IN ('queued','running','retry') LIMIT 1").get(session)) this.db.prepare("UPDATE asr_sessions SET state='completed',error=NULL WHERE session=?").run(session);
    return false;
  }
  nextAsrWindow(routes: string[]): AsrWindow | null {
    if (!routes.length) return null;
    return this.db.prepare(`SELECT w.*,s.meeting,s.route,s.language FROM asr_windows w JOIN asr_sessions s ON s.session=w.session WHERE w.state IN ('queued','retry') AND w.source!=? AND w.next_attempt_ms<=? AND s.route IN (${routes.map(() => '?').join(',')}) ORDER BY w.rowid LIMIT 1`).get(AEC_RAW_MIC_CHANNEL, Date.now(), ...routes) ?? null;
  }
  asrSessionError(session: string, error: string | null): void {
    this.db.prepare("UPDATE asr_sessions SET state=?,error=? WHERE session=?").run(error ? 'blocked' : 'pending', error, session);
  }
  startAsrWindow(id: string): void { this.db.prepare("UPDATE asr_windows SET state='running',attempts=attempts+1,error=NULL WHERE id=? AND state IN ('queued','retry')").run(id); }
  retryAsrWindow(job: AsrWindow): void {
    this.db.prepare("UPDATE asr_windows SET state='retry',next_attempt_ms=?,error='ASR failed; audio retained for retry' WHERE id=? AND state!='completed'").run(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)), job.id);
  }
  commitAsrWindow(job: AsrWindow, meeting: Meeting, segments: TranscriptSegment[]): boolean {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    if (key !== job.meeting) throw new Error('ASR meeting mismatch');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.db.prepare('SELECT state FROM asr_windows WHERE id=?').get(job.id)?.state;
      if (state !== 'running') { this.db.exec('ROLLBACK'); return false; }
      // Live capture may have finalized this audio while the recovery HTTP call was in flight.
      if (this.db.prepare('SELECT 1 FROM asr_coverage WHERE session=? AND source=? AND start_sample<? AND end_sample>? LIMIT 1').get(job.session, job.source, job.end_sample, job.start_sample)) {
        this.db.prepare("UPDATE asr_windows SET state='superseded' WHERE id=?").run(job.id);
        this.db.exec('COMMIT'); return false;
      }
      if (this.db.prepare('UPDATE meetings SET document=? WHERE key=?').run(JSON.stringify(meeting), key).changes !== 1) throw new Error('ASR meeting not found');
      for (const segment of segments) {
        this.db.prepare("INSERT INTO transcript_records(meeting,segment,raw) VALUES (?,?,?) ON CONFLICT(meeting,segment) DO NOTHING").run(key, segment.segment_id, segment.text);
        this.index(key, segment.segment_id, this.current(key, segment).text);
      }
      this.observeSpeakerSegments(meeting, segments, job.session);
      this.coverAsr(job.session, job.source, job.start_sample, job.end_sample);
      this.db.prepare("UPDATE asr_windows SET state='completed',error=NULL WHERE id=?").run(job.id);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  asrStatus(meeting: string): object {
    return { version: 'asr-recovery.v1', sessions: this.db.prepare('SELECT session,state,error FROM asr_sessions WHERE meeting=?').all(meeting),
      windows: this.db.prepare('SELECT w.id,w.session,w.source,w.start_sample,w.end_sample,w.state,w.attempts,w.error FROM asr_windows w JOIN asr_sessions s ON s.session=w.session WHERE s.meeting=? ORDER BY w.rowid DESC LIMIT 100').all(meeting),
      checkpoints: this.db.prepare('SELECT c.session,c.source,c.start_sample,c.end_sample FROM asr_coverage c JOIN asr_sessions s ON s.session=c.session WHERE s.meeting=? ORDER BY c.session,c.source,c.start_sample').all(meeting) };
  }
  timelineEvent(key:string,event:{session:string;source:string;kind:string;startSample:number;endSample:number}):void {
    this.db.prepare('INSERT INTO audio_timeline_events(meeting,session,source,kind,start_sample,end_sample) VALUES (?,?,?,?,?,?)')
      .run(key,event.session,event.source,event.kind,event.startSample,event.endSample);
    this.db.prepare('DELETE FROM audio_timeline_events WHERE meeting=? AND session=? AND id NOT IN (SELECT id FROM audio_timeline_events WHERE meeting=? AND session=? ORDER BY id DESC LIMIT 512)')
      .run(key,event.session,key,event.session);
  }
  timeline(key:string):object {
    return {sources:this.db.prepare(`SELECT session,channel AS source,MIN(start_sample) AS start_sample,MAX(end_sample) AS end_sample,
      MIN(start_ms) AS start_ms,MAX(end_ms) AS end_ms,SUM(LENGTH(pcm)) AS stored_bytes,
      CASE WHEN SUM(clock_quality='samples')=COUNT(*) THEN 'samples' ELSE 'legacy-or-unknown' END AS clock_quality FROM audio_chunks WHERE meeting=? GROUP BY session,channel`).all(key),
      events:this.db.prepare('SELECT session,source,kind,start_sample,end_sample FROM audio_timeline_events WHERE meeting=? ORDER BY id DESC LIMIT 512').all(key)};
  }
  storageMetrics(key: string): object {
    return { ...this.db.prepare('SELECT COUNT(*) AS audio_chunks,COALESCE(SUM(LENGTH(pcm)),0) AS pcm_bytes FROM audio_chunks WHERE meeting=?').get(key),
      transcript_records: this.db.prepare('SELECT COUNT(*) AS n FROM transcript_records WHERE meeting=?').get(key).n,
      recovery: this.db.prepare('SELECT w.state,COUNT(*) AS count FROM asr_windows w JOIN asr_sessions s ON s.session=w.session WHERE s.meeting=? GROUP BY w.state').all(key) };
  }
  readSamples(key:string,session:string,source:number,start:number,end:number):{samples:Float32Array|null;missing:Array<{startSample:number;endSample:number}>} {
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>16000*90)throw new Error('Invalid archive read range');
    const rows=this.db.prepare(`SELECT start_sample,end_sample,pcm FROM audio_chunks WHERE meeting=? AND session=? AND channel=? AND end_sample>? AND start_sample<? ORDER BY start_sample,rowid`).all(key,session,source,start,end);
    const samples=new Float32Array(end-start),present=new Uint8Array(end-start);
    for(const row of rows) {
      const bytes=Buffer.from(row.pcm),from=Math.max(start,row.start_sample),to=Math.min(end,row.end_sample);
      for(let i=from;i<to;i++) {samples[i-start]=bytes.readFloatLE((i-row.start_sample)*4);present[i-start]=1;}
    }
    const missing:Array<{startSample:number;endSample:number}>=[];
    let open:number|null=null;
    for(let i=0;i<present.length;i++) {
      if(!present[i]&&open===null)open=start+i;
      if(present[i]&&open!==null){missing.push({startSample:open,endSample:start+i});open=null;}
    }
    if(open!==null)missing.push({startSample:open,endSample:end});
    return {samples:missing.length?null:samples,missing};
  }
  encodeSamples(samples:Float32Array):Buffer {
    const bytes=Buffer.allocUnsafe(samples.byteLength);
    for(let i=0;i<samples.length;i++)bytes.writeFloatLE(samples[i],i*4);
    return this.wav(bytes);
  }
  private current(key: string, segment: TranscriptSegment): { text: string; revision: number } {
    const row = this.db.prepare('SELECT history FROM transcript_records WHERE meeting=? AND segment=?').get(key, segment.segment_id);
    const history = JSON.parse(row?.history ?? '[]');
    return { text: history.at(-1)?.text ?? segment.text, revision: history.length };
  }
  private index(key: string, segmentId: string, text: string): void {
    this.db.prepare('DELETE FROM transcript_search WHERE meeting=? AND segment=?').run(key, segmentId);
    this.db.prepare('INSERT INTO transcript_search(meeting,segment,text) VALUES (?,?,?)').run(key, segmentId, text);
  }
  search(query: string, keys: string[], limit = 20, offset = 0): Array<{ meeting: string; segment: string; text: string; rank: number }> {
    const terms = query.normalize('NFC').match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length || !keys.length) return [];
    return this.db.prepare(`SELECT meeting,segment,text,-bm25(transcript_search) AS rank FROM transcript_search
      WHERE transcript_search MATCH ? AND meeting IN (SELECT value FROM json_each(?)) ORDER BY bm25(transcript_search),rowid LIMIT ? OFFSET ?`)
      .all(terms.map(t => '"' + t + '"').join(' AND '), JSON.stringify(keys), limit, offset);
  }
  speakerState(key: string): SpeakerState {
    const row = this.db.prepare('SELECT document FROM speaker_registries WHERE meeting=?').get(key);
    if (!row) return emptySpeakers();
    const state: SpeakerState = JSON.parse(row.document);
    return { ...state, speakers: Object.assign(Object.create(null), state.speakers), bindings: Object.assign(Object.create(null), state.bindings), segments: Object.assign(Object.create(null), state.segments) };
  }
  private storeSpeakers(key: string, state: SpeakerState): void {
    this.db.prepare('INSERT INTO speaker_registries VALUES (?,?) ON CONFLICT(meeting) DO UPDATE SET document=excluded.document').run(key, JSON.stringify(state));
  }
  private observeSpeakerSegments(meeting: Meeting, segments?: TranscriptSegment[], session?: string): void {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    if (!segments && this.db.prepare('SELECT 1 FROM speaker_registries WHERE meeting=?').get(key)) return;
    const state = this.speakerState(key);
    observeSpeakers(state, meeting, segments ?? meeting.segments, session);
    this.storeSpeakers(key, state);
  }
  speakers(meeting: Meeting): object {
    const state = this.speakerState(`${meeting.platform}/${meeting.native_meeting_id}`);
    const counts = new Map<string, number>();
    for (const binding of Object.values(state.segments)) counts.set(binding.speaker_id, (counts.get(binding.speaker_id) ?? 0) + 1);
    return { version: 'speaker-registry.v1', meeting_id: meeting.id, revision: state.revision,
      speakers: Object.values(state.speakers).filter(entry => counts.has(entry.speaker_id) || entry.manual && entry.name !== null)
        .map(entry => ({ ...entry, segment_count: counts.get(entry.speaker_id) ?? 0 })),
      segments: Object.fromEntries(Object.entries(state.segments).map(([id, binding]) => [id, { speaker_id: binding.speaker_id, manual: binding.manual }])) };
  }
  private changeSpeakers(meeting: Meeting, change: (state: SpeakerState) => SpeakerEntry[]): void {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.speakerState(key), entries = change(state);
      this.storeSpeakers(key, state);
      for (const entry of entries) {
        const event: SpeakerRevisionEvent = { version: 'speaker-revision.v1', type: 'speaker.revised', event_id: randomUUID(),
          meeting_id: meeting.id, platform: meeting.platform, native_meeting_id: meeting.native_meeting_id,
          speaker_id: entry.speaker_id, revision: entry.revision, kind: 'speaker', at: new Date().toISOString() };
        this.db.prepare('INSERT INTO transcript_outbox VALUES (?,?,?)').run(event.event_id, key, JSON.stringify(event));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  renameSpeaker(meeting: Meeting, id: string, expected: number, name: unknown): void {
    this.changeSpeakers(meeting, state => {
      if (state.speakers[id]?.revision !== expected) throw new RevisionConflict('Speaker changed; reload before saving');
      return [renameSpeaker(state, id, expected, name)];
    });
  }
  assignSpeaker(meeting: Meeting, segmentId: string, expected: number, speakerId: string | null): void {
    this.changeSpeakers(meeting, state => {
      if (state.revision !== expected) throw new RevisionConflict('Speaker assignments changed; reload before saving');
      return [assignSpeaker(state, `${meeting.platform}/${meeting.native_meeting_id}`, segmentId, expected, speakerId)];
    });
  }
  diarization(key: string): DiarizationJob | null {
    const row = this.db.prepare('SELECT document FROM diarization_jobs WHERE meeting=?').get(key);
    return row ? JSON.parse(row.document) : null;
  }
  saveDiarization(job: DiarizationJob): void {
    this.db.prepare('INSERT INTO diarization_jobs VALUES (?,?) ON CONFLICT(meeting) DO UPDATE SET document=excluded.document').run(job.meeting, JSON.stringify(job));
  }
  speakerSourceSpans(key: string): Array<{ session: string; start_sample: number; end_sample: number; start_ms: number }> {
    const spans: Array<{ session: string; start_sample: number; end_sample: number; start_ms: number }> = [];
    for (const row of this.db.prepare("SELECT session,start_sample,end_sample,start_ms FROM audio_chunks WHERE meeting=? AND channel=999 AND clock_quality='samples' ORDER BY session,start_sample").iterate(key)) {
      const last = spans.at(-1);
      if (last && last.session === row.session && last.end_sample > row.start_sample) throw new RangeError('System audio has overlapping sample ranges');
      if (last && last.session === row.session && last.end_sample === row.start_sample && Math.abs(last.start_ms + (row.start_sample - last.start_sample) / 16 - row.start_ms) < 1) last.end_sample = row.end_sample;
      else spans.push({ session: row.session, start_sample: row.start_sample, end_sample: row.end_sample, start_ms: row.start_ms });
      if (spans.length > 256 || spans.reduce((n, span) => n + span.end_sample - span.start_sample, 0) > 16000 * 1800) throw new RangeError('Speaker analysis supports up to 30 minutes and 256 continuous ranges');
    }
    return spans.sort((a, b) => a.start_ms - b.start_ms);
  }
  applyDiarization(meeting: Meeting, job: DiarizationJob): void {
    this.changeSpeakers(meeting, state => {
      const saved = this.diarization(job.meeting);
      if (!saved || saved.id !== job.id || saved.status !== 'completed') throw new RevisionConflict('Speaker analysis changed');
      if (saved.applied_at) return [];
      if (state.revision !== job.registry_revision) throw new RevisionConflict('Speaker mapping changed; run analysis again');
      const changed = new Map<string, SpeakerEntry>();
      const analysisIdentity = fingerprint({ audio: job.audio_sha256, model: job.model, num_speakers: job.num_speakers, turns: job.turns });
      for (const item of job.items) {
        const segment = meeting.segments.find(s => s.segment_id === item.segment_id);
        if (!segment || this.current(job.meeting, segment).revision !== item.expected_revision
            || segment.start * 1000 !== item.start_ms || segment.end * 1000 !== item.end_ms) throw new RevisionConflict('Transcript changed; run speaker analysis again');
        const binding = state.segments[item.segment_id], old = binding && state.speakers[binding.speaker_id];
        if (item.cluster === null || !binding || binding.manual || old?.manual || old?.source === 'local_mic' || old?.source === 'meet_dom') continue;
        const identity = `diarization:${analysisIdentity}:${item.cluster}`;
        const existed = Boolean(state.bindings[identity]);
        const entry = registerSpeaker(state, job.meeting, identity, 'diarization');
        if (binding.speaker_id === entry.speaker_id) continue;
        if (existed && !changed.has(entry.speaker_id)) recordSpeaker(entry, entry.name, 'diarization', entry.status);
        state.revision++;
        state.segments[item.segment_id] = { speaker_id: entry.speaker_id, revision: state.revision, manual: false, raw_speaker: binding.raw_speaker };
        changed.set(entry.speaker_id, entry);
      }
      this.saveDiarization({ ...job, applied_at: new Date().toISOString() });
      return [...changed.values()];
    });
  }
  canonical(meeting: Meeting): CanonicalTranscript {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`, document = this.document(meeting) as { segments: any[] };
    if (document.segments.length > 2000 || document.segments.reduce((n, s) => n + s.text.length, 0) > 500000) throw new RangeError('Canonical transcript limit reached');
    const state = this.speakerState(key);
    const segments: CanonicalSegment[] = document.segments.filter(s => {
      const segment = meeting.segments.find(raw => raw.segment_id === s.segment_id);
      return segment?.completed === true && !isArchiveOnlyCaptureSource(sourceChannel(segment) ?? -1);
    }).map((s): CanonicalSegment => {
      const aligned = this.acceptedAlignment(meeting, s.segment_id);
      const attributed = aligned ? projectAlignment(key, aligned, state, this.diarization(key)) : { words: [], phrases: [] };
      return { segment_id: s.segment_id, start_ms: s.start_ms, end_ms: s.end_ms, raw_text: s.raw_text, text: s.text, revision: s.revision, audio: s.audio,
        ...speakerFor(state, s.segment_id),
        words: attributed.words.map(w => ({ ...w, start_ms: w.start_ms === null ? null : s.start_ms + w.start_ms, end_ms: w.end_ms === null ? null : s.start_ms + w.end_ms })),
        phrases: attributed.phrases.map(p => ({ ...p, start_ms: s.start_ms + p.start_ms, end_ms: s.start_ms + p.end_ms })),
        alignment: aligned ? { status: 'aligned', job_id: aligned.job_id, model: aligned.model!, audio_sha256: aligned.audio_sha256!, text_sha256: aligned.text_sha256 }
          : { status: 'segment_fallback', job_id: null, model: null, audio_sha256: null, text_sha256: null } };
    })
      .sort((a, b) => a.start_ms - b.start_ms || a.segment_id.localeCompare(b.segment_id));
    const source_revision = fingerprint(segments);
    const row = this.db.prepare('SELECT document FROM canonical_projections WHERE meeting=?').get(key);
    const previous: CanonicalTranscript | null = row ? JSON.parse(row.document) : null;
    if (previous?.source_revision === source_revision) return previous;
    const result: CanonicalTranscript = { version: 'canonical-transcript.v1', meeting_id: meeting.id, revision: (previous?.revision ?? 0) + 1,
      source_revision, updated_at: new Date().toISOString(), segments };
    this.db.prepare('INSERT INTO canonical_projections VALUES (?,?) ON CONFLICT(meeting) DO UPDATE SET document=excluded.document').run(key, JSON.stringify(result));
    return result;
  }
  memory(meeting: Meeting): object { return conversationMemory(this.canonical(meeting)); }
  alignmentJob(key: string): AlignmentJob | null {
    const row = this.db.prepare('SELECT document FROM alignment_jobs WHERE meeting=?').get(key);
    return row ? JSON.parse(row.document) : null;
  }
  saveAlignmentJob(key: string, job: AlignmentJob): void {
    this.db.prepare('INSERT INTO alignment_jobs VALUES (?,?) ON CONFLICT(meeting) DO UPDATE SET document=excluded.document').run(key, JSON.stringify(job));
  }
  private alignmentCapture(key: string, segment: TranscriptSegment): CaptureReference | null {
    const channel = sourceChannel(segment), duration = (segment.end - segment.start) * 1000;
    if (!segment.completed || channel === undefined || isArchiveOnlyCaptureSource(channel) || !Number.isFinite(duration) || duration <= 0 || duration > 30000) return null;
    const rows = this.db.prepare(`SELECT session,start_ms,start_sample,end_sample,clock_quality FROM audio_chunks
      WHERE meeting=? AND channel=? AND end_ms>? AND start_ms<? ORDER BY start_ms,rowid`).all(key, channel, segment.start * 1000, segment.end * 1000);
    if (!rows.length || new Set(rows.map((r: any) => r.session)).size !== 1 || rows.some((r: any) => r.clock_quality !== 'samples' || !Number.isSafeInteger(r.start_sample))) return null;
    const anchor = rows[0], start = Math.round(anchor.start_sample + (segment.start * 1000 - anchor.start_ms) * 16), end = Math.round(anchor.start_sample + (segment.end * 1000 - anchor.start_ms) * 16);
    if (start < 0 || end <= start || end - start > 480000 || rows.some((r: any) => Math.abs(r.start_ms - anchor.start_ms - (r.start_sample - anchor.start_sample) / 16) > 1)) return null;
    let covered = start, previousEnd = -1;
    for (const row of rows) {
      if (row.start_sample > covered || row.start_sample < previousEnd) return null;
      covered = Math.max(covered, row.end_sample); previousEnd = row.end_sample;
    }
    if (covered < end) return null;
    return { session_id: anchor.session, channel, start_sample: start, end_sample: end, start_ms: segment.start * 1000, end_ms: segment.end * 1000 };
  }
  alignmentSource(meeting: Meeting, segmentId: string) {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`, segment = meeting.segments.find(s => s.segment_id === segmentId);
    if (!segment) return null;
    const capture = this.alignmentCapture(key, segment), current = this.current(key, segment), tokens = current.text.match(/\S+/gu) ?? [];
    if (!capture || !tokens.length || tokens.length > 2000 || current.text.length > 10000 || tokens.some(t => t.length > 1024)) return null;
    const { samples } = this.readSamples(key, capture.session_id, capture.channel, capture.start_sample, capture.end_sample);
    if (!samples) return null;
    const audio = Buffer.alloc(44 + samples.length * 2);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++) { const v = Math.max(-1, Math.min(1, samples[i])); audio.writeInt16LE(Math.round(v * (v < 0 ? 32768 : 32767)), 44 + i * 2); }
    return { ...current, capture, audio };
  }
  alignmentMatches(meeting: Meeting, item: AlignmentItem): boolean {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`, segment = meeting.segments.find(s => s.segment_id === item.segment_id);
    if (!segment) return false;
    const current = this.current(key, segment);
    return current.revision === item.expected_revision && alignmentHash(current.text) === item.text_sha256
      && JSON.stringify(this.alignmentCapture(key, segment)) === JSON.stringify(item.capture);
  }
  private acceptedAlignment(meeting: Meeting, segmentId: string): AlignmentResult | null {
    const row = this.db.prepare('SELECT document FROM alignment_results WHERE meeting=? AND segment=?').get(`${meeting.platform}/${meeting.native_meeting_id}`, segmentId);
    const result: AlignmentResult | null = row ? JSON.parse(row.document) : null;
    return result && this.alignmentMatches(meeting, result) ? result : null;
  }
  alignedWordAudio(meeting: Meeting, segmentId: string, jobId: string, expected: number, index: number): Buffer {
    const item = this.acceptedAlignment(meeting, segmentId);
    if (!item || item.job_id !== jobId || item.expected_revision !== expected) throw new RevisionConflict('Word timing changed; reload before playback');
    const word = item.words?.[index];
    if (!word?.aligned || word.start_ms === null || word.end_ms === null) throw new RangeError('Word has no verified time');
    const source = this.alignmentSource(meeting, segmentId);
    if (!source || alignmentHash(source.audio) !== item.audio_sha256) throw new RevisionConflict('Source audio changed');
    const start = Math.floor(word.start_ms * 16), end = Math.min(source.capture.end_sample - source.capture.start_sample, Math.ceil(word.end_ms * 16));
    const audio = Buffer.concat([source.audio.subarray(0, 44), source.audio.subarray(44 + start * 2, 44 + end * 2)]);
    audio.writeUInt32LE(audio.length - 8, 4); audio.writeUInt32LE(audio.length - 44, 40); return audio;
  }
  publishAlignment(meeting: Meeting, jobId: string, item: AlignmentItem): void {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.alignmentJob(key);
      if (!job || job.id !== jobId || !['running', 'paused'].includes(job.status) || !this.alignmentMatches(meeting, item)) throw new RevisionConflict('Alignment source changed');
      this.db.prepare('INSERT INTO alignment_results VALUES (?,?,?) ON CONFLICT(meeting,segment) DO UPDATE SET document=excluded.document').run(key, item.segment_id, JSON.stringify({ ...item, job_id: jobId }));
      this.enqueueTranscriptRevision(meeting, item.segment_id, 'alignment', item.expected_revision);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private enqueueTranscriptRevision(meeting: Meeting, id: string, kind: TranscriptRevisionEvent['kind'], textRevision: number) {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    const previous = this.db.prepare('SELECT revision FROM transcript_sequences WHERE meeting=? AND segment=?').get(key, id)?.revision ?? 0;
    const revision = Math.max(previous + 1, textRevision + (kind === 'alignment' ? 1 : 0));
    this.db.prepare('INSERT INTO transcript_sequences VALUES (?,?,?) ON CONFLICT(meeting,segment) DO UPDATE SET revision=excluded.revision').run(key, id, revision);
    const event: TranscriptRevisionEvent = { version: 'transcript-revision.v1', type: 'transcript.revised', event_id: randomUUID(),
      meeting_id: meeting.id, platform: meeting.platform, native_meeting_id: meeting.native_meeting_id, segment_id: id, revision, kind, at: new Date().toISOString() };
    this.db.prepare('INSERT INTO transcript_outbox VALUES (?,?,?)').run(event.event_id, key, JSON.stringify(event));
  }
  pendingRevisions(): Array<{ id: string; meeting: string; event: TranscriptRevisionEvent | SpeakerRevisionEvent }> {
    return this.db.prepare('SELECT id,meeting,document FROM transcript_outbox ORDER BY rowid LIMIT 50').all()
      .map((r: any) => ({ id: r.id, meeting: r.meeting, event: JSON.parse(r.document) }));
  }
  acknowledgeRevision(id: string): void { this.db.prepare('DELETE FROM transcript_outbox WHERE id=?').run(id); }
  document(meeting: Meeting): object {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    const speakers = this.speakerState(key);
    return { version: 'transcript-document.v1', meeting_id: meeting.id, status: meeting.status,
      archive_error: meeting.archive_error ?? null,
      segments: meeting.segments.map(segment => {
        const row = this.db.prepare('SELECT raw,history FROM transcript_records WHERE meeting=? AND segment=?')
          .get(key, segment.segment_id);
        const history = JSON.parse(row?.history ?? '[]');
        const channel = segment.speaker_key?.match(/^ch-(\d+):/)?.[1];
        // Do not attach another speaker's channel when a mixed producer has no source identity.
        const audio = channel === undefined ? [] : this.db.prepare(`SELECT 'capture-span' AS kind,
          MIN(id) AS chunk_id,session AS session_id,channel,MIN(start_ms) AS start_ms,MAX(end_ms) AS end_ms,
          COUNT(*) AS chunk_count FROM audio_chunks WHERE meeting=? AND channel=? AND end_ms>? AND start_ms<?
          AND start_ms>=? GROUP BY session,channel ORDER BY start_ms`)
          .all(key, Number(channel), segment.start * 1000, segment.end * 1000, segment.start * 1000 - 90000);
        return { segment_id: segment.segment_id, speaker: speakers.segments[segment.segment_id] ? speakerFor(speakers, segment.segment_id).speaker_name : segment.speaker, start_ms: segment.start * 1000,
          end_ms: segment.end * 1000, raw_text: row?.raw ?? segment.text,
          normalized_text: normalizeTranscript(segment.text), ...this.current(key, segment), history, audio };
      }) };
  }
  foundation(meeting: Meeting): object {
    if(meeting.segments.length>2000 || meeting.segments.reduce((n,s)=>n+s.text.length,0)>500000)throw new RangeError('Source snapshot limit reached');
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const instance = this.db.prepare('SELECT value FROM journal_metadata WHERE key=?').get('instance_id').value;
      const timeline = (this.timeline(key) as any).sources;
      const sources = timeline.map((s: any) => ({ session_id: s.session, channel: String(s.source), sample_rate: 16000,
        start_sample: s.clock_quality === 'samples' ? s.start_sample : null,
        start_us: s.clock_quality === 'samples' ? Math.round(s.start_ms * 1000) : null,
        clock_quality: s.clock_quality === 'samples' ? 'samples' : 'unknown' }));
      const state = this.speakerState(key), document = this.document(meeting) as { segments: any[] };
      const identityDocument = { ...document, segments: document.segments.map(segment => ({ ...segment, ...speakerFor(state, segment.segment_id) })) };
      const base = snapshotBase(instance, meeting, identityDocument, sources, s => {
        const channel = meeting.segments.find(v => v.segment_id === s.segment_id)?.speaker_key?.match(/^ch-(\d+):/)?.[1];
        if (channel === undefined) return [];
        const rows = this.db.prepare(`SELECT session,start_ms,end_ms,start_sample,end_sample,clock_quality FROM audio_chunks
          WHERE meeting=? AND channel=? AND end_ms>? AND start_ms<? ORDER BY session,start_ms,rowid`)
          .all(key, Number(channel), s.start_ms, s.end_ms);
        const refs: any[] = [];
        for (const row of rows) {
          const indexed = row.clock_quality === 'samples' && sources.some((source: any) => source.session_id === row.session && source.channel === channel && source.clock_quality === 'samples');
          const left = indexed ? Math.max(row.start_sample, row.start_sample + Math.round((s.start_ms-row.start_ms)*16)) : null;
          const right = indexed ? Math.min(row.end_sample, row.start_sample + Math.round((s.end_ms-row.start_ms)*16)) : null;
          if (indexed && right! <= left!) continue;
          const ref = { session_id: row.session, channel, start_sample: left, end_sample: right,
            start_us: Math.round((indexed ? row.start_ms + (left!-row.start_sample)/16 : Math.max(row.start_ms,s.start_ms))*1000),
            end_us: Math.round((indexed ? row.start_ms + (right!-row.start_sample)/16 : Math.min(row.end_ms,s.end_ms))*1000) };
          const prev = refs.at(-1);
          if (indexed && prev?.session_id === ref.session_id && prev.end_sample === left && Math.abs(prev.end_us-ref.start_us) <= 1) {
            prev.end_sample = right; prev.end_us = ref.end_us;
          } else refs.push(ref);
        }
        return refs;
      });
      const hash = fingerprint(base), old = this.db.prepare('SELECT * FROM foundation_versions WHERE meeting=?').get(key);
      const sequence = (old?.sequence ?? 0) + Number(old?.fingerprint !== hash);
      this.db.prepare('INSERT INTO foundation_versions VALUES (?,?,?) ON CONFLICT(meeting) DO UPDATE SET sequence=excluded.sequence,fingerprint=excluded.fingerprint').run(key, sequence, hash);
      this.db.exec('COMMIT');
      return { ...base, sequence, fingerprint: hash };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  correct(key: string, segment: TranscriptSegment, expected: number, text: string | null,
    provenance?: { kind: 'refinement'; job_id: string; model: string; audio_sha256: string }): object {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revision = this.correctInTransaction(key, segment, expected, text, provenance);
      this.db.exec('COMMIT'); return revision;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private correctInTransaction(key: string, segment: TranscriptSegment, expected: number, text: string | null,
    provenance?: { kind: 'refinement'; job_id: string; model: string; audio_sha256: string }): object {
    const row = this.db.prepare('SELECT raw,history FROM transcript_records WHERE meeting=? AND segment=?')
      .get(key, segment.segment_id);
    if (!row) throw new Error('Segment not found');
    const history = JSON.parse(row.history);
    if(history.length>=100)throw new RevisionConflict('Segment revision limit reached');
    if (history.length !== expected) throw new RevisionConflict('Transcript changed; reload before saving');
    const corrected = text === null ? row.raw : normalizeTranscript(text);
    if (text !== null && (!corrected || corrected.length > 10000)) throw new Error('Transcript must contain 1–10000 characters');
    history.push({ revision: history.length + 1, text: corrected, kind: text === null ? 'restore' : 'manual',
      ...provenance, at: new Date().toISOString() });
    const result = this.db.prepare('UPDATE transcript_records SET history=? WHERE meeting=? AND segment=? AND history=?')
      .run(JSON.stringify(history), key, segment.segment_id, row.history);
    if (result.changes !== 1) throw new RevisionConflict('Transcript changed; reload before saving');
    this.index(key, segment.segment_id, corrected);
    const rowMeeting = this.db.prepare('SELECT document FROM meetings WHERE key=?').get(key);
    if (!rowMeeting) throw new Error('Meeting not found');
    const meeting: Meeting = JSON.parse(rowMeeting.document), revision = history.at(-1);
    this.db.prepare('DELETE FROM alignment_results WHERE meeting=? AND segment=?').run(key, segment.segment_id);
    this.enqueueTranscriptRevision(meeting, segment.segment_id, revision.kind, revision.revision);
    return revision;
  }
  saveRefinement(job: RefinementJob): void {
    this.db.prepare('INSERT INTO refinement_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
      .run(job.id, job.meeting, JSON.stringify(job));
  }
  applyRefinement(job: RefinementJob, segment: TranscriptSegment, item: RefinementItem): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.correctInTransaction(job.meeting, segment, item.expected_revision, item.text!,
        { kind: 'refinement', job_id: job.id, model: job.model, audio_sha256: item.audio_sha256! });
      this.saveRefinement({ ...job, items: job.items.map(i => i === item ? { ...i, state: 'applied' } : i) });
      this.db.exec('COMMIT'); item.state = 'applied';
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  refinement(key: string): RefinementJob | null {
    const row = this.db.prepare('SELECT document FROM refinement_jobs WHERE meeting=? ORDER BY rowid DESC LIMIT 1').get(key);
    return row ? JSON.parse(row.document) : null;
  }
  view(meeting: Meeting): Meeting {
    const key = `${meeting.platform}/${meeting.native_meeting_id}`;
    const speakers = this.speakerState(key);
    return { ...meeting, segments: meeting.segments.map(s => ({ ...s, ...this.current(key, s),
      ...(speakers.segments[s.segment_id] ? { speaker: speakerFor(speakers, s.segment_id).speaker_name } : {}) })) };
  }
  liveSegment(key: string, segment: TranscriptSegment): TranscriptSegment | null {
    const current = this.current(key, segment);
    if (!segment.completed && current.revision > 0) return null;
    if (current.revision > 0) {
      const saved = this.db.prepare('SELECT document FROM meetings WHERE key=?').get(key);
      const original = saved && (JSON.parse(saved.document) as Meeting).segments.find(s => s.segment_id === segment.segment_id);
      if (original) segment = { ...original, speaker: segment.speaker, text: current.text };
    }
    // Keep transcript.v1 unchanged; revision metadata travels in transcript.revised and HTTP snapshots.
    const speakers = this.speakerState(key), binding = speakers.segments[segment.segment_id];
    const local = sourceChannel(segment) === 1000 && speakers.speakers[speakers.bindings['local-microphone']];
    const speaker = binding ? speakerFor(speakers, segment.segment_id).speaker_name : local ? local.name || 'Unknown speaker'
      : !segment.completed && sourceChannel(segment) === 999 ? 'Unknown speaker' : segment.speaker;
    return { ...segment, speaker, text: current.text };
  }
  audio(key: string, id: string): Buffer | null {
    const row = this.db.prepare('SELECT pcm FROM audio_chunks WHERE meeting=? AND id=?').get(key, id);
    if (!row) return null;
    return this.wav(Buffer.from(row.pcm));
  }
  clip(key: string, segment: TranscriptSegment): Buffer | null {
    const channel = segment.speaker_key?.match(/^ch-(\d+):/)?.[1];
    const samples = Math.ceil((segment.end - segment.start) * 16000);
    if (channel === undefined || !Number.isSafeInteger(samples) || samples <= 0 || samples > 16000 * 90) return null;
    const rows = this.db.prepare(`SELECT session,start_ms,pcm,start_sample,end_sample,clock_quality FROM audio_chunks WHERE meeting=? AND channel=?
      AND end_ms>? AND start_ms<? AND start_ms>=? ORDER BY start_ms,rowid`).all(key, Number(channel), segment.start * 1000, segment.end * 1000, segment.start * 1000 - 90000);
    if (!rows.length || new Set(rows.map((row: any) => row.session)).size !== 1) return null;
    if(rows.every((row:any)=>row.clock_quality==='samples')) {
      const anchor=rows[0],start=Math.round(anchor.start_sample+(segment.start*1000-anchor.start_ms)*16),
        end=Math.round(anchor.start_sample+(segment.end*1000-anchor.start_ms)*16);
      if(start<0||end<=start||end-start>16000*90)return null;
      const result=this.readSamples(key,anchor.session,Number(channel),start,end);
      return result.samples?this.encodeSamples(result.samples):null;
    }
    const pcm = Buffer.alloc(samples * 4);
    for (const row of rows) {
      const data = Buffer.from(row.pcm);
      const offset = Math.round((row.start_ms - segment.start * 1000) * 16);
      const from = Math.max(0, -offset) * 4;
      const to = Math.min(data.length, (samples - offset) * 4);
      if (to > from) data.copy(pcm, Math.max(0, offset) * 4, from, to);
    }
    return this.wav(pcm);
  }
  private wav(pcm: Buffer): Buffer {
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(64000, 28); wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    return wav;
  }
  saveLanguageReview(key: string, session: string, pcm: Float32Array, review: NonNullable<TranscriptionResult['language_review']>): void {
    if (!pcm.length || pcm.length > 16000 * 90 || pcm.some(v => !Number.isFinite(v))) throw new Error('Invalid review audio');
    const bytes = Buffer.alloc(pcm.length * 4);
    for (let i = 0; i < pcm.length; i++) bytes.writeFloatLE(pcm[i], i * 4);
    const id = createHash('sha256').update(key).update(session).update(bytes).digest('hex');
    if (this.db.prepare('SELECT 1 FROM asr_language_reviews WHERE id=?').get(id)) return;
    const size = this.db.prepare('SELECT COALESCE(SUM(length(pcm)),0) AS size FROM asr_language_reviews WHERE meeting=?').get(key).size;
    if (size + bytes.length > 256 * 1024 ** 2) throw new Error('Language review audio reached the 256 MiB meeting limit');
    const document = { id, session, at: new Date().toISOString(), ...review };
    this.db.prepare('INSERT INTO asr_language_reviews VALUES (?,?,?,?)').run(id, key, JSON.stringify(document), bytes);
  }
  languageReviews(key: string): object[] {
    return this.db.prepare('SELECT document FROM asr_language_reviews WHERE meeting=? ORDER BY rowid').all(key).map((r: any) => JSON.parse(r.document));
  }
  languageReviewAudio(key: string, id: string): Buffer | null {
    const row = this.db.prepare('SELECT pcm FROM asr_language_reviews WHERE meeting=? AND id=?').get(key, id);
    return row ? this.wav(Buffer.from(row.pcm)) : null;
  }
  close(): void { this.db.close(); }
}
