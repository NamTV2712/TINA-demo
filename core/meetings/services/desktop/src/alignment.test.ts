import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { WebSocket } from 'ws';
import { startDesktop, type Meeting } from './desktop.js';
import { TranscriptJournal } from './transcript-journal.js';
import { DesktopAligner } from './alignment.js';
import { alignmentHash, validateAlignment } from './alignment-model.js';
import { transcriptReviewPage } from './transcript-review.js';

const dir = mkdtempSync(join(tmpdir(), 'tina-alignment-')), path = join(dir, 'transcripts.sqlite');
const epoch = 1800000000000, key = 'desktop/alignment-test';
const segment = (id: string, channel: number, start: number, end: number, text: string, completed = true) => ({
  segment_id: id, speaker_key: `ch-${channel}:${id}`, speaker: channel === 1000 ? 'You' : 'System audio', text, start: epoch / 1000 + start, end: epoch / 1000 + end, completed,
});
const meeting: Meeting = { id: 1, platform: 'desktop', native_meeting_id: 'alignment-test', status: 'completed', start_time: new Date(epoch).toISOString(), segments: [
  segment('local', 1000, 0, 1, 'Tôi sẽ gửi report'), segment('remote', 999, 0, 1, 'We agreed to ship'),
  segment('gap', 2, 0, 2, 'Currently the audio has gaps'), segment('draft', 1000, 1, 2, 'I will stay draft', false), segment('raw', 1002, 0, 1, 'I will stay raw'),
] };
const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
const validate = (name: string, value: unknown) => {
  const schema = JSON.parse(readFileSync(new URL(`../../../contracts/${name}.v1/${name}.schema.json`, import.meta.url), 'utf8'));
  const check = ajv.getSchema(schema.$id) || ajv.compile(schema); assert(check(value), JSON.stringify(check.errors));
};
let journal = new TranscriptJournal(path); journal.save(meeting);
const capture = journal.captureSession(key, 'one');
for (const channel of [999, 1000, 1002]) journal.receivePcm(key, capture, channel, 0, epoch, new Float32Array(32000).fill(channel === 1000 ? .2 : .1));
journal.receivePcm(key, capture, 2, 0, epoch, new Float32Array(8000).fill(.1));
journal.receivePcm(key, capture, 2, 16000, epoch + 1000, new Float32Array(16000).fill(.1));
assert.equal(journal.alignmentSource(meeting, 'gap'), null); assert.equal(journal.alignmentSource(meeting, 'raw'), null); assert.equal(journal.alignmentSource(meeting, 'draft'), null);
const input = journal.alignmentSource(meeting, 'local')!;
const resultFor = (audio: Buffer, text: string) => ({ model: 'fixture-mfa', audio_sha256: alignmentHash(audio), text_sha256: alignmentHash(text), duration_ms: (audio.length - 44) / 32,
  words: text.split(/\s+/u).map((text, index) => ({ index, text, start_ms: text === 'report' ? null : index * 200, end_ms: text === 'report' ? null : index * 200 + 180, aligned: text !== 'report' })) });
