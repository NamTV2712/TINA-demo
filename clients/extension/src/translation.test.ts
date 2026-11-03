import assert from 'node:assert/strict';
import { watchTranslation, translationSegments, type TranslationGroup } from './translation';

const source = [{ segment_id: 'a', text: 'Mục tiêu', absolute_start_time: '2026-11-03T08:00:00Z', absolute_end_time: '2026-11-03T08:00:01Z' },
  { segment_id: 'b', text: 'là tối ưu mô hình.', absolute_start_time: '2026-11-03T08:00:01Z', absolute_end_time: '2026-11-03T08:00:02Z' }];
const phrase: TranslationGroup = { group_id: 'phrase:a', members: source.map(row => ({ segment_id: row.segment_id, source_text: row.text })),
  source_text: 'Mục tiêu là tối ưu mô hình.', translated_text: 'The goal is to optimize the model.', ready: true,
  speaker_id: 'nam', speaker_name: 'Nam', start_ms: Date.parse(source[0].absolute_start_time), end_ms: Date.parse(source[1].absolute_end_time) };
const projected = translationSegments(source, [phrase]);
assert.equal(projected.length, 1);
assert.equal(projected[0].text, phrase.source_text);
assert.equal(projected[0].translation?.text, phrase.translated_text);
assert.equal(projected[0].absolute_end_time, '2026-11-03T08:00:02.000Z');
assert.equal(translationSegments([source[0], { ...source[1], text: 'Đã sửa.' }], [phrase]).some(s => s.translation), false);
assert.equal(translationSegments(source, [{ ...phrase, ready: false, translated_text: null }])[0].translation?.ready, false);

const calls: { url: string; init: RequestInit }[] = [];
const original = globalThis.fetch;
let completed = false;
globalThis.fetch = async (input, init = {}) => {
  calls.push({ url: String(input), init });
  if (init.method === 'POST') completed = true;
  return Response.json({ version: 'meeting-translation.v2', meeting_id: 6, status: completed ? 'complete' : 'pending', total: 1,
    completed: Number(completed), retry_after: 0, groups: [{ ...phrase, translated_text: completed ? phrase.translated_text : null }] });
};
try {
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const stop = watchTranslation({ botGatewayUrl: 'http://127.0.0.1:18056', apiKey: 'tina-test-only' }, 6,
    state => { if (state.completed) done(); }, () => assert.fail('Unexpected translation error'));
  await finished;
  stop();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://127.0.0.1:18056/agent/meeting-translations/6');
  assert.equal(calls[1].init.credentials, 'omit');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal((calls[1].init.headers as Record<string, string>)['X-API-Key'], 'tina-test-only');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { retry: false, segment_ids: [] });
  console.log('translation shared-cache client passed');
} finally { globalThis.fetch = original; }
