import assert from 'node:assert/strict';
import { TranscriptionClient } from './transcription-client.js';

const realFetch = globalThis.fetch;
const pcm = new Float32Array(32000).fill(.01);
const client = new TranscriptionClient({ serviceUrl: 'http://asr.test', maxRetries: 0 });
try {
  const bodies: string[] = [];
  let results: any[] = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(Buffer.from(options!.body as Buffer).toString());
    const result = results.shift();
    return result instanceof Response ? result : Response.json(result);
  };
  results = [{ text: 'Xin chào, deadline is Friday.', language: 'Vietnamese', segments: [] }];
  assert.equal((await client.transcribe(pcm, 'vi-en')).text, 'Xin chào, deadline is Friday.');
  assert.ok(!bodies[0].includes('name="language"'));
  assert.ok(!bodies[0].includes('vi-en'));
  results = [{ text: '你说的什么', language: 'Chinese', segments: [] }, { text: 'Friday.', language: 'Vietnamese', segments: [] }];
  const held = await client.transcribe(pcm, 'vi-en', 'Nội dung trước đó');
  assert.equal(held.text, ''); assert.deepEqual(held.segments, []);
  assert.equal(held.language_review?.original.text, '你说的什么');
  assert.equal(held.language_review?.retry?.text, 'Friday.');
  assert.ok(bodies.at(-1)!.includes('\r\nvi\r\n'));
  assert.ok(!bodies.at(-1)!.includes('name="prompt"'));
  results = [{ text: '你好', language: 'unknown', segments: [] }, new Response('unavailable', { status: 503 })];
  const failedRetry = await client.transcribe(pcm, 'vi-en');
  assert.equal(failedRetry.text, '');
  assert.equal(failedRetry.language_review?.retry_error, 'unavailable');
  results = [{ text: '你好', language: 'Chinese', segments: [] }];
  assert.equal((await client.transcribe(pcm)).text, '你好');
  results = [{ text: '', language: 'unknown', segments: [] }];
  assert.equal((await client.transcribe(pcm, 'vi-en')).language_review, undefined);
  console.log('PASS language policy: bilingual, non-Latin, raw preservation, held retry, auto unchanged');
} finally { globalThis.fetch = realFetch; }
