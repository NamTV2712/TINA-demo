import assert from 'node:assert/strict';
import { SpeakerStreamManager } from './speaker-streams.js';
import { GmeetCompatibleBuffer } from '@tina/transcribe-buffer';
import { setLogger } from './log.js';

setLogger(() => {});
const SR = 16000, SID = 'ch-0:1', START = 100000;
const segment = (text: string, start: number, end: number) => ({ text, start, end });
const factories = [
  ['gmeet', () => new SpeakerStreamManager()],
  ['shared', () => new GmeetCompatibleBuffer({ scheduleSubmissions: false, now: () => 900000, log: () => {} })],
] as const;
let failures = 0;
for (const [name, create] of factories) {
  async function check(label: string, scenario: (manager: ReturnType<typeof create>) => Promise<void>) {
    const manager = create(); manager.addSpeaker(SID, 'Speaker');
    try { await scenario(manager); console.log(`PASS ${name}: ${label}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${label}: ${String(error)}`); }
    finally { manager.removeAll(); }
  }
  const answer = async (manager: ReturnType<typeof create>, text: string, segments: Array<ReturnType<typeof segment>>) => {
    await (manager as unknown as { trySubmit(id: string): Promise<void> }).trySubmit(SID);
    manager.handleTranscriptionResult(SID, text, segments.at(-1)!.end, segments, 'en');
  };
  for (const echoStart of [0, .09]) await check(`a copied prefix is cleared, not confirmed again (offset ${echoStart}s)`, async manager => {
    const confirmed: string[] = [];
    const drafts = new Map<number, string>();
    manager.onSegmentReady = () => {};
    manager.onSegmentPending = (_id, _name, text, start) => { if (text) drafts.set(start, text); else drafts.delete(start); };
    manager.onSegmentConfirmed = (_id, _name, text, start) => { confirmed.push(text); drafts.delete(start); };
    manager.feedAudio(SID, new Float32Array(SR * 5).fill(.1), START);
    await answer(manager, 'opening words new tail', [segment('opening words', 0, 1), segment('new tail', 1, 3)]);
    await answer(manager, 'opening words new tail grows', [segment('opening words', 0, 1), segment('new tail grows', 1, 4)]);
    assert.deepEqual(confirmed, ['opening words']);
    await answer(manager, 'opening words actual next', [segment('opening words', echoStart, echoStart + .58), segment('actual next', 1, 2)]);
    await answer(manager, 'opening words actual next continues', [segment('opening words', echoStart, echoStart + .58), segment('actual next continues', 1, 3)]);
    assert.deepEqual(confirmed, ['opening words']);
    assert.equal(manager.getLastConfirmedText(SID), 'opening words');
    assert.equal(drafts.size, 0, 'no stale draft survives without a replacement confirmation');
  });
  await check('repetition inside the current utterance is retained', async manager => {
    const confirmed: string[] = [];
    manager.onSegmentReady = () => {};
    manager.onSegmentPending = () => {};
    manager.onSegmentConfirmed = (_id, _name, text) => confirmed.push(text);
    manager.feedAudio(SID, new Float32Array(SR * 5).fill(.1), START);
    await answer(manager, 'one two one two three', [segment('one two', 0, 1), segment('one two', 1, 2), segment('three', 2, 3)]);
    await answer(manager, 'one two one two three four', [segment('one two', 0, 1), segment('one two', 1, 2), segment('three four', 2, 4)]);
    assert.deepEqual(confirmed, ['one two', 'one two']);
  });
  await check('a retained tail keeps the capture clock after whole-text confirmation', async manager => {
    const pending: Array<{ text: string; start: number }> = [];
    manager.onSegmentReady = () => {};
    manager.onSegmentConfirmed = () => {};
    manager.onSegmentPending = (_id, _name, text, start) => pending.push({ text, start });
    manager.feedAudio(SID, new Float32Array(SR * 4).fill(.1), START);
    await answer(manager, 'stable head', [segment('stable head', 0, 1)]);
    await answer(manager, 'stable head', [segment('stable head', 0, 1)]);
    await answer(manager, 'retained tail', [segment('retained tail', 0, 2)]);
    assert.deepEqual(pending.at(-1), { text: 'retained tail', start: START + 1000 });
  });
}
assert.equal(failures, 0, `${failures} prefix/timeline regressions`);
