import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { encodeRecordingChunk } from '@tina/capture-codec';
import { startDesktop } from './desktop.js';

const directory = mkdtempSync(join(tmpdir(), 'tina-recording-reconnect-'));
const desktop = await startDesktop({ gatewayPort: 0, ingestPort: 0, recordingsDir: directory, quiet: true });
const url = `ws://127.0.0.1:${desktop.ingestPort}/ingest?platform=google_meet&native_meeting_id=reconnect&client_session=synthetic-session`;
async function connect(endpoint = url) {
  const ws = new WebSocket(endpoint);
  const [body] = await once(ws, 'message');
  return { ws, ready: JSON.parse(String(body)) };
}
try {
  const first = await connect(); assert.equal(first.ready.recording_ack, true); assert.equal(first.ready.recording_resume, false);
  const before = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  let ack = once(first.ws, 'message');
  first.ws.send(Buffer.from(encodeRecordingChunk(0, false, 'webm', before)));
  assert.equal(JSON.parse(String((await ack)[0])).seq, 0);
  first.ws.close(); await once(first.ws, 'close');
  await new Promise(r => setTimeout(r, 30));
  const second = await connect(); assert.equal(second.ready.recording_resume, true);
  const after = Buffer.from([4, 5, 6]);
  ack = once(second.ws, 'message'); second.ws.send(Buffer.from(encodeRecordingChunk(1, false, 'webm', after))); await ack;
  ack = once(second.ws, 'message'); second.ws.send(Buffer.from(encodeRecordingChunk(2, true, 'webm', new Uint8Array())));
  assert.equal(JSON.parse(String((await ack)[0])).isFinal, true);
  const response = await fetch(`http://127.0.0.1:${desktop.gatewayPort}/recordings/google_meet/reconnect`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([before, after]));
  second.ws.close(); await once(second.ws, 'close');
  await new Promise(r => setTimeout(r, 30));
  const third = await connect(url.replace('synthetic-session', 'another-session'));
  assert.equal(third.ready.recording_resume, false);
  const separate = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 99]);
  ack = once(third.ws, 'message'); third.ws.send(Buffer.from(encodeRecordingChunk(0, false, 'webm', separate))); await ack;
  ack = once(third.ws, 'message'); third.ws.send(Buffer.from(encodeRecordingChunk(1, true, 'webm', new Uint8Array()))); await ack;
  const latest = await fetch(`http://127.0.0.1:${desktop.gatewayPort}/recordings/google_meet/reconnect`);
  assert.deepEqual(Buffer.from(await latest.arrayBuffer()), separate, 'different client sessions cannot merge recording chunks');
  const versions = readdirSync(directory).filter(name => name.endsWith('.webm') && name !== 'google_meet_reconnect.webm');
  assert.equal(versions.length, 1);
  assert.deepEqual(readFileSync(join(directory, versions[0])), Buffer.concat([before, after]));
  third.ws.close(); await once(third.ws, 'close');
  console.log('PASS Desktop: recording resume across actual WS disconnect; final ACK follows complete byte-preserving master');
} finally { await desktop.close(); rmSync(directory, { recursive: true, force: true }); }
