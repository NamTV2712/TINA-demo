import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { createSpeechHandler } from './speech-status.js';
import { createTtsPlayback } from './tts-playback.js';
import { createSpeakController } from './capture-bridge.js';
import { parseAct } from './contracts.js';
import type { Invocation } from './config.js';

const id = '00000000-0000-4000-8000-000000000001';

test('tracked command requires UUID and text; legacy acts remain accepted', () => {
  assert(parseAct({ action: 'speak', text: 'legacy' }));
  assert.equal(parseAct({ action: 'speech_speak', command_id: 'bad', text: 'hello' }), null);
  assert.equal(parseAct({ action: 'speech_speak', command_id: id, text: '' }), null);
  assert(parseAct({ action: 'speech_stop', command_id: id }));
});

test('stop before a delayed Speak tombstones its identity', async () => {
  let spoken = 0;
  const receipts: string[] = [];
  const handler = createSpeechHandler({ async speak() { spoken++; }, async stop() {} },
    async (_, state) => { receipts.push(state); });
  await handler({ action: 'speech_stop', command_id: id });
  await handler({ action: 'speech_speak', command_id: id, text: 'late result' });
  assert.equal(spoken, 0);
  assert.deepEqual(receipts, ['stopped', 'stopped']);
});

test('completion waits for the real playback promise and preserves started ordering', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const receipts: string[] = [];
  const handler = createSpeechHandler({ async speak(_, __, started) {
    started?.(); await barrier; return 'completed';
  }, async stop() {} }, async (_, state) => { receipts.push(state); });
  const speaking = handler({ action: 'speech_speak', command_id: id, text: 'synthetic' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(receipts, ['started']);
  release(); await speaking;
  assert.deepEqual(receipts, ['started', 'completed']);
});

test('cancellation survives more than 128 later Stops for the core receipt lifetime', async () => {
  let spoken = 0, clock = 0;
  const handler = createSpeechHandler({ async speak() { spoken++; }, async stop() {} },
    async () => {}, () => clock);
  await handler({ action: 'speech_stop', command_id: id });
  for (let i = 2; i < 132; i++) {
    await handler({ action: 'speech_stop', command_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
  }
  clock = 599_999;
  await handler({ action: 'speech_speak', command_id: id, text: 'cancelled' });
  assert.equal(spoken, 0);
  clock = 600_001;
  await handler({ action: 'speech_speak', command_id: id, text: 'expired' });
  assert.equal(spoken, 1);
});

test('Stop during delayed microphone UI never starts a late TTS request', async () => {
  let release!: (value: boolean) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0;
  const page = { evaluate: async (_fn: unknown, args: { desiredOn: boolean }) => {
    if (!args.desiredOn) return false;
    entered(); return new Promise<boolean>(resolve => { release = resolve; });
  } };
  const controller = createSpeakController(page as never,
    { platform: 'google_meet', voiceAgentEnabled: true } as Invocation,
    () => ({ async speak() { requests++; return 'completed'; }, stop() {} }));
  const speaking = controller.speak('synthetic', 'auto', () => {});
  await started;
  const stopping = controller.stop();
  release(true);
  assert.equal(await speaking, 'stopped');
  await stopping;
  assert.equal(requests, 0);
});

test('HTTP errors, empty PCM and nonzero player exits cannot report completed', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  let status = 503, pcm = Buffer.alloc(20), playerCode = 0, starts = 0;
  const server = createServer((req, res) => {
    req.resume(); req.once('end', () => { res.writeHead(status); res.end(pcm); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const playback = createTtsPlayback(() => {}, { setMute() {}, spawnProcess() {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stdin: new PassThrough(), stderr: new PassThrough(),
      kill() { child.emit('exit', null); return true; } });
    child.stdin!.on('finish', () => { setImmediate(() => child.emit('exit', playerCode)); });
    setImmediate(() => child.emit('spawn'));
    return child;
  } });
  try {
    assert.equal(await playback.speak('test'), 'failed');
    status = 200; pcm = Buffer.alloc(0);
    assert.equal(await playback.speak('test'), 'failed');
    pcm = Buffer.alloc(200); playerCode = 1;
    assert.equal(await playback.speak('test'), 'failed');
    playerCode = 0;
    assert.equal(await playback.speak('test', 'auto', () => { starts++; }), 'completed');
    assert.equal(starts, 1);
  } finally {
    playback.stop();
    if (previous === undefined) delete process.env.TTS_SERVICE_URL; else process.env.TTS_SERVICE_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('partial unmute failure restores mute and never starts the player', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  const mutes: boolean[] = [];
  let spawned = 0;
  const server = createServer((req, res) => { req.resume(); res.end(Buffer.alloc(20)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const playback = createTtsPlayback(() => {}, {
    setMute(muted) { mutes.push(muted); if (!muted) throw new Error('partial failure'); },
    spawnProcess() { spawned++; throw new Error('must not spawn'); },
  });
  try {
    assert.equal(await playback.speak('test'), 'failed');
    assert.deepEqual(mutes, [false, true]);
    assert.equal(spawned, 0);
  } finally {
    playback.stop();
    if (previous === undefined) delete process.env.TTS_SERVICE_URL; else process.env.TTS_SERVICE_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('total deadline bounds a stalled synthesis and a stalled player, restoring mute', async () => {
  const previous = process.env.TTS_SERVICE_URL;
  let sendAudio = false, killed = 0;
  const mutes: boolean[] = [];
  const server = createServer((req, res) => { req.resume(); if (sendAudio) res.end(Buffer.alloc(20)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TTS_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const playback = createTtsPlayback(() => {}, { requestTimeoutMs: 100,
    setMute(muted) { mutes.push(muted); },
    spawnProcess() {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stdin: new PassThrough(), stderr: new PassThrough(),
        kill() { killed++; child.emit('exit', null); return true; } });
      return child;
    },
  });
  try {
    assert.equal(await playback.speak('stalled synthesis'), 'failed');
    assert.equal(mutes.at(-1), true);
    sendAudio = true;
    assert.equal(await playback.speak('stalled player'), 'failed');
    assert.equal(killed, 1);
    assert(mutes.includes(false));
    assert.equal(mutes.at(-1), true);
  } finally {
    playback.stop();
    if (previous === undefined) delete process.env.TTS_SERVICE_URL; else process.env.TTS_SERVICE_URL = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
