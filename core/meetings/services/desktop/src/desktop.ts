import { mixedSegment } from './mixed-transcript.js';
/**
 * @tina/desktop — the meetings ALL-IN-ONE host (dual-lane: gmeet + mixed).
 *
 * The data plane composed into ONE process — no Docker / Postgres / Redis:
 *
 *   capture.v1 ─► ingest WS (:9099)
 *      ├─ decode frames        @tina/capture-codec
 *      ├─ gmeet (per-channel) ─► @tina/gmeet-pipeline (channel-routed, glow name ON the audio frame)
 *      ├─ mixed (zoom/teams/  ─► @tina/mixed-pipeline (mix=ch999 + "You"=ch1000, pyannote-cut, named
 *      │   youtube)                                   from active-speaker HINTS on EVENT frames)
 *      ├─ STT egress           @tina/transcribe-whisper (stt.v1)
 *      ├─ recording.v1     ─►   RecordingSink port → @tina/recording buildRecordingMaster → file
 *      │   (same ingest WS; decodeRecordingChunk discriminates it from an audio frame)
 *      └─ store + deliver  ─►   in-memory + gateway
 *   gateway (:8056): POST /extension/sessions · GET /bots · GET /transcripts/{p}/{n}
 *                  · GET /recordings/{p}/{n} (serve the assembled master) · WS /ws
 *
 * The SAME bricks the cloud splits across meeting-api + collector + gateway, composed as one
 * deployable — "a service is internally a modular monolith." Exposes startDesktop() so the eval
 * loop can drive it in-process. STT is the real backend (TRANSCRIPTION_SERVICE_URL/_TOKEN).
 */
