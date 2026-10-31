import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscriptJournal } from './transcript-journal.js';
import { startDesktop } from './desktop.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { encodeAudioFrame } from '@tina/capture-codec';

const directory = mkdtempSync(join(tmpdir(), 'tina-language-review-'));
const key = 'youtube/language-review';
const path = join(directory, 'transcripts.sqlite');
const pcm = new Float32Array(32000).fill(.01);
let journal = new TranscriptJournal(path);
try {
  journal.save({ id: 1, platform: 'youtube', native_meeting_id: 'language-review', status: 'completed', start_time: new Date().toISOString(), segments: [] });
  const review = { status: 'pending' as const, policy: 'vi-en' as const,
    original: { text: '你说的什么', language: 'Chinese', duration: 2, segments: [] },
    retry: { text: 'Review suggestion', language: 'English', duration: 2, segments: [] } };
  journal.saveLanguageReview(key, 'capture', pcm, review);
  journal.saveLanguageReview(key, 'capture', pcm, review);
  assert.equal(journal.languageReviews(key).length, 1);
  assert.throws(() => journal.saveLanguageReview(key, 'capture', new Float32Array([NaN]), review));
  journal.close(); journal = new TranscriptJournal(path);
  const item = journal.languageReviews(key)[0] as any;
  assert.equal(item.original.text, review.original.text);
  assert.equal(journal.languageReviewAudio(key, item.id)!.readFloatLE(44), pcm[0]);
  assert.equal(journal.languageReviewAudio('youtube/other', item.id), null);
  journal.close();
  const desktop = await startDesktop({ gatewayPort: 0, ingestPort: 0, recordingsDir: directory, quiet: true, canAccess: subject => subject !== 'denied' });
  try {
    const base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/${key}`;
    assert.equal((await (await fetch(base + '/asr-reviews')).json() as any).items.length, 1);
    assert.equal((await (await fetch(base)).json() as any).segments.length, 0);
    for (const route of ['/asr-reviews', `/asr-reviews/${item.id}/audio`]) {
      assert.equal((await fetch(base + route, { headers: { 'X-API-Key': 'denied' } })).status, 403);
      assert.equal((await fetch(base + route, { headers: { Origin: 'https://foreign.test' } })).status, 403);
    }
    assert.equal((await fetch(base + `/asr-reviews/${item.id}/audio`)).status, 200);
    assert.ok((await (await fetch(base + '/review')).text()).includes('Chờ kiểm tra ngôn ngữ'));
  } finally { await desktop.close(); }
  const stt = createServer(async (req, res) => {
    for await (const _ of req) { /* consume WAV */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: '你说的什么', language: 'Chinese', duration: 2, segments: [{ text: '你说的什么', start: 0, end: 2 }] }));
  });
  stt.listen(0, '127.0.0.1'); await once(stt, 'listening');
  const live = await startDesktop({ gatewayPort: 0, ingestPort: 0, recordingsDir: directory, quiet: true,
    txUrl: `http://127.0.0.1:${(stt.address() as any).port}` });
  const ws = new WebSocket(`ws://127.0.0.1:${live.ingestPort}/ingest?platform=desktop&native_meeting_id=held&language=vi-en`);
  try {
    const [ready] = await once(ws, 'message'); assert.equal(JSON.parse(String(ready)).type, 'ready');
    const start = Date.now();
    for (let i = 0; i < 20; i++) ws.send(Buffer.from(encodeAudioFrame(1000, start + i * 100, new Float32Array(1600).fill(.001), 'You')));
    await new Promise(r => setTimeout(r, 50));
    const base = `http://127.0.0.1:${live.gatewayPort}`;
    await fetch(base + '/extension/sessions/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'desktop', native_meeting_id: 'held' }) });
    const held = await (await fetch(base + '/transcripts/desktop/held/asr-reviews')).json() as any;
    assert.ok(held.items.length > 0); assert.equal(held.items[0].original.text, '你说的什么');
    assert.equal((await (await fetch(base + '/transcripts/desktop/held')).json() as any).segments.length, 0);
  } finally { ws.terminate(); await live.close(); await new Promise<void>(r => stt.close(() => r())); }
  console.log('PASS language review: deduplication, restart, source PCM, owner/origin isolation, no canonical text');
} finally { try { journal.close(); } catch {} rmSync(directory, { recursive: true, force: true }); }
