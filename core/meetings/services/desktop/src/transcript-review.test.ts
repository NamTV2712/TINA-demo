import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { encodeAudioFrame } from '@tina/capture-codec';
import { startDesktop } from './desktop.js';

const directory = mkdtempSync(join(tmpdir(), 'tina-review-'));
const stt = createServer(async (req, res) => {
  for await (const _ of req) { /* drain mock WAV */ }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ text: 'API thứ sáu', segments: [{ start: 0, end: 2, text: 'API thứ sáu' }] }));
});
await new Promise<void>(resolve => stt.listen(0, '127.0.0.1', resolve));
const options = { ingestPort: 0, gatewayPort: 0, quiet: true, recordingsDir: directory,
  txUrl: `http://127.0.0.1:${(stt.address() as { port: number }).port}` };
let desktop = await startDesktop(options);
try {
  let base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/desktop/review`;
  const ws = new WebSocket(`ws://127.0.0.1:${desktop.ingestPort}/ingest?platform=desktop&native_meeting_id=review`);
  assert.equal(JSON.parse(String((await once(ws, 'message'))[0])).type, 'ready');
  assert.equal((await fetch(base + '/refinement/start', { method: 'POST' })).status, 409);
  const before = Date.now();
  for (let i = 0; i < 20; i++) ws.send(Buffer.from(encodeAudioFrame(1000, before + i * 100, new Float32Array(1600).fill(0.0005), 'You')));
  await new Promise(resolve => setTimeout(resolve, 20));
  const end = await fetch(`http://127.0.0.1:${desktop.gatewayPort}/extension/sessions/end`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'desktop', native_meeting_id: 'review' }) });
  assert.equal(end.status, 200);
  let doc = await (await fetch(base + '/document')).json() as any;
  assert.equal(doc.status, 'completed');
  assert.equal(doc.segments.length, 1);
  const segment = doc.segments[0];
  assert.equal(segment.audio.length, 1);
  assert.equal(segment.audio[0].chunk_count, 20);
  const audio = await fetch(`${base}/segments/${encodeURIComponent(segment.segment_id)}/audio`);
  assert.equal(audio.status, 200);
  assert.equal((await audio.arrayBuffer()).byteLength, 44 + 32000 * 4);
  const patch = (revision: number, text: string | null) => fetch(`${base}/segments/${encodeURIComponent(segment.segment_id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: revision, text }) });
  assert.equal((await patch(0, 'API thứ Sáu.')).status, 200);
  assert.equal((await patch(0, 'stale edit')).status, 409);
  assert.equal((await fetch(base + '/document', { headers: { Origin: 'https://unrelated.test' } })).status, 403);
  await desktop.close(); desktop = await startDesktop(options);
  base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/desktop/review`;
  doc = await (await fetch(base + '/document')).json() as any;
  assert.equal(doc.segments[0].raw_text, 'API thứ sáu');
  assert.equal(doc.segments[0].text, 'API thứ Sáu.');
  assert.equal(doc.segments[0].revision, 1);
  assert.equal(doc.segments[0].audio.length, 1);
  assert.equal(doc.segments[0].audio[0].chunk_count, 20);
  assert.equal((await patch(1, null)).status, 200);
  assert.equal((await (await fetch(base)).json() as any).segments[0].text, 'API thứ sáu');
  assert.equal((await fetch(base + '/review')).status, 200);
  const unicodeBody = JSON.stringify({ expected_revision: 2, text: 'ừ'.repeat(10000) }).replace(/ừ/g, '\\u1eeb');
  assert.ok(unicodeBody.length > 45000);
  assert.equal((await fetch(`${base}/segments/${encodeURIComponent(segment.segment_id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: unicodeBody })).status, 200);
  assert.equal((await patch(3, null)).status, 200);

  assert.equal((await fetch(base + '/refinement/start', { method: 'POST', headers: { Origin: 'https://unrelated.test' } })).status, 403);
  assert.equal((await fetch(base + '/refinement/start', { method: 'POST' })).status, 202);
  let job: any;
  for (let i = 0; i < 100; i++) {
    job = await (await fetch(base + '/refinement')).json();
    if (job.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'completed');
  assert.equal(job.items[0].state, 'ready');
  assert.equal((await (await fetch(base + '/document')).json() as any).segments[0].revision, 4);
  const apply = (expected_revision: number) => fetch(base + '/refinement/apply', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: job.id, segment_id: segment.segment_id, expected_revision }) });
  assert.equal((await apply(0)).status, 409);
  assert.equal((await fetch(base + '/refinement/apply', { method: 'POST', body: 'null' })).status, 422);
  assert.equal((await apply(4)).status, 200);
  assert.equal((await (await fetch(base + '/document')).json() as any).segments[0].history.at(-1).kind, 'refinement');

  await desktop.close();
  desktop = await startDesktop({ ...options, canAccess: () => false });
  base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/desktop/review`;
  assert.equal((await fetch(base + '/document')).status, 403);
  assert.equal((await patch(4, 'forbidden')).status, 403);
  assert.equal((await fetch(`${base}/audio/${segment.audio[0].chunk_id}`)).status, 403);
  assert.equal((await fetch(base + '/refinement')).status, 403);
  for (const action of ['start', 'cancel', 'apply']) assert.equal((await fetch(base + '/refinement/' + action, { method: 'POST' })).status, 403);
  await desktop.close(); desktop = await startDesktop({ ...options, canAccess: (_s, _r, action) => action === 'read' });
  base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/desktop/review`;
  assert.equal((await (await fetch(base + '/refinement')).json() as any).items[0].state, 'applied');
  assert.equal((await fetch(base + '/refinement/start', { method: 'POST' })).status, 403);
  console.log('PASS review HTTP: real capture → disk → restart → document/audio, correction/restore, stale revision and authorization');
} finally {
  await desktop.close();
  stt.closeAllConnections(); await new Promise<void>(resolve => stt.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
