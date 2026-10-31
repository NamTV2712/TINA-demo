import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { startAuthenticatedIngestProxy } from './authenticated-ingest-proxy.js';

async function close(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('proves the loopback server before forwarding native audio', { timeout: 5000 }, async t => {
  const desktop = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(desktop, 'listening');
  const desktopPort = (desktop.address() as { port: number }).port;
  const secret = '11'.repeat(32);
  const challenge = '0123456789abcdef0123456789abcdef';
  let desktopConnections = 0;
  let forwardedApiKey: string | undefined;
  let desktopUrlHasApiKey: boolean | undefined;
  let extension: WebSocket | undefined;
  let receivedAudio!: Promise<{ bytes: Buffer; binary: boolean }>;
  let resolveAudio!: (value: { bytes: Buffer; binary: boolean }) => void;
  receivedAudio = new Promise(resolve => { resolveAudio = resolve; });

  desktop.on('connection', (upstream, request) => {
    desktopConnections++;
    const upstreamUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (upstreamUrl.searchParams.get('native_meeting_id') === 'extension-test') {
      const header = request.headers['x-api-key'];
      forwardedApiKey = Array.isArray(header) ? header[0] : header;
      desktopUrlHasApiKey = upstreamUrl.searchParams.has('api_key');
    }
    upstream.on('error', () => {});
    upstream.once('message', (data, binary) => {
      const bytes = data instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(data))
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      resolveAudio({ bytes, binary });
    });
    upstream.send(JSON.stringify({ type: 'ready' }));
  });

  const proxy = await startAuthenticatedIngestProxy({
    desktopPort,
    secret,
    port: 0,
  });
  const client = new WebSocket(
    `ws://127.0.0.1:${proxy.port}/ingest?platform=desktop&native_meeting_id=auth-test`,
    { headers: { 'X-TINA-Capture-Challenge': challenge } },
  );
  client.on('error', () => {});
  t.after(async () => {
    client.terminate();
    extension?.terminate();
    await proxy.close();
    await close(desktop);
  });

  const upgraded = once(client, 'upgrade');
  const opened = once(client, 'open');
  const readyFrame = once(client, 'message');
  const [response] = await upgraded;
  const expectedProof = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(challenge)
    .digest('hex');
  assert.equal(response.headers['x-tina-capture-proof'], expectedProof);

  await opened;
  const [ready] = await readyFrame;
  assert.deepEqual(JSON.parse(String(ready)), { type: 'ready' });

  const audio = Buffer.from([0, 1, 2, 255]);
  client.send(audio, { binary: true });
  assert.deepEqual(await receivedAudio, { bytes: audio, binary: true });

  const apiKey = 'synthetic-api-key';
  extension = new WebSocket(
    `ws://127.0.0.1:${proxy.port}/ingest?platform=desktop&native_meeting_id=extension-test`,
    ['tina-extension.v1', `tina-api-key.${Buffer.from(apiKey).toString('base64url')}`],
    { headers: { Origin: 'chrome-extension://bnhfpjhjehhalpglodponhlofbgmfegj' } },
  );
  extension.on('error', () => {});
  const extensionOpen = new Promise<number>(resolve => {
    extension!.once('open', () => resolve(101));
    extension!.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    extension!.once('error', () => resolve(0));
  });
  const extensionReady = new Promise<Buffer | ArrayBuffer | Buffer[] | null>(resolve => {
    extension!.once('message', data => resolve(data));
    extension!.once('unexpected-response', () => resolve(null));
    extension!.once('error', () => resolve(null));
  });
  const [extensionStatus, extensionFrame] = await Promise.all([extensionOpen, extensionReady]);
  assert.equal(extensionStatus, 101);
  assert.ok(extensionFrame);
  assert.deepEqual(JSON.parse(String(extensionFrame)), { type: 'ready' });
  assert.equal(extension.protocol, 'tina-extension.v1');
  assert.equal(forwardedApiKey, apiKey);
  assert.equal(desktopUrlHasApiKey, false);

  const wrongOriginStatus = await new Promise<number>(resolve => {
    const wrongOrigin = new WebSocket(
      `ws://127.0.0.1:${proxy.port}/ingest?platform=desktop&native_meeting_id=wrong-origin`,
      ['tina-extension.v1', `tina-api-key.${Buffer.from(apiKey).toString('base64url')}`],
      { headers: { Origin: 'https://example.invalid' } },
    );
    wrongOrigin.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    wrongOrigin.once('error', () => resolve(0));
  });

  const unauthorizedStatus = await new Promise<number>(resolve => {
    const unauthorized = new WebSocket(`ws://127.0.0.1:${proxy.port}/ingest?platform=desktop&native_meeting_id=unauthorized`);
    unauthorized.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    unauthorized.once('error', () => resolve(0));
  });
  assert.equal(wrongOriginStatus, 403);
  assert.equal(unauthorizedStatus, 403);
  assert.equal(desktopConnections, 2);
});