import { SttMetrics } from './stt-metrics.js';
import * as http from 'node:http';
import { createWriteStream, mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {AudioTimelinePool,type TimedAudio,type AudioTimelineEvent} from '@tina/transcribe-buffer';
import { AsrRecovery } from './asr-recovery.js';
import { TranscriptJournal, RevisionConflict } from './transcript-journal.js';
import { transcriptReviewPage } from './transcript-review.js';
import { TranscriptRefiner } from './refinement.js';
import { isArchiveOnlyCaptureSource } from './audio-routing.js';
import { DesktopDiarizer, type DiarizationConfig } from './speaker-diarization.js';
import { DesktopAligner, type AlignmentConfig } from './alignment.js';
import { WebSocketServer, WebSocket } from 'ws';
import { TranscriptionClient } from '@tina/transcribe-whisper';
import { createGmeetPipeline, type TranscriptSegment } from '@tina/gmeet-pipeline';
import { ChunkedTranscriber, type ChunkSegment, type HintKind } from '@tina/mixed-pipeline';
import { AUDIO_ACK_MODE, type AudioSampleAck, decodeAudioFrame, decodeRecordingChunk } from '@tina/capture-codec';
import { createRecordingSink, type RecordingMaster } from './recording-sink.js';
import { ownerOnly, type CanAccess } from './access.js';
import { transcriptionResolver, TranscriptionSettingsError, type IdentitySettings, type TranscriptionSummary } from './transcription-settings.js';

const SAMPLE_RATE = 16000;
const DESKTOP_HOST = '127.0.0.1'; // Meeting audio stays on this machine.
const REC_CONTENT_TYPE: Record<string, string> = { wav: 'audio/wav', webm: 'audio/webm' };
const MIXED_CHANNEL = 999, MIC_CHANNEL = 1000;   // mixed lane: one mixed remote stream + the local "You" mic
const MIXED_PLATFORMS = new Set(['zoom', 'teams', 'msteams', 'youtube']);   // everything else (google_meet, …) → gmeet

// Minimal HTML escape for the few values we interpolate into the player page
// (platform / native id are user-influenced) — never trust them in markup.
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A self-contained HTML5 <audio> player for an assembled recording.v1 master.
// Dependency-free (one inline HTML string, no JS framework) — it simply points an
// <audio> element at the bytes route. `src` is a SAME-ORIGIN absolute path, so no
// escaping beyond the attribute quote is needed; platform/native are escaped.
function recordingPlayerPage(platform: string, native: string, src: string, format?: string): string {
  const title = `TINA recording — ${escHtml(platform)}/${escHtml(native)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; padding: 2rem; }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  .meta { color: #888; font-size: .85rem; margin-bottom: 1rem; word-break: break-all; }
  audio { width: 100%; }
  a.dl { display: inline-block; margin-top: 1rem; font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>${escHtml(platform)} — ${escHtml(native)}</h1>
  <p class="meta">recording.v1 master${format ? ` · ${escHtml(format)}` : ''}</p>
  <audio controls preload="metadata" src="${src}"></audio>
  <a class="dl" href="${src}" download>Download</a>
</main>
</body>
</html>`;
}

export interface Meeting { id: number; platform: string; native_meeting_id: string; status: string; start_time: string; segments: TranscriptSegment[]; transcription?: TranscriptionSummary; archive_error?: string; }

/** UPSERT a confirmed segment into the store by segment_id. A repaint/rename
 *  (late-box claim, cluster re-resolve) re-publishes the SAME id with the corrected
 *  speaker — replace in place (preserving order) so the persisted transcript matches
 *  what live WS clients show, instead of keeping the stale provisional copy (empty
 *  speaker) AS WELL AS the named one (the duplicate GET /transcripts was returning). */
export function upsertSegment(segments: TranscriptSegment[], seg: TranscriptSegment): void {
  const i = segments.findIndex((x) => x.segment_id === seg.segment_id);
  if (i >= 0) segments[i] = seg; else segments.push(seg);
}
export interface DesktopOptions { ingestPort?: number; gatewayPort?: number; txUrl?: string; txToken?: string; txModel?: string; quiet?: boolean; recordingsDir?: string; noSignalMs?: number; canAccess?: CanAccess; transcriptionSettings?: IdentitySettings; initialMeetings?: Meeting[]; statePath?: string; diarization?: DiarizationConfig; alignment?: AlignmentConfig; }
export interface Desktop { ingestPort: number; gatewayPort: number; recordingsDir: string; close(): Promise<void>; }

export async function startDesktop(opts: DesktopOptions = {}): Promise<Desktop> {
  const log = opts.quiet ? (_m: string) => { /* */ } : (m: string) => console.log(m);
  const TX_URL = opts.txUrl ?? process.env.TRANSCRIPTION_SERVICE_URL ?? '';
  const TX_TOKEN = opts.txToken ?? process.env.TRANSCRIPTION_SERVICE_TOKEN ?? '';
  const TX_MODEL = opts.txModel ?? process.env.TRANSCRIPTION_MODEL ?? 'whisper-1';
  const identity = opts.transcriptionSettings ?? (process.env.TINA_ADMIN_API_URL || process.env.TINA_INTERNAL_API_SECRET ? {
    url: process.env.TINA_ADMIN_API_URL || '', secret: process.env.TINA_INTERNAL_API_SECRET || '', apiKey: process.env.TINA_DESKTOP_API_KEY,
  } : undefined);
  const selectedTranscription = transcriptionResolver({ url: TX_URL, token: TX_TOKEN, model: TX_MODEL }, identity);

  const recordingsDir = opts.recordingsDir ?? process.env.TINA_RECORDINGS_DIR ?? join(process.cwd(), '.recordings');
  mkdirSync(recordingsDir, { recursive: true, mode: 0o700 });
  const audioTimeline=new AudioTimelinePool();
  const metricRows = new Map<string, SttMetrics>();
  const metric = (key: string): SttMetrics => {
    let row=metricRows.get(key);
    if(!row){row=new SttMetrics();metricRows.set(key,row);if(metricRows.size>64)metricRows.delete(metricRows.keys().next().value!);}
    return row;
  };
  const audioSessions=new Map<string,string>();
  const audioRuntimeSessions=new Map<string,string>();
  const journal = new TranscriptJournal(opts.statePath ?? join(recordingsDir, 'transcripts.sqlite'));
  // Durable records win over an older bootstrap snapshot.
  const keyOf = (p: string, n: string) => `${p}/${n}`;
  const meetings = new Map<string, Meeting>([...(opts.initialMeetings ?? []), ...journal.load()].map(m => [keyOf(m.platform, m.native_meeting_id), { ...m, segments: [...m.segments] }]));
  for (const meeting of meetings.values()) journal.save(meeting);
  let nextId = Math.max(0, ...[...meetings.values()].map(m => m.id)) + 1;

  // ── P20 / ADR-0012 — complete mediation: every read path consults canAccess ──
  // The SEAM (default owner-only = allow-all on the single-user localhost; real
  // grants land additively behind this same port — ADR-0003). Resolved ONCE here.
  // Subject is derived from the request: the X-API-Key header on HTTP routes, the
  // api_key query param on the headerless /ws connection, else 'local'.
  const canAccess: CanAccess = opts.canAccess ?? ownerOnly;
  const subjectOf = (req: http.IncomingMessage): string => {
    const h = req.headers['x-api-key'];
    const v = Array.isArray(h) ? h[0] : h;
    return v && v.length ? v : 'local';
  };

  // Telemetry ring buffer — the extension POSTs merged diagnostics (page
  // attribution state + session state + per-track frame counters) every ~10s
  // while a session is live (background.ts shipTelemetry). We keep the last N
  // entries in memory so a live attribution bug is inspectable via GET /telemetry
  // with no client-side copy-paste, and /telemetry NEVER 404s (telemetry must
  // not break capture). Secrets/transcript text never enter telemetry (the
  // client scrubs DOM free-text before sending).
  const TELEMETRY_MAX = 200;
  const telemetry: Array<{ at: string; reason: string; body: any }> = [];

  // ── recording.v1 receiver (P5) — the desktop is the LOCAL receiver (ADR-0005). ──
  // The DISK + SERVE adapter lives HERE (the composition root); the RecordingSink
  // port (recording-sink.ts) holds the pure assembly. On is_final the port assembles
  // the master via @tina/recording buildRecordingMaster and calls onMaster → we write
  // the file (recordingsDir, env-configurable) + remember its path for the gateway GET.

  const recordings = new Map<string, { path: string; format: string }>();   // key → on-disk master
  for (const key of meetings.keys()) {
    for (const format of ['wav', 'webm']) {
      const path = join(recordingsDir, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.${format}`);
      if (existsSync(path)) { recordings.set(key, { path, format }); break; }
    }
  }
  // Active ingest sessions by meeting key → a finalizer the gateway's
  // POST /extension/sessions/end can invoke to end the session NOW (dispose the
  // pipeline, flush the recording, mark completed) without waiting for the WS to
  // close on its reconnect grace. Registered by each ingest connection.
  const activeSessions = new Map<string, () => Promise<void>>();
  const captureWork = new Set<string>();
  const captureFinishes = new Set<Promise<void>>();
  const recordingOwners = new Map<string, string>();
  const masterOwners = new Map<string, string>();
  const recordingReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const refiner = new TranscriptRefiner(journal, () => activeSessions.size > 0);
  const diarizationConfig = opts.diarization ?? (process.env.DIARIZATION_SERVICE_URL ? {
    url: process.env.DIARIZATION_SERVICE_URL, token: process.env.DIARIZATION_SERVICE_TOKEN || '',
  } : undefined);
  const diarizer = new DesktopDiarizer(journal, () => activeSessions.size > 0, diarizationConfig);
  const alignmentConfig = opts.alignment ?? (process.env.ALIGNMENT_SERVICE_URL ? {
    url: process.env.ALIGNMENT_SERVICE_URL, token: process.env.ALIGNMENT_SERVICE_TOKEN || '',
  } : undefined);
  const aligner = new DesktopAligner(journal, () => activeSessions.size > 0, () => refiner.busy || diarizer.busy, alignmentConfig);
  const recSink = createRecordingSink({
    log,
    onMaster: (m: RecordingMaster) => {
      const safe = m.key.replace(/[^a-zA-Z0-9._-]/g, '_');   // platform/native → filesystem-safe name
      const path = join(recordingsDir, `${safe}.${m.format}`);
      try {
        const owner = recordingOwners.get(m.key) || '';
        if (existsSync(path) && masterOwners.get(m.key) !== owner) copyFileSync(path, join(recordingsDir, `${safe}.${randomUUID()}.${m.format}`));
        writeFileSync(path, m.bytes); masterOwners.set(m.key, owner); recordings.set(m.key, { path, format: m.format }); log(`[desktop] ⏹ recording master → ${path} (${m.bytes.length}B)`); }
      catch (e: any) { log(`[desktop] recording write FAILED for ${m.key}: ${e?.message || e}`); }
    },
  });
  const saveMeeting = (meeting: Meeting, segment?: TranscriptSegment, captureSession?: string) => {
    const started=performance.now(), stats=metric(keyOf(meeting.platform,meeting.native_meeting_id));
    try { journal.save(meeting, segment, captureSession); return true; }
    catch { stats.errors.storage++; meeting.archive_error = 'Transcript persistence failed';
        reportFault(keyOf(meeting.platform, meeting.native_meeting_id), { source: 'archive', kind: 'write-failed', detail: meeting.archive_error }); return false; }
    finally { stats.record('transcript_write_ms', performance.now()-started); }
  };
  const resolve = (p: string, n: string): Meeting => {
    const k = keyOf(p, n);
    let m = meetings.get(k);
    if (!m) { m = { id: nextId++, platform: p, native_meeting_id: n, status: 'active', start_time: new Date().toISOString(), segments: [] }; meetings.set(k, m); saveMeeting(m); }
    return m;
  };

  // Live delivery (WS) + persist CONFIRMED to the store.
  const liveClients = new Map<WebSocket, Set<string>>();
  const liveSubjects = new Map<WebSocket, string>();
  // Persist a CONFIRMED segment, UPSERTING by segment_id. A later repaint/rename
  // (late-box claim, cluster re-resolve) re-publishes the SAME id with the corrected
  // speaker — replace in place so the store matches what live WS clients show (they
  // upsert by id) instead of accumulating the stale provisional copy (empty speaker)
  // ALONGSIDE the named one — the "ghost duplicate" GET /transcripts was returning.
  const persist = (m: Meeting | undefined, seg: TranscriptSegment, captureSession?: string): boolean => {
    if (!m) return false;
    const protectedSegment=journal.liveSegment(keyOf(m.platform,m.native_meeting_id),seg);
    if(!protectedSegment)return true;
    seg=protectedSegment;
    const next = { ...m, segments: [...m.segments] }; upsertSegment(next.segments, seg);
    if (!saveMeeting(next, seg, captureSession)) { m.archive_error = next.archive_error; return false; }
    m.segments = next.segments; return true;
  };
  const broadcast = (key: string, seg: TranscriptSegment, captureSession?: string) => {
    const m = meetings.get(key);
    if (seg.completed && !persist(m, seg, captureSession)) return;
    const canonical = journal.liveSegment(key, seg); if (!canonical) return; seg = canonical;
    if (seg.completed) log(`  [${seg.speaker}] ${seg.text}`);
    metric(key).caption(seg);
    const msg = JSON.stringify({ type: 'transcript', ts: new Date().toISOString(), meeting: key, confirmed: seg.completed ? [seg] : [], pending: seg.completed ? [] : [seg] });
    for (const [c, keys] of liveClients) if (c.readyState === WebSocket.OPEN && (keys.size === 0 || keys.has(key))) c.send(msg);
  };

  // Mixed lane: a ChunkedTranscriber emit (speaker + confirmed/pending ChunkSegment batches) → the
  // same transcript.v1 envelope. Confirmed + pending MUST travel together (a confirm with empty
  // pending deletes the client's draft block). ChunkSegment start/endMs are audio-time ms.
  const broadcastBatch = (key: string, speaker: string, confirmed: TranscriptSegment[], pending: TranscriptSegment[], captureSession?: string, alreadySaved = false) => {
    const m = meetings.get(key);
    if (!alreadySaved) confirmed = confirmed.filter(s => persist(m, s, captureSession));
    confirmed = confirmed.map(s => journal.liveSegment(key, s)!);
    pending = pending.map(s => journal.liveSegment(key, s)).filter((s): s is TranscriptSegment => s !== null);
    for (const s of confirmed) log(`  [${speaker}] ${s.text}`);
    for(const seg of [...confirmed,...pending])metric(key).caption(seg);
    const msg = JSON.stringify({ type: 'transcript', ts: new Date().toISOString(), meeting: key, speaker, confirmed, pending });
    for (const [c, keys] of liveClients) if (c.readyState === WebSocket.OPEN && (keys.size === 0 || keys.has(key))) c.send(msg);
  };

  // ── P18 (fail loud + attributable): surface an engine/dependency FAULT — e.g. an STT
  // 402 "out of balance" — on an observable, attributed channel (log · /telemetry · a /ws
  // `health` frame) instead of degrading silently to "no transcript". Throttled per
  // (meeting,source,kind) so a repeating fault doesn't flood. ──
  const faultSeen = new Map<string, number>();
  const FAULT_THROTTLE_MS = 15000;
  const reportFault = (key: string, fault: unknown) => {
    const f = fault as { source?: string; kind?: string; status?: number; detail?: string; message?: string };
    const source = f?.source ?? 'engine';
    const kind = f?.kind ?? 'unknown';
    const id = `${key}|${source}|${kind}`;
    const now = Date.now();
    if (now - (faultSeen.get(id) ?? 0) < FAULT_THROTTLE_MS) return;   // already surfaced recently
    faultSeen.set(id, now);
    const detail = f?.detail ?? f?.message ?? '';
    log(`  ⚠ ENGINE FAULT [${source}:${kind}] ${key}${detail ? ` — ${detail}` : ''}`);
    telemetry.push({ at: new Date().toISOString(), reason: 'engine_fault', body: { meeting: key, source, kind, status: f?.status, detail } });
    while (telemetry.length > TELEMETRY_MAX) telemetry.shift();
    const msg = JSON.stringify({ type: 'health', meeting: key, source, kind, status: f?.status, detail });
    for (const [c, keys] of liveClients) if (c.readyState === WebSocket.OPEN && (keys.size === 0 || keys.has(key))) c.send(msg);
  };

  const recovery = new AsrRecovery(journal, () => captureWork.size > 0, key => meetings.get(key),
    (key, segments) => {
      for (const speaker of new Set(segments.map(segment => segment.speaker)))
        broadcastBatch(key, speaker, segments.filter(segment => segment.speaker === speaker), [], undefined, true);
    }, (key, detail, kind = 'recovery-pending') => reportFault(key, { source: 'stt', kind, detail }));
  // Resolve host credentials again; personal credentials must be supplied again by the original client.
  void selectedTranscription().then(config => { recovery.register(config, identity?.apiKey || ''); recovery.kick(); }).catch(() => recovery.kick());

  // ── gateway (control plane + history + live WS) ──
  const CORS: Record<string, string> = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-API-Key, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const readBody = (req: http.IncomingMessage): Promise<any> => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
  const gateway = http.createServer(async (req, res) => {
    const send = (o: any, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(o)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = new URL(req.url || '', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
      return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>TINA · Saved transcripts</title><style>body{font:16px system-ui;background:#0d2522;color:#deede7;max-width:860px;margin:40px auto;padding:20px}a{color:#9cd9c3}li{margin:18px 0}</style><h1>Saved transcripts</h1><p>Review original text, corrections and available source audio.</p><ul id="meetings"></ul><p id="error" role="alert"></p><script>fetch('/bots').then(r=>r.json()).then(d=>{for(const m of d.meetings){const li=document.createElement('li'),a=document.createElement('a');a.href='/transcripts/'+encodeURIComponent(m.platform)+'/'+encodeURIComponent(m.native_meeting_id)+'/review';a.textContent=m.platform+' / '+m.native_meeting_id+' · '+m.status;li.append(a);document.getElementById('meetings').append(li)}}).catch(()=>document.getElementById('error').textContent='Could not load saved transcripts')</script></html>`);
    }
    if (req.method === 'GET' && url.pathname === '/transcription/config') {
      try {
        const key = req.headers['x-api-key'];
        const selected = await selectedTranscription(Array.isArray(key) ? key[0] : key);
        return send({ ...selected.summary, configured: !!selected.url, applies_to: 'next-session' });
      } catch (error) {
        return send({ error: error instanceof TranscriptionSettingsError ? error.message : 'ASR settings unavailable' },
          error instanceof TranscriptionSettingsError ? error.status : 503);
      }
    }
    if (req.method === 'POST' && url.pathname === '/extension/sessions') {
      const b = await readBody(req);
      const m = resolve(b.platform || 'unknown', b.native_meeting_id || b.native_id || '?');
      return send({ meeting_id: m.id, platform: m.platform, native_meeting_id: m.native_meeting_id, token: 'local' });
    }
    // POST /extension/sessions/end — finalize a session: the extension's Stop is
    // a CONTRACT (background.ts stopCapture) — "stop" must mean stopped NOW, not
    // after the ingest reconnect grace. Run the live finalizer (dispose pipeline,
    // flush recording, mark completed + drop the WS) if one is registered; either
    // way mark the meeting completed so the panel + history agree. Idempotent.
    if (req.method === 'POST' && url.pathname === '/extension/sessions/end') {
      const b = await readBody(req);
      const p = b.platform || 'unknown';
      const n = b.native_meeting_id || b.native_id || '?';
      const k = keyOf(p, n);
      const fin = activeSessions.get(k);
      if (fin) { try { await fin(); } catch (e: any) { log(`[desktop] session end finalize FAILED for ${k}: ${e?.message || e}`); } }
      const m = meetings.get(k);
      if (m) { m.status = 'completed'; saveMeeting(m); }
      return send({ ok: true, platform: p, native_meeting_id: n, meeting_id: m?.id ?? 0, status: 'completed', finalized: !!fin });
    }
    // POST /telemetry — accept the extension's JSON diagnostics and log+retain
    // them (ring buffer). MUST NEVER 404 (telemetry must not break capture). The
    // body is the merged extension state (session + page attribution + per-track
    // frame counters); transcript text never enters it (the client scrubs it).
    if (req.method === 'POST' && url.pathname === '/telemetry') {
      const b = await readBody(req);
      const reason = String(b?.reason || 'telemetry');
      telemetry.push({ at: new Date().toISOString(), reason, body: b });
      while (telemetry.length > TELEMETRY_MAX) telemetry.shift();
      const st = b?.state || {};
      log(`[telemetry] ${reason} ${st.platform ?? '?'}/${st.nativeMeetingId ?? '?'} status=${st.status ?? '?'} wsOpen=${b?.wsOpen ?? '?'}`);
      return send({ ok: true });
    }
    // GET /telemetry — read the ring buffer back (debugging needs no client-side
    // copy-paste). ?reason=… filters; ?limit=N caps the count (newest last).
    if (req.method === 'GET' && url.pathname === '/telemetry') {
      const reason = url.searchParams.get('reason');
      const limit = Math.max(1, Math.min(TELEMETRY_MAX, Number(url.searchParams.get('limit')) || TELEMETRY_MAX));
      const items = (reason ? telemetry.filter((t) => t.reason === reason) : telemetry).slice(-limit);
      return send({ count: items.length, total: telemetry.length, items });
    }
    // GET /bots — P20: return ONLY the meetings the subject canAccess (filter the
    // list; a forbidden meeting must not even be enumerable to a denied reader).
    if (req.method === 'GET' && url.pathname === '/transcripts/search') {
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}`) return send({ error: 'origin refused' }, 403);
      const query = url.searchParams.get('q') || '';
      if (!query.trim() || query.length > 1000) return send({ error: 'Query must contain 1–1000 characters' }, 422);
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) return send({ error: 'Invalid paging' }, 422);
      const visible = [...meetings.entries()].filter(([key, m]) => canAccess(subjectOf(req), key, 'read')
        && (!url.searchParams.has('meeting_id') || String(m.id) === url.searchParams.get('meeting_id'))
        && (!url.searchParams.has('platform') || m.platform === url.searchParams.get('platform'))
        && (!url.searchParams.has('native_meeting_id') || m.native_meeting_id === url.searchParams.get('native_meeting_id')));
      const hits = journal.search(query, visible.map(([key]) => key), limit, offset).flatMap(hit => {
        const m = meetings.get(hit.meeting)!;
        const segment = journal.view(m).segments.find(s => s.segment_id === hit.segment);
        return segment ? [{ meeting_db_id: m.id, platform: m.platform, native_meeting_id: m.native_meeting_id,
          segment_row_id: hit.segment, start: segment.start, end: segment.end, speaker: segment.speaker,
          text: hit.text, rank: hit.rank, snippet: hit.text.slice(0, 240) }] : [];
      });
      return send({ hits, count: hits.length });
    }
    if (req.method === 'GET' && url.pathname === '/bots') {
      const subject = subjectOf(req);
      const visible = [...meetings.values()].filter((m) => canAccess(subject, keyOf(m.platform, m.native_meeting_id), 'read'));
      return send({ meetings: visible.map(m => journal.view(m)), has_more: false });
    }
    // GET /health — liveness + dependency readiness (P18). The body reports each
    // dependency's state so an operator/orchestrator sees "is STT configured?" without
    // parsing logs. 200 when STT is configured; 503 (degraded) when it isn't — a desktop
    // with no STT silently never transcribes, which this makes observable.
    if (req.method === 'GET' && url.pathname === '/health') {
      const live = [...meetings.values()].filter((m) => m.status === 'active').length;
      const ok = !!TX_URL || !!(identity?.url && identity?.secret);
      return send({ ok, checks: { stt: ok ? 'configured' : 'unconfigured', stt_url: identity ? null : TX_URL || null, stt_model: identity ? null : TX_URL ? TX_MODEL : null, stt_settings: identity ? 'central' : 'environment' }, live_sessions: live, recordings_dir: recordingsDir }, ok ? 200 : 503);
    }
    const metricsRoute=url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/metrics$/);
    if(metricsRoute && (req.method==='GET'||req.method==='POST')) {
      const origin=req.headers.origin;
      if(origin && origin!==`http://127.0.0.1:${gatewayPort}` && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))return send({error:'origin refused'},403);
      if(req.headers['sec-fetch-site']==='cross-site' && !origin?.startsWith('chrome-extension://'))return send({error:'origin refused'},403);
      const key=keyOf(decodeURIComponent(metricsRoute[1]),decodeURIComponent(metricsRoute[2]));
      if(!canAccess(subjectOf(req),key,req.method==='GET'?'read':'write'))return send({error:'forbidden'},403);
      const meeting=meetings.get(key);if(!meeting)return send({error:'meeting not found'},404);
      const stats=metric(key);
      if(req.method==='POST') {
        const chunks:Buffer[]=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>1024)return send({error:'request too large'},413);chunks.push(Buffer.from(chunk));}
        let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send({error:'Invalid client metric'},422);}
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.entries(body).some(([k,v])=>!['ui_commit_ms','ui_frame_ms','server_to_ui_ms'].includes(k)||typeof v!=='number'||!Number.isFinite(v)||v<0||v>3600000))return send({error:'Invalid client metric'},422);
        for(const [k,v] of Object.entries(body))stats.record(k,v as number);
        return send({ok:true});
      }
      return send({version:'stt-metrics.v1',meeting_id:meeting.id,...stats.snapshot(),storage:journal.storageMetrics(key),
        clock:'UI durations use performance.now; server_to_ui/caption lag require synchronized clocks. UI values are client-reported.'});
    }
    const foundation = url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/foundation$/);
    if (foundation && req.method === 'GET') {
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}` || req.headers['sec-fetch-site'] === 'cross-site') return send({ error: 'origin refused' }, 403);
      const key = keyOf(decodeURIComponent(foundation[1]), decodeURIComponent(foundation[2]));
      if (!canAccess(subjectOf(req), key, 'read')) return send({ error: 'forbidden' }, 403);
      const meeting = meetings.get(key);
      if (!meeting) return send({ error: 'meeting not found' }, 404);
      if (meeting.status === 'active' || captureFinishes.size) return send({ error: 'Stop capture and wait for finalization before synchronization' }, 409);
      try { const snapshot=journal.foundation(meeting);if(Buffer.byteLength(JSON.stringify(snapshot))>4*1024*1024)return send({error:'Source snapshot exceeds 4 MiB'},413);return send(snapshot); }
      catch (error) { return send({ error: error instanceof RangeError ? error.message : 'Source snapshot unavailable' }, error instanceof RangeError ? 413 : 503); }
    }
    const languageReview = url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/asr-reviews(?:\/([a-f0-9]{64})\/audio)?$/);
    if (languageReview && req.method === 'GET') {
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}` || req.headers['sec-fetch-site'] === 'cross-site') return send({ error: 'origin refused' }, 403);
      const key = keyOf(decodeURIComponent(languageReview[1]), decodeURIComponent(languageReview[2]));
      if (!canAccess(subjectOf(req), key, 'read')) return send({ error: 'forbidden' }, 403);
      if (!meetings.has(key)) return send({ error: 'meeting not found' }, 404);
      if (!languageReview[3]) return send({ items: journal.languageReviews(key) });
      const wav = journal.languageReviewAudio(key, languageReview[3]);
      if (!wav) return send({ error: 'review audio unavailable' }, 404);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' }); return res.end(wav);
    }
    const review = url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/(review|segments\/([^/]+)\/audio)$/);
    if (req.method === 'GET' && review) {
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}`) return send({ error: 'origin refused' }, 403);
      if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-dest'] !== 'document') return send({ error: 'origin refused' }, 403);
      const key = keyOf(decodeURIComponent(review[1]), decodeURIComponent(review[2]));
      if (!canAccess(subjectOf(req), key, 'read')) return send({ error: 'forbidden' }, 403);
      const meeting = meetings.get(key);
      if (!meeting) return send({ error: 'meeting not found' }, 404);
      if (review[3] === 'review') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', ...CORS });
        return res.end(transcriptReviewPage(`/transcripts/${encodeURIComponent(meeting.platform)}/${encodeURIComponent(meeting.native_meeting_id)}`));
      }
      const segment = meeting.segments.find(s => s.segment_id === decodeURIComponent(review[4]));
      const wav = segment ? journal.clip(key, segment) : null;
      if (!wav) return send({ error: 'source audio unavailable' }, 404);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, ...CORS }); return res.end(wav);
    }
    const recoveryPath = url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/asr-recovery$/);
    if (req.method === 'GET' && recoveryPath) {
      if ((req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}`) || req.headers['sec-fetch-site'] === 'cross-site') return send({ error: 'origin refused' }, 403);
      const key = keyOf(decodeURIComponent(recoveryPath[1]), decodeURIComponent(recoveryPath[2]));
      if (!canAccess(subjectOf(req), key, 'read')) return send({ error: 'forbidden' }, 403);
      if (!meetings.has(key)) return send({ error: 'meeting not found' }, 404);
      return send(journal.asrStatus(key));
    }
    const timelinePath=url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/audio-timeline$/);
    if(timelinePath && req.method==='GET') {
      if(req.headers.origin && req.headers.origin!==`http://127.0.0.1:${gatewayPort}`)return send({error:'forbidden origin'},403);
      const key=keyOf(decodeURIComponent(timelinePath[1]),decodeURIComponent(timelinePath[2]));
      if(!canAccess(subjectOf(req),key,'read'))return send({error:'forbidden'},403);
      if(!meetings.has(key))return send({error:'meeting not found'},404);
      if(!url.searchParams.has('start_sample'))return send({version:'audio-timeline.v1',sample_rate:SAMPLE_RATE,memory:audioTimeline.stats,...journal.timeline(key)});
      const session=url.searchParams.get('session')||'',source=url.searchParams.get('source')||'';
      const start=Number(url.searchParams.get('start_sample')),end=Number(url.searchParams.get('end_sample'));
      if(!session || !/^\d+$/.test(source) || !Number.isSafeInteger(Number(source)) || !Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>SAMPLE_RATE*30)return send({error:'Use session, source and a sample range of at most 30 seconds'},422);
      const memory=audioSessions.get(session)===key?audioTimeline.read(audioRuntimeSessions.get(session) ?? session,source,start,end):{samples:null,missing:[{startSample:start,endSample:end}]};
      const archived=memory.samples?memory:journal.readSamples(key,session,Number(source),start,end);
      if(!archived.samples)return send({error:'audio interval unavailable',missing:archived.missing},409);
      const wav=journal.encodeSamples(archived.samples);
      res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':wav.length,'Cache-Control':'no-store','X-TINA-Audio-Source':memory.samples?'memory':'archive',...CORS});return res.end(wav);
    }
    const alignedAudio = url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/segments\/([^/]+)\/aligned-audio$/);
    if (alignedAudio && req.method === 'GET') {
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}` || req.headers['sec-fetch-site'] === 'cross-site') return send({ error: 'origin refused' }, 403);
      const key = keyOf(decodeURIComponent(alignedAudio[1]), decodeURIComponent(alignedAudio[2]));
      if (!canAccess(subjectOf(req), key, 'read')) return send({ error: 'forbidden' }, 403);
      const meeting = meetings.get(key); if (!meeting) return send({ error: 'meeting not found' }, 404);
      const index = Number(url.searchParams.get('word_index')), revision = Number(url.searchParams.get('expected_revision'));
      const jobId = url.searchParams.get('job_id');
      if (!jobId || jobId.length > 128 || !url.searchParams.has('word_index') || !url.searchParams.has('expected_revision')
          || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(revision) || revision < 0) return send({ error: 'Invalid word playback request' }, 422);
      try {
        const audio = journal.alignedWordAudio(meeting, decodeURIComponent(alignedAudio[3]), jobId, revision, index);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store', ...CORS }); return res.end(audio);
      } catch (error) { return send({ error: error instanceof Error ? error.message : 'Word audio unavailable' }, error instanceof RevisionConflict ? 409 : 422); }
    }
    const speakersRoute = url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/(speakers|diarization|canonical|memory|alignment)(?:\/([^/]+))?$/);
    if (speakersRoute) {
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}` || req.headers['sec-fetch-site'] === 'cross-site') return send({ error: 'origin refused' }, 403);
      const key = keyOf(decodeURIComponent(speakersRoute[1]), decodeURIComponent(speakersRoute[2]));
      if (!canAccess(subjectOf(req), key, req.method === 'GET' ? 'read' : 'write')) return send({ error: 'forbidden' }, 403);
      const meeting = meetings.get(key); if (!meeting) return send({ error: 'meeting not found' }, 404);
      const resource = speakersRoute[3], action = speakersRoute[4];
      try {
        if (req.method === 'GET' && !action) {
          if (resource === 'speakers') return send(journal.speakers(meeting));
          if (resource === 'alignment') return send(aligner.current(key));
          if (resource === 'canonical') return send(journal.canonical(meeting));
          if (resource === 'memory') return send(journal.memory(meeting));
          return send({ configured: diarizer.configured, job: diarizer.current(key) });
        }
        if (!(resource === 'speakers' && ['PATCH', 'POST'].includes(req.method || '') || ['diarization', 'alignment'].includes(resource) && req.method === 'POST')) return send({ error: 'method not allowed' }, 405);
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8192) return send({ error: 'request too large' }, 413); chunks.push(Buffer.from(chunk)); }
        let body: any;
        try { body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send({ error: 'Invalid speaker request' }, 422); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send({ error: 'Invalid speaker request' }, 422);
        const exact = (keys: string[]) => Object.keys(body).every(k => keys.includes(k));
        if (resource === 'alignment') {
          if (!exact([])) return send({ error: 'Invalid alignment request' }, 422);
          if (action === 'start') return send(aligner.start(meeting), 202);
          if (action === 'cancel') return send(aligner.cancel(key));
        } else if (resource === 'diarization') {
          if (action === 'start' && (aligner.busy || refiner.busy)) throw new RevisionConflict('Wait for current audio processing');
          if (action === 'start' && exact(['num_speakers'])) return send(diarizer.start(meeting, body.num_speakers ?? -1), 202);
          if (action === 'cancel' && exact([])) return send(diarizer.cancel(key));
          if (action === 'apply' && exact(['job_id']) && typeof body.job_id === 'string' && body.job_id.length <= 128) {
            diarizer.apply(meeting, body.job_id); return send(journal.speakers(meeting));
          }
        } else if (Number.isSafeInteger(body.expected_revision) && body.expected_revision >= 0) {
          if (req.method === 'POST' && action === 'assign' && exact(['segment_id', 'speaker_id', 'expected_revision'])
              && typeof body.segment_id === 'string' && (body.speaker_id === null || typeof body.speaker_id === 'string')) {
            journal.assignSpeaker(meeting, body.segment_id, body.expected_revision, body.speaker_id); return send(journal.speakers(meeting));
          }
          if (req.method === 'PATCH' && action && exact(['expected_revision', 'name']) && (body.name === null || typeof body.name === 'string')) {
            journal.renameSpeaker(meeting, action, body.expected_revision, body.name); return send(journal.speakers(meeting));
          }
        }
        return send({ error: 'Invalid speaker request' }, 422);
      } catch (error) {
        return send({ error: error instanceof Error ? error.message : 'Speaker update failed' }, error instanceof RevisionConflict ? 409 : error instanceof RangeError ? 422 : 500);
      }
    }
    const detail = url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/(document|segments\/([^/]+)|audio\/([^/]+)|refinement(?:\/(start|cancel|apply))?)$/);
    if (detail && ['GET', 'PATCH', 'POST'].includes(req.method || '')) {
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}`) return send({ error: 'origin refused' }, 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') return send({ error: 'origin refused' }, 403);
      const key = keyOf(decodeURIComponent(detail[1]), decodeURIComponent(detail[2]));
      if (!canAccess(subjectOf(req), key, req.method === 'GET' ? 'read' : 'write')) return send({ error: 'forbidden' }, 403);
      const meeting = meetings.get(key);
      if (!meeting) return send({ error: 'meeting not found' }, 404);
      if (detail[3].startsWith('refinement')) {
        if (req.method === 'GET' && !detail[6]) return send(refiner.current(key));
        if (req.method !== 'POST' || !detail[6]) return send({ error: 'method not allowed' }, 405);
        try {
          if (detail[6] === 'start') {
            const config = await selectedTranscription(subjectOf(req) === 'local' ? '' : subjectOf(req));
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) return send({ error: 'request too large' }, 413); chunks.push(Buffer.from(chunk)); }
            let body: any;
            try { body = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send({ error: 'Invalid refinement options' }, 422); }
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'glossary')) return send({ error: 'Invalid refinement options' }, 422);
            if (aligner.busy || diarizer.busy) throw new RevisionConflict('Wait for current audio processing');
            return send(refiner.start(meeting, config, body.glossary), 202);
          }
          if (detail[6] === 'cancel') return send(refiner.cancel(key));
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) return send({ error: 'request too large' }, 413); chunks.push(Buffer.from(chunk)); }
          let body: any;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send({ error: 'Invalid refinement request' }, 422); }
          if (!body || typeof body.job_id !== 'string' || body.job_id.length > 64
              || typeof body.segment_id !== 'string' || body.segment_id.length > 512
              || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0
              || Object.keys(body).some(k => !['job_id', 'segment_id', 'expected_revision'].includes(k))) return send({ error: 'Invalid refinement request' }, 422);
          refiner.apply(meeting, body.job_id, body.segment_id, body.expected_revision);
          return send(journal.document(meeting));
        } catch (error) {
          return send({ error: error instanceof Error ? error.message : 'Refinement unavailable' },
            error instanceof RevisionConflict ? 409 : error instanceof RangeError ? 422 : error instanceof TranscriptionSettingsError ? error.status : 503);
        }
      }
      if (req.method === 'GET' && detail[3] === 'document') return send(journal.document(meeting));
      if (req.method === 'GET' && detail[5]) {
        const wav = journal.audio(key, decodeURIComponent(detail[5]));
        if (!wav) return send({ error: 'audio not found' }, 404);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, ...CORS }); return res.end(wav);
      }
      if (req.method === 'PATCH' && detail[4]) {
        // Local owner UI only: reject browser writes from unrelated origins, even with CORS enabled.
        if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${gatewayPort}`) return send({ error: 'origin refused' }, 403);
        if (!['completed', 'failed', 'interrupted'].includes(meeting.status)) return send({ error: 'Stop capture before correcting transcript' }, 409);
        const segment = meeting.segments.find(s => s.segment_id === decodeURIComponent(detail[4]));
        if (!segment) return send({ error: 'segment not found' }, 404);
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) return send({ error: 'request too large' }, 413); chunks.push(Buffer.from(chunk)); }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0
              || !(typeof body.text === 'string' || body.text === null)
              || Object.keys(body).some(k => !['expected_revision', 'text'].includes(k))) return send({ error: 'Invalid correction' }, 422);
          journal.correct(key, segment, body.expected_revision, body.text);
          return send(journal.document(meeting));
        } catch (error) { return send({ error: error instanceof Error ? error.message : 'Invalid correction' }, error instanceof RevisionConflict ? 409 : 422); }
      }
      return send({ error: 'method not allowed' }, 405);
    }
    const tr = url.pathname.match(/^\/transcripts\/([^/]+)\/([^/]+)\/?$/);
    if (req.method === 'GET' && tr) {
      const p = decodeURIComponent(tr[1]), n = decodeURIComponent(tr[2]);
      if (!canAccess(subjectOf(req), keyOf(p, n), 'read')) return send({ error: 'forbidden' }, 403);   // P20
      const m = meetings.get(keyOf(p, n));
      return send(m ? journal.view(m) : { id: 0, platform: p, native_meeting_id: n, status: 'unknown', segments: [] });
    }
    // GET /recordings/{p}/{n}/player — a minimal, dependency-free HTML5 <audio>
    // page that plays the assembled master via the EXISTING GET /recordings/{p}/{n}
    // (ADR-0005). Matched BEFORE the bytes route so the trailing /player wins.
    const play = url.pathname.match(/^\/recordings\/([^/]+)\/([^/]+)\/player\/?$/);
    if (req.method === 'GET' && play) {
      const p = decodeURIComponent(play[1]);
      const n = decodeURIComponent(play[2]);
      if (!canAccess(subjectOf(req), keyOf(p, n), 'read')) return send({ error: 'forbidden' }, 403);   // P20
      const entry = recordings.get(keyOf(p, n));
      const src = `/recordings/${encodeURIComponent(p)}/${encodeURIComponent(n)}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
      return res.end(recordingPlayerPage(p, n, src, entry?.format));
    }
    // GET /recordings/{p}/{n} — serve the assembled recording.v1 master (the disk
    // ADAPTER's read side; the all-in-one path's equivalent of meeting-api's file serve).
    const rec = url.pathname.match(/^\/recordings\/([^/]+)\/([^/]+)/);
    if (req.method === 'GET' && rec) {
      const p = decodeURIComponent(rec[1]), n = decodeURIComponent(rec[2]);
      if (!canAccess(subjectOf(req), keyOf(p, n), 'read')) return send({ error: 'forbidden' }, 403);   // P20
      const entry = recordings.get(keyOf(p, n));
      if (!entry || !existsSync(entry.path)) return send({ error: 'no recording', platform: p, native_meeting_id: n }, 404);
      const body = readFileSync(entry.path);
      res.writeHead(200, { 'Content-Type': REC_CONTENT_TYPE[entry.format] || 'application/octet-stream', 'Content-Length': body.length, ...CORS });
      return res.end(body);
    }
    send({ error: 'not found', path: url.pathname }, 404);
  });
  const wss = new WebSocketServer({ server: gateway, path: '/ws' });
  wss.on('connection', (ws, req) => {
    liveClients.set(ws, new Set());
    // P20: the /ws connection carries no header we can read per-message — derive the
    // subject from the `api_key` query param on the connection URL (else 'local').
    const subject = new URL(req.url || '', 'http://localhost').searchParams.get('api_key') || 'local';
    liveSubjects.set(ws, subject);
    ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.action === 'subscribe') {
      // DROP denied keys from the subscription set — a forbidden meeting yields no
      // transcript/health broadcast for the subject. An EMPTY set means "all meetings"
      // (broadcast's keys.size===0 fan-out), so when the client DID request meetings
      // but every one was denied we install a sentinel that matches no real key — a
      // deny must shrink, never widen, what the client receives.
      const requested: string[] = (m.meetings || []).map((x: any) => `${x.platform}/${x.native_id ?? x.native_meeting_id}`);
      const allowed = requested.filter((k) => canAccess(subject, k, 'read'));
      const set = requested.length && allowed.length === 0 ? new Set([' deny-all']) : new Set(allowed);
      liveClients.set(ws, set);
      ws.send(JSON.stringify({ type: 'subscribed' }));
      for (const key of allowed) {
        const meeting = meetings.get(key);
        if (meeting) ws.send(JSON.stringify({ type: 'transcript', meeting: key,
          confirmed: journal.view(meeting).segments.filter(segment => segment.completed) }));
      }
    } } catch { /* */ } });
    ws.on('close', () => { liveClients.delete(ws); liveSubjects.delete(ws); });
  });
  const revisionTimer = setInterval(() => {
    try {
      const speakerMeetings = new Set<string>();
      for (const row of journal.pendingRevisions()) {
        const message = JSON.stringify(row.event);
        for (const [client, keys] of liveClients) if (client.readyState === WebSocket.OPEN
            && (keys.size === 0 || keys.has(row.meeting)) && canAccess(liveSubjects.get(client) || '', row.meeting, 'read')) {
          client.send(message);
        }
        if (row.event.type === 'speaker.revised') speakerMeetings.add(row.meeting);
        journal.acknowledgeRevision(row.id);
      }
      for (const key of speakerMeetings) {
        const meeting = meetings.get(key); if (!meeting) continue;
        // Omit pending so metadata-only speaker refreshes retain the forming audio draft.
        const message = JSON.stringify({ type: 'transcript', meeting: key,
          confirmed: journal.view(meeting).segments.filter(segment => segment.completed) });
        for (const [client, keys] of liveClients) if (client.readyState === WebSocket.OPEN && (keys.size === 0 || keys.has(key))
            && canAccess(liveSubjects.get(client) || '', key, 'read')) client.send(message);
      }
    } catch (error) { console.error('[desktop] Revision delivery failed; durable outbox will retry', error); }
  }, 500);
  await new Promise<void>((r) => gateway.listen(opts.gatewayPort ?? 8056, DESKTOP_HOST, () => r()));
  const gatewayPort = (gateway.address() as { port: number }).port;

  // ── ingest (capture.v1 → gmeet-pipeline → broadcast) ──
  const ingest = new WebSocketServer({ port: opts.ingestPort ?? 9099, host: DESKTOP_HOST });
  await new Promise<void>((r) => ingest.on('listening', () => r()));
  const ingestPort = (ingest.address() as { port: number }).port;
  ingest.on('connection', async (ws, req) => {
    const url = new URL(req.url || '', 'http://localhost');
    const platform = url.searchParams.get('platform') || 'unknown';
    const native = url.searchParams.get('native_meeting_id') || '?';
    const language = url.searchParams.get('language');
    const key = keyOf(platform, native);
    let selected;
    let captureSubject = identity?.apiKey || '';
    try {
      const h = req.headers['x-api-key'];
      captureSubject = (Array.isArray(h) ? h[0] : h) || url.searchParams.get('api_key') || identity?.apiKey || '';
      selected = await selectedTranscription(captureSubject);
      if (['sherpa', 'funasr'].includes(selected.summary.backend)) {
        try {
          const health = await fetch(new URL('/health', selected.url), {
            headers: selected.token ? { Authorization: `Bearer ${selected.token}` } : {},
            signal: AbortSignal.timeout(3000), redirect: 'error',
          });
          if (!health.ok) throw new Error('not ready');
        } catch { throw new TranscriptionSettingsError(`The selected ${selected.summary.backend} service is not ready. Start it before capture.`); }
      }
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: error instanceof TranscriptionSettingsError ? error.message : 'ASR settings unavailable' }));
        ws.close(1008, 'Transcription settings unavailable');
      }
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const txClient = selected.url ? new TranscriptionClient({ source: 'extension', serviceUrl: selected.url, apiToken: selected.token, model: selected.model, sampleRate: SAMPLE_RATE, maxSpeechDurationSec: 15 }) : null;
    const clientSession = url.searchParams.get('client_session') || '';
    const acknowledgeAudio = url.searchParams.get('audio_ack') === AUDIO_ACK_MODE;
    let captureSession: string;
    try { captureSession = acknowledgeAudio ? journal.captureSession(key, clientSession) : randomUUID(); }
    catch { ws.send(JSON.stringify({type:'error',message:'Invalid client capture session'})); ws.close(1008); return; }
    const runtimeSession = acknowledgeAudio ? randomUUID() : captureSession;
    const toTx=(c:ChunkSegment,speaker:string,completed:boolean,channel=MIXED_CHANNEL)=>mixedSegment(runtimeSession,channel,c,speaker,completed);
    let freshAsrSession = false;
    try {
      if (selected.url) freshAsrSession = journal.registerAsrSession(key, captureSession, recovery.register(selected, identity ? captureSubject : ''), language || 'auto');
    } catch (error) { ws.send(JSON.stringify({type:'error',message:error instanceof Error ? error.message : 'Capture settings unavailable'})); ws.close(1008); return; }
    captureWork.add(runtimeSession);
    const releaseCapture = () => {
      audioTimeline.release(runtimeSession);
      if (audioRuntimeSessions.get(captureSession) === runtimeSession) { audioSessions.delete(captureSession); audioRuntimeSessions.delete(captureSession); }
      captureWork.delete(runtimeSession); recovery.kick();
    };
    let asrFailed = false;
    const sourceNames = new Map<number, string>();
    const engineFault = (error: unknown) => { asrFailed = true; reportFault(key, error); };
    const recordingResume = !!clientSession && recordingOwners.get(key) === clientSession;
    if (!recordingResume) recSink.close(key);
    recordingOwners.set(key, clientSession || randomUUID());
    const previousRecordingTimer = recordingReconnectTimers.get(key);
    if (previousRecordingTimer) { clearTimeout(previousRecordingTimer); recordingReconnectTimers.delete(key); }
    const meeting = resolve(platform, native);
    meeting.transcription = selected.summary;
    meeting.status = 'active';
    saveMeeting(meeting);
    audioSessions.set(captureSession,key);
    audioRuntimeSessions.set(captureSession,runtimeSession);
    let archiveFailed = false;
    const archive = (frame:TimedAudio) => {
      if (archiveFailed || acknowledgeAudio) return;
      const started=performance.now();
      try { journal.capture(key,captureSession,Number(frame.source),frame.captureMs,frame.samples,frame.startSample,frame.sourceCaptureMs,frame.clock,sourceNames.get(Number(frame.source))); }
      catch { metric(key).errors.storage++;archiveFailed = true; meeting.archive_error = 'Audio archive incomplete';
        try{saveMeeting(meeting);}catch{/* Preserve live ASR when the archive cannot persist its fault. */}
        reportFault(key, { source: 'archive', kind: 'write-failed', detail: meeting.archive_error }); }
      finally { metric(key).record('storage_write_ms',performance.now()-started); }
    };
    const timelineEvent=(event:AudioTimelineEvent)=>{
      event = {...event,session:captureSession};
      try{journal.timelineEvent(key,event);}catch{reportFault(key,{source:'archive',kind:'timeline-write-failed'});}
      telemetry.push({at:new Date().toISOString(),reason:'audio_timeline',body:{meeting:key,...event}});
      while(telemetry.length>TELEMETRY_MAX)telemetry.shift();
      if(event.kind==='source-limit')reportFault(key,{source:'buffer',kind:'source-limit',detail:'Audio source limit reached'});
    };
    const mixedFrame=(f:NonNullable<ReturnType<typeof decodeAudioFrame>>)=>{
      const accepted=audioTimeline.append({session:runtimeSession,source:String(f.speakerIndex),samples:f.samples,captureMs:f.ts,startSample:f.startSample});
      for(const event of accepted.events)timelineEvent(event);
      if(!accepted.frame)return null;
      archive(accepted.frame);
      const frame=accepted.frame,start=Math.max(frame.startSample,frame.endSample-audioTimeline.capacity);
      const read=audioTimeline.read(runtimeSession,frame.source,start,frame.endSample);
      return read.samples&&read.captureMs!==null?{...f,samples:read.samples,ts:read.captureMs}:null;
    };
    const policy = language && language !== 'auto' ? language : undefined;
    const lang = policy === 'vi-en' ? undefined : policy;
    const transcribe = async (pcm: Float32Array, prompt?: string, timing?: { capture_ms?: number }) => {
      if (!txClient) throw new Error('no STT (set TRANSCRIPTION_SERVICE_URL)');
      let result;
      const stats=metric(key), started=performance.now();stats.active++;
      stats.record('asr_audio_ms',pcm.length/16);if(timing?.capture_ms!=null)stats.record('capture_to_request_ms',timing.capture_ms);
      try { result = await txClient.transcribe(pcm, policy, prompt, timing); }
      catch (error) { stats.errors.asr++;asrFailed = true; throw error; }
      finally { stats.active--;stats.record('asr_http_ms',performance.now()-started); }
      if (result.language_review) {
        journal.saveLanguageReview(key, captureSession, pcm, result.language_review);
        reportFault(key, { source: 'stt', kind: 'language_review', detail: 'Đoạn âm thanh cần kiểm tra ngôn ngữ. Mở Saved transcripts → Transcript review.' });
      }
      return result;
    };
    const isMixed = MIXED_PLATFORMS.has(platform);

    // ── Raw-signal tape recorder (env-gated TINA_RECORD_TAPE=<dir>) ──
    // Append this session's VERBATIM capture.v1 ingest stream — binary audio frames
    // (ch999 mix / ch1000 mic / per-channel gmeet) + text event hints (active-speaker)
    // — to a JSONL tape, so any live bug can be replayed deterministically with no
    // meeting (eval.sh replay <tape>). A SECOND 'message' listener that never touches
    // the pipeline path. Off unless TINA_RECORD_TAPE is set.
    let tape: ReturnType<typeof createWriteStream> | null = null;
    const tapeDir = process.env.TINA_RECORD_TAPE;
    if (tapeDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tapePath = `${tapeDir}/tape-${platform}-${native}-${stamp}.jsonl`;
      tape = createWriteStream(tapePath);
      tape.write(JSON.stringify({ v: 1, platform, native, language: lang ?? null, startedAt: new Date().toISOString() }) + '\n');
      const tape0 = Date.now();
      ws.on('message', (data: any, isBinary: boolean) => {
        if (!tape) return;
        const t = Date.now() - tape0;
        if (isBinary) { const b = Buffer.from(data); tape.write(JSON.stringify({ t, bin: true, d: b.toString('base64') }) + '\n'); }
        else tape.write(JSON.stringify({ t, bin: false, d: data.toString() }) + '\n');
      });
      log(`[desktop] ⏺ recording raw tape → ${tapePath}`);
    }

    // ── MIXED lane (zoom/teams/youtube): one mixed remote stream (ch 999) + the local "You" mic
    //    (ch 1000), each its OWN ChunkedTranscriber. pyannote cuts; the speaker is the max-overlap
    //    active-speaker HINT (event frames → recordHint). No per-channel streams, no diarization. ──
    let tc: ChunkedTranscriber | null = null, micTc: ChunkedTranscriber | null = null;
    // ── GMEET lane (per-channel): the glow name rides the audio frame; the pipeline routes by channel. ──
    let pipe: ReturnType<typeof createGmeetPipeline> | null = null;

    // seg_N is the pipeline's PROVISIONAL cluster id (an as-yet unattributed turn). On
    // YouTube (single upstream, no participant identities) that placeholder is the intended
    // label — it shows how segments split. On Teams/Zoom an unattributed turn must publish
    // an EMPTY speaker, never a seg_N (a wrong identity leaking through). Map at the wire
    // only; seg_N stays the internal key for late re-resolution / repaint.
    const showSp = (sp: string) => (platform !== 'youtube' && /^seg_\d+$/.test(sp)) ? '' : sp;

    try {
      if (isMixed && txClient) {
        tc = await ChunkedTranscriber.create({
          language: lang, transcribe,
          publish: (sp, conf, pend) => { const s = showSp(sp); broadcastBatch(key, s, conf.map((c) => toTx(c, s, true)), pend.map((c) => toTx(c, s, false)), captureSession); },
          publishPending: (sp, pend) => { const s = showSp(sp); broadcastBatch(key, s, [], pend.map((c) => toTx(c, s, false))); },
          clearPending: (sp) => broadcastBatch(key, showSp(sp), [], []),
          rename: (_old, next, segs) => { const s = showSp(next); broadcastBatch(key, s, segs.map((c) => toTx(c, s, true)), [], captureSession); },
          log: (m) => log(`  ${m}`),
          onError: engineFault,   // P18: STT/engine fault → observable health frame
        });
        micTc = await ChunkedTranscriber.create({
          language: lang, transcribe,
          publish: (_s, conf, pend) => broadcastBatch(key, 'You', conf.map((c) => toTx(c, 'You', true, MIC_CHANNEL)), pend.map((c) => toTx(c, 'You', false, MIC_CHANNEL)), captureSession),
          publishPending: (_s, pend) => broadcastBatch(key, 'You', [], pend.map((c) => toTx(c, 'You', false, MIC_CHANNEL))),
          clearPending: () => broadcastBatch(key, 'You', [], []),
          rename: () => { /* the local mic is always "You" */ },
          log: () => { /* quiet */ },
          onError: engineFault,   // P18
        });
      } else {
        pipe = createGmeetPipeline({
          timeline:audioTimeline,sessionId:runtimeSession,onAudioFrame:archive,onTimelineEvent:timelineEvent,
          transcribe:txClient?transcribe:undefined,
          config: { sampleRate: SAMPLE_RATE, minAudioDuration: 2, submitInterval: 1.5, confirmThreshold: 3, maxBufferDuration: 30, idleTimeoutSec: 15 },
          sink: { segment: (t) => broadcast(key, t, captureSession), draft: (t) => { if (t.text.trim()) broadcast(key, t); }, finalize: () => { /* live */ } },
          onError: engineFault,   // P18: STT/engine fault → observable health frame
        });
      }
    } catch (error) {
      try { await tc?.dispose(); await micTc?.dispose(); } catch { /* Recovery retains the source. */ }
      releaseCapture(); engineFault(error); ws.close(1011, 'Capture engine initialization failed'); return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      try { await tc?.dispose(); await micTc?.dispose(); await pipe?.dispose(); } catch (error) { engineFault(error); } finally { releaseCapture(); }
      return;
    }
    let mixF = 0, micF = 0, evHints = 0, recF = 0;
    const hb = isMixed ? setInterval(() => log(`  [hb ${key}] ch999=${mixF}f ch1000=${micF}f hints=${evHints} rec=${recF}`), 5000) : null;
    // P18 liveness (server-side): a connected session NOT receiving audio frames is the
    // desktop's own "active but silent" — surface it as a 'no-signal' fault on the observable
    // channels (/ws health · /telemetry · log), so absence is reported, not invisible. Mirrors
    // the extension's client-side capture-liveness; here it's the receiver's view.
    const NO_SIGNAL_MS = opts.noSignalMs ?? (Number(process.env.TINA_NO_SIGNAL_MS) || 8000);
    const sessionStartMs = Date.now();
    let lastFrameMs = 0;
    const watchdog = setInterval(() => {
      if (finished) return;
      const since = Date.now() - (lastFrameMs || sessionStartMs);
      if (since > NO_SIGNAL_MS) reportFault(key, { source: 'capture', kind: 'no-signal', detail: `no audio frames for ${Math.round(since / 1000)}s — capture not flowing (stream not minted / muted / no speakers?)` });
    }, Math.max(250, Math.min(3000, NO_SIGNAL_MS)));
    log(`[desktop] ▶ ${key} (${isMixed ? 'mixed' : 'gmeet'})`);
    ws.send(JSON.stringify({ type:'ready',audio_ack:acknowledgeAudio?AUDIO_ACK_MODE:undefined,recording_ack:true,recording_resume:recordingResume,audio_timeline:'sample-index.v1',capture_session:captureSession,meeting_id:meeting.id,transcription: selected.summary }));
    // recording.v1 branch — try decodeRecordingChunk FIRST on every binary frame.
    // It returns null on a capture AUDIO frame (the REC1-magic is the built-in
    // discriminator), non-null on a recording chunk → route to the RecordingSink
    // and report handled, so the audio path is skipped. Same wire, two frame types.
    const tryRecording = (b: Buffer): boolean => {
      const r = decodeRecordingChunk(b.buffer, b.byteOffset, b.byteLength);
      if (!r) return false;
      recF++;
      recSink.chunk(key, r.seq, r.isFinal, r.format, r.bytes);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'recording-ack',seq:r.seq,isFinal:r.isFinal}));
      return true;
    };
    ws.on('message', (data: any, isBinary: boolean) => {
      if (isBinary) {
        const bytes = Buffer.from(data);
        if (tryRecording(bytes)) return;
        let frame = decodeAudioFrame(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (!frame) return;
        let ack: AudioSampleAck | null = null;
        if (acknowledgeAudio) {
          const writeStarted=performance.now();
          try {
            if (frame.startSample === undefined) throw new Error('Sample index required');
            const receipt = journal.receivePcm(key, captureSession, frame.speakerIndex, frame.startSample, frame.ts, frame.samples, frame.speakerName);
            ack = {type:'audio-ack',capture_session:captureSession,source:frame.speakerIndex,start_sample:frame.startSample,end_sample:frame.startSample+frame.samples.length};
            if (receipt.duplicate) { ws.send(JSON.stringify(ack)); return; }
            frame = {...frame,ts:receipt.captureMs};
          } catch {
            metric(key).errors.storage++;meeting.archive_error = 'PCM frame could not be saved or conflicts with an existing range'; saveMeeting(meeting);
            reportFault(key,{source:'archive',kind:'pcm-receipt-failed',detail:meeting.archive_error});
            ws.send(JSON.stringify({type:'error',message:meeting.archive_error})); ws.close(1011); return;
          } finally { metric(key).record('storage_write_ms',performance.now()-writeStarted); }
        }
        if (frame.speakerName) sourceNames.set(frame.speakerIndex, frame.speakerName);
        lastFrameMs = Date.now();
        if (isMixed) {
          let accepted=null;
          try { accepted=mixedFrame(frame); } catch { reportFault(key,{source:'capture',kind:'invalid-frame'}); }
          if (accepted?.speakerIndex === MIXED_CHANNEL) { mixF++; tc?.feedAudio(accepted.samples, accepted.ts); }
          else if (accepted?.speakerIndex === MIC_CHANNEL) { micF++; micTc?.feedAudio(accepted.samples, accepted.ts); }
          else if (accepted && isArchiveOnlyCaptureSource(accepted.speakerIndex)) { /* Original AEC mic is archived, never transcribed. */ }
        } else if (isArchiveOnlyCaptureSource(frame.speakerIndex)) {
          try { mixedFrame(frame); } catch { reportFault(key,{source:'capture',kind:'invalid-frame'}); }
        } else pipe?.feedAudio(frame.speakerIndex,frame.speakerIndex===MIC_CHANNEL?'You':frame.speakerName,frame.samples,frame.ts,undefined,frame.startSample);
        if (ack && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
      } else if (isMixed) {
        try { const ev = JSON.parse(data.toString()); if (ev?.kind === 'active-speaker' && ev.speaker) { evHints++; tc?.recordHint(ev.speaker, (ev.detail?.hint as HintKind) || 'dom-active', ev.ts ?? ev.tMs ?? 0, !!ev.detail?.isEnd); } } catch { /* Ignore malformed hints. */ }
      }
    });
    let finished = false;
    let finishTask: Promise<void> | null = null;
    const finish = (closeRecording = false): Promise<void> => {
      if (finishTask) return finishTask;
      finished = true;
      finishTask = (async () => {
        const ownsSession = activeSessions.get(key) === finalize;
        if (ownsSession) activeSessions.delete(key);
        if (hb) clearInterval(hb); clearInterval(watchdog); tape?.end();
        if (closeRecording) { recSink.close(key); recordingOwners.delete(key); }
        else if (ownsSession) {
          // The same recorder continues through a short socket interruption, with unchanged chunk seqs.
          const timer = setTimeout(() => { recordingReconnectTimers.delete(key); recordingOwners.delete(key); recSink.close(key); }, 30000);
          recordingReconnectTimers.set(key, timer);
        }
        try { await tc?.dispose(); await micTc?.dispose(); await pipe?.dispose(); } catch { asrFailed = true; }
        if (freshAsrSession && !asrFailed && !meeting.archive_error && audioRuntimeSessions.get(captureSession) === runtimeSession) {
          try { journal.finishAsrCapture(captureSession); } catch { reportFault(key, {source:'stt',kind:'recovery-pending',detail:'ASR checkpoint could not be saved; audio retained.'}); }
        }
        releaseCapture();
        const m = meetings.get(key); if (m && !activeSessions.has(key)) { m.status = 'completed'; saveMeeting(m); } log(`[desktop] ■ ${key}`);
      })();
      captureFinishes.add(finishTask);
      void finishTask.then(() => captureFinishes.delete(finishTask!), () => captureFinishes.delete(finishTask!));
      return finishTask;
    };
    // The finalizer the gateway's /extension/sessions/end calls: finish the
    // pipeline (flush + mark completed) AND drop the socket so the client's WS
    // tears down too. finish() is idempotent, so the subsequent 'close' is a no-op.
    const finalize = async () => { try { ws.close(); } catch { /* */ } await finish(true); };
    activeSessions.set(key, finalize);
    ws.on('close', () => void finish());
    ws.on('error', () => void finish());
  });

  log(`[desktop] ingest ws://127.0.0.1:${ingestPort}/ingest · gateway http://127.0.0.1:${gatewayPort} · STT ${TX_URL || 'NONE'} (${TX_MODEL}) · recordings ${recordingsDir}`);
  return {
    ingestPort, gatewayPort, recordingsDir,
    close: async () => {
      clearInterval(revisionTimer);
      await recovery.close();
      await aligner.close();
      await refiner.close();
      await diarizer.close();
      await Promise.all([...activeSessions.values()].map(finalize => finalize()));
      await Promise.allSettled([...captureFinishes]);
      for (const [key,timer] of recordingReconnectTimers) { clearTimeout(timer); recSink.close(key); }
      recordingReconnectTimers.clear(); recordingOwners.clear();
      for (const c of wss.clients) c.terminate();
      wss.close();
      ingest.close();
      gateway.closeAllConnections?.();   // force-drop keep-alive (fetch) conns so close() resolves
      await new Promise<void>((r) => gateway.close(() => r()));
      journal.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDesktop().catch((e) => { console.error(e); process.exit(1); });
}
