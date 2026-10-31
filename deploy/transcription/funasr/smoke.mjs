// Replay a synthetic 16 kHz mono PCM16 WAV through the actual Desktop capture path.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { startDesktop } from '../../../core/meetings/services/desktop/dist/desktop.js';
import { encodeAudioFrame } from '../../../core/meetings/modules/capture-codec/dist/index.js';

const require = createRequire(new URL('../../../core/meetings/services/desktop/package.json', import.meta.url));
const { WebSocket } = require('ws');
assert(process.argv[2], 'Usage: node deploy/transcription/funasr/smoke.mjs <synthetic-vi.wav>');
const wav = readFileSync(process.argv[2]);
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
let pcm;
let validFormat = false;
for (let offset = 12; offset + 8 <= wav.length;) {
  const kind = wav.toString('ascii', offset, offset + 4);
  const length = wav.readUInt32LE(offset + 4);
  const start = offset + 8;
  assert(start + length <= wav.length, 'Truncated WAV chunk');
  if (kind === 'fmt ') {
    assert(length >= 16);
    assert.equal(wav.readUInt16LE(start), 1, 'Expected PCM');
    assert.equal(wav.readUInt16LE(start + 2), 1, 'Expected mono');
    assert.equal(wav.readUInt32LE(start + 4), 16000, 'Expected 16 kHz');
    assert.equal(wav.readUInt16LE(start + 14), 16, 'Expected PCM16');
    validFormat = true;
  }
  if (kind === 'data') {
    assert.equal(length % 2, 0);
    pcm = Float32Array.from({ length: length / 2 }, (_, i) => wav.readInt16LE(start + i * 2) / 32768);
  }
  offset = start + length + (length % 2);
}
assert(validFormat && pcm?.length >= 32000, 'Expected at least two seconds of PCM16 audio');
const recordingsDir = mkdtempSync(join(tmpdir(), 'tina-funasr-capture-'));
const desktop = await startDesktop({ ingestPort: 0, gatewayPort: 0,
  txUrl: process.env.TINA_TX_URL || 'http://127.0.0.1:18000', txToken: '', txModel: 'custom',
  quiet: true, recordingsDir });
let ws;
try {
  const started = performance.now();
  ws = new WebSocket(`ws://127.0.0.1:${desktop.ingestPort}/ingest?platform=google_meet&native_meeting_id=funasr-smoke&language=vi`);
  await once(ws, 'open');
  for (let offset = 0; offset < pcm.length; offset += 8000) {
    ws.send(Buffer.from(encodeAudioFrame(0, Date.now() + offset / 16, pcm.subarray(offset, offset + 8000), 'TINA smoke')));
  }
  ws.close();
  let meeting;
  for (let i = 0; i < 120; i++) {
    const response = await fetch(`http://127.0.0.1:${desktop.gatewayPort}/transcripts/google_meet/funasr-smoke`);
    assert(response.ok);
    meeting = await response.json();
    if (meeting.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(meeting.status, 'completed', 'Capture did not finish within 60s');
  assert(meeting.segments.length > 0, 'No transcript returned');
  assert(meeting.segments.every(s => s.text.trim() && s.speaker === 'TINA smoke' && s.end >= s.start));
  console.log(JSON.stringify({ ok: true, seconds: (performance.now() - started) / 1000,
    text: meeting.segments.map(s => s.text).join(' ') }));
} finally {
  ws?.terminate();
  await desktop.close();
  rmSync(recordingsDir, { recursive: true, force: true });
}
