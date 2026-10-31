import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { TranscriptJournal, RevisionConflict } from './transcript-journal.js';
import { TranscriptRefiner } from './refinement.js';
import type { Meeting } from './desktop.js';

const journal = new TranscriptJournal(':memory:');
let live = false, fail = false, calls = 0, delay = false, glossaryExpected = false;
let release: (() => void) | undefined;
const stt = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('latin1');
  assert.ok(!body.includes('name="language"')); assert.equal(body.includes('name="prompt"'), glossaryExpected); if (glossaryExpected) assert.ok(body.includes('Vocabulary: TINA, API'));
  assert.ok(body.includes('custom')); calls++;
  if (delay) await new Promise<void>(resolve => { release = resolve; });
  res.writeHead(fail ? 502 : 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ text: 'API sẽ deploy thứ Sáu.', segments: [] }));
});
await new Promise<void>(resolve => stt.listen(0, '127.0.0.1', resolve));
const refiner = new TranscriptRefiner(journal, () => live);
const key = 'desktop/refine';
const meeting: Meeting = { id: 1, platform: 'desktop', native_meeting_id: 'refine', status: 'completed',
  start_time: new Date().toISOString(), segments: [{ segment_id: 'one', speaker: 'You', text: 'api se deploy thu sau',
    speaker_key: 'ch-1000:one', start: 100, end: 101, completed: true }] };
const config = { url: `http://127.0.0.1:${(stt.address() as any).port}`, token: '', model: 'custom',
  summary: { backend: 'funasr', label: 'FunASR', model: 'custom', source: 'platform' as const } };
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('refinement did not settle');
};
const finish = async () => { await waitFor(() => !['running', 'paused', 'cancelling'].includes(refiner.current(key)!.status)); await new Promise(r => setTimeout(r, 5)); return refiner.current(key)!; };
try {
  journal.save(meeting); journal.capture(key, 'session', 1000, 100000, new Float32Array(16000).fill(0.01));
  glossaryExpected = true; refiner.start(meeting, config, ['TINA', 'API']); await finish(); glossaryExpected = false;
  assert.throws(() => refiner.start(meeting, config, ['x'.repeat(81)]), /vocabulary/);
  live = true; assert.throws(() => refiner.start(meeting, config), RevisionConflict); live = false;
  refiner.start(meeting, config);
  assert.throws(() => refiner.start(meeting, config), RevisionConflict);
  let job = await finish(); assert.equal(job.status, 'completed'); assert.equal(job.items[0].state, 'ready');
  assert.equal(journal.view(meeting).segments[0].text, 'api se deploy thu sau'); // preview only
  refiner.apply(meeting, job.id, 'one', 0);
  assert.equal(journal.view(meeting).segments[0].text, 'API sẽ deploy thứ Sáu.');
  const doc = journal.document(meeting) as any;
  assert.equal(doc.segments[0].raw_text, 'api se deploy thu sau');
  assert.equal(doc.segments[0].history[0].kind, 'refinement');
  assert.equal(doc.segments[0].history[0].audio_sha256.length, 64);
  assert.throws(() => refiner.apply(meeting, job.id, 'one', 0), RevisionConflict);
  journal.correct(key, meeting.segments[0], 1, null);
  assert.equal(journal.view(meeting).segments[0].text, 'api se deploy thu sau');
  refiner.start(meeting, config); job = await finish();
  journal.correct(key, meeting.segments[0], 2, 'Manual correction');
  assert.throws(() => refiner.apply(meeting, job.id, 'one', 2), RevisionConflict);
  assert.equal(journal.view(meeting).segments[0].text, 'Manual correction');
  refiner.start(meeting, config); job = await finish();
  journal.capture(key, 'session', 1000, 100000, new Float32Array(1600).fill(0.02));
  assert.throws(() => refiner.apply(meeting, job.id, 'one', 3), /Source audio changed/);
  // Pause at an utterance boundary when live capture starts, then resume.
  meeting.segments.push({ ...meeting.segments[0], segment_id: 'two' }); journal.save(meeting, meeting.segments[1]);
  delay = true; refiner.start(meeting, config); await waitFor(() => !!release); live = true; release!(); release = undefined;
  await waitFor(() => refiner.current(key)?.status === 'paused');
  refiner.cancel(key); await finish(); live = false; delay = false;
  assert.equal(refiner.current(key)?.status, 'cancelled'); assert.equal(refiner.current(key)?.items[1].state, 'pending');
  fail = true; refiner.start(meeting, config); job = await finish(); assert.equal(job.status, 'failed');
  assert.equal(job.items[0].state, 'failed'); assert.equal(journal.view(meeting).segments[0].text, 'Manual correction');
  fail = false;
  const saveJob = journal.saveRefinement.bind(journal); let writes = 0;
  journal.saveRefinement = job => { if (writes++ > 0) throw new Error('disk full'); saveJob(job); };
  refiner.start(meeting, config); job = await finish(); assert.equal(job.status, 'interrupted');
  assert.equal(journal.view(meeting).segments[0].text, 'Manual correction');
  journal.saveRefinement = saveJob;
  const noAudio = { ...meeting, native_meeting_id: 'legacy' }; journal.save(noAudio);
  refiner.start(noAudio, config);
  await waitFor(() => refiner.current('desktop/legacy')?.status === 'failed');
  assert.equal(refiner.current('desktop/legacy')?.items[0].state, 'skipped');
  assert.equal(calls, 8);
  console.log('PASS refinement: preview/apply/restore, provenance, CAS, failures, missing audio, single worker and live pause/cancel');
} finally {
  release?.(); await refiner.close(); journal.close(); stt.closeAllConnections();
  await new Promise<void>(resolve => stt.close(() => resolve()));
}
