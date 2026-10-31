/** Opt-in live worker check on supplied mono16k PCM16 WAV; uses disposable Desktop state. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { once } from 'node:events';
import { startDesktop } from '../../../core/meetings/services/desktop/dist/desktop.js';
import { createBotPipeline } from '../../../core/meetings/services/bot/dist/pipeline.js';
import { encodeAudioFrame } from '../../../core/meetings/modules/capture-codec/dist/index.js';
const { WebSocket } = createRequire(new URL('../../../core/meetings/services/desktop/package.json', import.meta.url))('ws');

assert(process.argv[2], 'Supply an existing mono 16 kHz PCM16 WAV');
const bytes = readFileSync(process.argv[2]);
assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
let data, format;
for (let offset = 12; offset + 8 <= bytes.length;) {
  const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
  assert(offset + 8 + size <= bytes.length);
  if (name === 'fmt ') format = bytes.subarray(offset + 8, offset + 8 + size);
  if (name === 'data') data = bytes.subarray(offset + 8, offset + 8 + size);
  offset += 8 + size + size % 2;
}
assert(format && data); assert.equal(format.readUInt16LE(0), 1); assert.equal(format.readUInt16LE(2), 1);
assert.equal(format.readUInt32LE(4), 16000); assert.equal(format.readUInt16LE(14), 16);
assert(data.length > 0 && data.length <= 16000 * 30 * 2);
const pcm = Float32Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2) / 32768);
const config = parseEnv(readFileSync(join(homedir(), '.config/tina/gipformer.env'), 'utf8'));
const token = config.TINA_GIPFORMER_TOKEN, url = 'http://127.0.0.1:' + (config.TINA_GIPFORMER_PORT || '18002');
assert(token);
const epoch = Date.now(), confirmed = [], faults = [];
const pipe = createBotPipeline({ platform: 'google_meet', language: 'vi', transcribeEnabled: true,
  transcriptionServiceUrl: url, transcriptionServiceToken: token, transcriptionModel: 'custom' },
  { publish: async s => { if (s.completed) confirmed.push(s); }, retract: async () => {} },
  { onError: error => faults.push(String(error)) });
await pipe.start();
try {
  for (let i = 0; i < pcm.length; i += 1600) pipe.feedAudio(0, 'Fixture', pcm.subarray(i, i + 1600), epoch + i / 16, 'fixture-participant', i);
} finally { await pipe.stop(); }
assert.equal(faults.length, 0); assert(confirmed.some(s => s.text.trim()), 'Bot engine must publish final speech');
assert(confirmed.every(s => s.participant_id === 'fixture-participant' && s.start * 1000 >= epoch));

const directory = mkdtempSync(join(tmpdir(), 'tina-gipformer-smoke-'));
const desktop = await startDesktop({ ingestPort: 0, gatewayPort: 0, statePath: join(directory, 'transcripts.sqlite'), recordingsDir: directory, quiet: true,
  txUrl: url, txToken: token, txModel: 'custom' });
const key = 'google_meet/gipformer-fixture'; let socket;
try {
  socket = new WebSocket(`ws://127.0.0.1:${desktop.ingestPort}/ingest?platform=google_meet&native_meeting_id=gipformer-fixture&language=vi`);
  await once(socket, 'message');
  for (let i = 0; i < pcm.length; i += 1600) socket.send(encodeAudioFrame(0, epoch + i / 16, pcm.subarray(i, i + 1600), 'Fixture', i));
  await new Promise(resolve => setTimeout(resolve, 100));
  const ended = await fetch(`http://127.0.0.1:${desktop.gatewayPort}/extension/sessions/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'google_meet', native_meeting_id: 'gipformer-fixture' }) });
  assert(ended.ok, 'Desktop capture must close cleanly');
  const base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/${key}`;
  const transcript = await (await fetch(base)).json(); assert(transcript.segments.some(s => s.text.trim()), 'Desktop final transcript');
  const canonical = await (await fetch(base + '/canonical')).json(); assert(canonical.segments.length);
  const memory = await (await fetch(base + '/memory')).json(); assert.equal(memory.version, 'meeting-memory.v1');
  assert(!readFileSync(join(directory, 'transcripts.sqlite')).includes(Buffer.from(token)), 'Worker credential must not persist');
  const report = { bot_confirmed_segments: confirmed.length, desktop_confirmed_segments: transcript.segments.length,
    canonical_segments: canonical.segments.length, memory_windows: memory.windows.length, faults: faults.length };
  console.log('PASS real Gipformer HTTP → Bot engine and capture.v1 → Desktop → canonical/memory', JSON.stringify(report));
} finally { socket?.terminate(); await desktop.close(); rmSync(directory, { recursive: true, force: true }); }