assert.equal(validateAlignment(resultFor(input.audio, input.text), input.audio, input.text).words!.at(-1)!.aligned, false);
for (const mutate of [
  (r: any) => { r.audio_sha256 = '0'.repeat(64); }, (r: any) => { r.text_sha256 = '0'.repeat(64); },
  (r: any) => { r.words[0].text = 'invented'; }, (r: any) => { r.words[0].start_ms = NaN; },
  (r: any) => { r.words[1].start_ms = -1; }, (r: any) => { r.words[1].end_ms = 5000; },
  (r: any) => { r.words.at(-1).start_ms = 0; }, (r: any) => { r.words[1].end_ms = 100; },
]) { const bad = resultFor(input.audio, input.text); mutate(bad); assert.throws(() => validateAlignment(bad, input.audio, input.text)); }
journal.close();
let held = false, release: (() => void) | undefined, invalid = false, calls = 0;
const worker = createServer(async (req, res) => {
  assert.equal(req.url, '/align-batch'); assert.equal(req.headers.authorization, 'Bearer isolated-alignment-token');
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const request = new Request('http://fixture/align-batch', { method: 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) });
  const form = await request.formData(), texts = JSON.parse(String(form.get('texts')));
  const files = form.getAll('files') as File[]; assert.equal(files.length, texts.length);
  const results = await Promise.all(files.map(async (file, i) => resultFor(Buffer.from(await file.arrayBuffer()), texts[i])));
  calls++; if (held) await new Promise<void>(r => { release = r; });
  if (invalid) results[0].audio_sha256 = 'f'.repeat(64);
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ results }));
});
await new Promise<void>(r => worker.listen(0, '127.0.0.1', r));
const config = { url: `http://127.0.0.1:${(worker.address() as any).port}`, token: 'isolated-alignment-token' };
let desktop = await startDesktop({ ingestPort: 0, gatewayPort: 0, statePath: path, recordingsDir: dir, quiet: true, txUrl: config.url, alignment: config, canAccess: subject => subject !== 'denied' });
let base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/${key}`;
const request = async (url: string, method = 'GET', body?: object, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
  return { status: response.status, body: await response.json() as any };
};
const wait = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Timed out'); };
const finished = async () => { let job: any; await wait(async () => { job = (await request('/alignment')).body.job; return !['running', 'paused'].includes(job?.status); }); return job; };
let ws = new WebSocket(`ws://127.0.0.1:${desktop.gatewayPort}/ws`); const events: any[] = [];
ws.on('message', data => events.push(JSON.parse(String(data)))); await once(ws, 'open'); ws.send(JSON.stringify({ action: 'subscribe', meetings: [{ platform: 'desktop', native_id: 'alignment-test' }] }));
try {
  assert.equal((await request('/alignment', 'GET', undefined, { 'X-API-Key': 'denied' })).status, 403);
  assert.equal((await request('/alignment/start', 'POST', {}, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await request('/alignment/start', 'POST', { surprise: true })).status, 422);
  held = true; assert.equal((await request('/alignment/start', 'POST', {})).status, 202); await wait(() => Boolean(release));
  assert.equal((await request('/alignment/start', 'POST', {})).status, 409);
  assert.equal((await request('/diarization/start', 'POST', {})).status, 409);
  assert.equal((await request('/refinement/start', 'POST', {})).status, 409);
  assert.equal((await request('/segments/local', 'PATCH', { expected_revision: 0, text: 'Tôi sẽ gửi report mới' })).status, 200);
  held = false; release!(); release = undefined;
  let job = await finished(); assert.equal(job.items.find((i: any) => i.segment_id === 'local').state, 'stale');
  let canonical = (await request('/canonical')).body;
  assert.equal(canonical.segments.find((s: any) => s.segment_id === 'local').alignment.status, 'segment_fallback');
  assert.equal((await request('/alignment/start', 'POST', {})).status, 202); job = await finished();
  validate('transcript-alignment', (await request('/alignment')).body);
  assert.equal(job.items.length, 2); assert.equal(job.status, 'completed');
  canonical = (await request('/canonical')).body; validate('canonical-transcript', canonical); validate('meeting-memory', (await request('/memory')).body);
  const local = canonical.segments.find((s: any) => s.segment_id === 'local'); assert.equal(local.text, 'Tôi sẽ gửi report mới'); assert.equal(local.raw_text, 'Tôi sẽ gửi report');
  assert.equal(local.words[0].start_ms, epoch); assert.equal(local.words[3].aligned, false); assert.equal(local.words[3].start_ms, null);
  const wordPath = `/segments/local/aligned-audio?job_id=${job.id}&expected_revision=1&word_index=0`;
  let audio = await fetch(base + wordPath); assert.equal(audio.status, 200); const pcm = Buffer.from(await audio.arrayBuffer());
  assert.equal(pcm.length, 44 + 2880 * 2); assert.equal(pcm.readInt16LE(44), Math.round(.2 * 32767));
  assert.equal((await fetch(base + wordPath, { headers: { 'X-API-Key': 'denied' } })).status, 403);
  assert.equal((await fetch(base + wordPath.replace('word_index=0', 'word_index=3'))).status, 422);
  let registry = (await request('/speakers')).body, id = registry.segments.local.speaker_id;
  assert.equal((await request('/speakers/' + id, 'PATCH', { expected_revision: 1, name: 'Lan' })).status, 200);
  canonical = (await request('/canonical')).body; assert.equal(canonical.segments.find((s: any) => s.segment_id === 'local').words[0].speaker_name, 'Lan');
  assert.equal((await request('/segments/local', 'PATCH', { expected_revision: 1, text: null })).status, 200);
  assert.equal((await fetch(base + wordPath)).status, 409);
  canonical = (await request('/canonical')).body; assert.equal(canonical.segments.find((s: any) => s.segment_id === 'local').words.length, 0);
  await wait(() => events.some(e => e.kind === 'restore'));
  const seq = events.filter(e => e.segment_id === 'local' && e.type === 'transcript.revised');
  for (const e of seq) validate('transcript-revision', e);
  assert(seq.some(e => e.kind === 'alignment')); assert(seq.at(-1).revision > seq.find(e => e.kind === 'alignment').revision, 'text events remain newer than alignment events');
  invalid = true; await request('/alignment/start', 'POST', {}); job = await finished(); assert.equal(job.status, 'failed');
  assert.equal((await request('/canonical')).body.segments.find((s: any) => s.segment_id === 'local').words.length, 0);
  invalid = false; held = true; await request('/alignment/start', 'POST', {}); await wait(() => Boolean(release));
  await request('/alignment/cancel', 'POST', {}); held = false; release!(); release = undefined;
  assert.equal((await finished()).status, 'cancelled');
  assert.equal((await request('/canonical')).body.segments.find((s: any) => s.segment_id === 'local').words.length, 0);
  await request('/alignment/start', 'POST', {}); job = await finished(); assert.equal(job.status, 'completed');
  const accepted = (await request('/canonical')).body;
  ws.terminate(); await desktop.close();
  journal = new TranscriptJournal(path);
  const stored = journal.alignmentJob(key)!;
  journal.saveAlignmentJob(key, { ...stored, status: 'running' }); journal.close();
  desktop = await startDesktop({ ingestPort: 0, gatewayPort: 0, statePath: path, recordingsDir: dir, quiet: true, txUrl: '', alignment: config });
  base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/${key}`;
  canonical = (await request('/canonical')).body; assert.equal(canonical.revision, accepted.revision); assert.equal(canonical.segments.find((s: any) => s.segment_id === 'local').words[0].speaker_name, 'Lan');
  assert.equal((await request('/alignment')).body.job.status, 'interrupted', 'crashed jobs stop polling while published results survive');
  const html = transcriptReviewPage('/transcripts/desktop/alignment-test'); new Function(html.match(/<script>([\s\S]*)<\/script>/)![1]);
  assert(html.includes('Align words') && html.includes('aligned-audio'));
  // Overlapping source clocks invalidate old timing; no alternate session is guessed.
  journal = new TranscriptJournal(path);
  const overlapSession = journal.captureSession(key, 'ambiguous');
  journal.receivePcm(key, overlapSession, 1000, 0, epoch, new Float32Array(16000).fill(.3));
  assert.equal(journal.alignmentSource(meeting, 'local'), null);
  assert.equal(journal.canonical(meeting).segments.find(s => s.segment_id === 'local')!.words.length, 0);
  journal.close();
  // A long job yields between batches to live capture, then resumes.
  const pausedJournal = new TranscriptJournal(join(dir, 'paused.sqlite'));
  const many: Meeting = { ...meeting, native_meeting_id: 'batch-pause', segments: Array.from({ length: 21 }, (_, i) => segment('batch-' + i, 1000, 0, 1, 'Tôi sẽ gửi report')) };
  const manyKey = 'desktop/batch-pause'; pausedJournal.save(many);
  const manySession = pausedJournal.captureSession(manyKey, 'one'); pausedJournal.receivePcm(manyKey, manySession, 1000, 0, epoch, new Float32Array(16000).fill(.2));
  let live = true;
  const aligner = new DesktopAligner(pausedJournal, () => live, () => false, config);
  try {
    assert.throws(() => aligner.start(many), /Stop capture/);
    live = false; held = true; aligner.start(many); await wait(() => Boolean(release));
    live = true; held = false; release!(); release = undefined;
    await wait(() => aligner.current(manyKey).job?.status === 'paused');
    assert.equal(aligner.current(manyKey).job!.items.filter(i => i.state === 'aligned').length, 20);
    live = false; await wait(() => aligner.current(manyKey).job?.status === 'completed');
    const saved = pausedJournal.alignmentJob(manyKey)!;
    assert.equal(saved.items.filter(i => i.state === 'aligned').length, 21);
    const database = (pausedJournal as any).db;
    const before = database.prepare('SELECT document FROM alignment_results WHERE meeting=? AND segment=?').get(manyKey, 'batch-0').document;
    const newJob = { ...saved, status: 'running' as const, id: '00000000-0000-4000-8000-000000000099' }; pausedJournal.saveAlignmentJob(manyKey, newJob);
    database.exec("CREATE TRIGGER fail_alignment_event BEFORE INSERT ON transcript_outbox BEGIN SELECT RAISE(ABORT,'outbox failed'); END");
    assert.throws(() => pausedJournal.publishAlignment(many, newJob.id, saved.items[0]));
    assert.equal(database.prepare('SELECT document FROM alignment_results WHERE meeting=? AND segment=?').get(manyKey, 'batch-0').document, before, 'timing rolls back with failed outbox');
    database.exec('DROP TRIGGER fail_alignment_event');
  } finally { await aligner.close(); pausedJournal.close(); }
  console.log(`PASS alignment: ${calls} batch calls, PCM16, accepted tokens, OOV, source gaps, stale edits/Restore, speaker rename, audio playback, monotonic events, cancel, ACL, contracts, restart`);
} finally { release?.(); ws.terminate(); await desktop.close(); worker.closeAllConnections(); await new Promise<void>(r => worker.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
