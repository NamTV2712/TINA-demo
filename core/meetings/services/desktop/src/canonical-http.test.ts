import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startDesktop } from './desktop.js';

const directory = mkdtempSync(join(tmpdir(), 'tina-canonical-http-'));
const options = { gatewayPort: 0, ingestPort: 0, recordingsDir: directory, quiet: true,
  canAccess: (subject: string) => subject !== 'denied', initialMeetings: [{ id: 1, platform: 'desktop', native_meeting_id: 'canonical', status: 'completed', start_time: new Date().toISOString(),
    segments: [{ segment_id: 'one', text: 'rawneedle', speaker: 'You', start: 100, end: 101, completed: true }] }] };
let desktop = await startDesktop(options), socket: WebSocket | undefined, denied: WebSocket | undefined;
try {
  let base = `http://127.0.0.1:${desktop.gatewayPort}`;
  socket = new WebSocket(`ws://127.0.0.1:${desktop.gatewayPort}/ws`); await once(socket, 'open');
  denied = new WebSocket(`ws://127.0.0.1:${desktop.gatewayPort}/ws?api_key=denied`); await once(denied, 'open');
  const received: any[] = [], leaked: any[] = [];
  socket.on('message', body => received.push(JSON.parse(String(body)))); denied.on('message', body => leaked.push(JSON.parse(String(body))));
  const patch = (revision: number, text: string | null) => fetch(base + '/transcripts/desktop/canonical/segments/one', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: revision, text }) });
  assert.equal((await patch(0, 'acceptedneedle')).status, 200);
  assert.equal((await (await fetch(base + '/transcripts/search?q=rawneedle')).json() as any).count, 0);
  assert.equal((await (await fetch(base + '/transcripts/search?q=acceptedneedle')).json() as any).count, 1);
  for (let i = 0; i < 80 && !received.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(received[0].type, 'transcript.revised'); assert.equal(received[0].revision, 1);
  assert.equal(leaked.length, 0); assert.ok(!('text' in received[0]));
  assert.equal((await (await fetch(base + '/transcripts/desktop/canonical')).json() as any).segments[0].revision, 1);
  assert.equal((await fetch(base + '/transcripts/search?q=acceptedneedle', { headers: { 'X-API-Key': 'denied' } })).status, 200);
  assert.equal((await (await fetch(base + '/transcripts/search?q=acceptedneedle', { headers: { 'X-API-Key': 'denied' } })).json() as any).count, 0);
  assert.equal((await patch(1, null)).status, 200);
  socket.close(); denied.close(); await desktop.close();
  desktop = await startDesktop({ ...options, initialMeetings: [] }); base = `http://127.0.0.1:${desktop.gatewayPort}`;
  const doc = await (await fetch(base + '/transcripts/desktop/canonical/document')).json() as any;
  assert.equal(doc.segments[0].revision, 2); assert.equal(doc.segments[0].raw_text, 'rawneedle'); assert.equal(doc.segments[0].text, 'rawneedle');
  assert.equal((await (await fetch(base + '/transcripts/search?q=acceptedneedle')).json() as any).count, 0);
  assert.equal((await (await fetch(base + '/transcripts/search?q=rawneedle')).json() as any).count, 1);
  console.log('PASS canonical HTTP/WS: current text/search, revision event, denied subscriber, Restore and restart');
} finally { socket?.terminate(); denied?.terminate(); await desktop.close(); rmSync(directory, { recursive: true, force: true }); }
