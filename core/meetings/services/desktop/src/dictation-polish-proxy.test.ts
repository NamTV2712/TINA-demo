import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startDictationPolishProxy } from './dictation-polish-proxy.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function main(): Promise<void> {
  let received = 0;
  const gateway = createServer(async (req, res) => {
    received++;
    assert.equal(req.url, '/agent/dictation/polish');
    assert.equal(req.headers['x-api-key'], 'bound-user-key');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { text: 'final raw transcript' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ polished_text: 'Final polished transcript' }));
  });
  const gatewayUrl = await listen(gateway);
  const proxy = await startDictationPolishProxy({ gatewayUrl, apiKey: 'bound-user-key', port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/dictation/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'final raw transcript' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { polished_text: 'Final polished transcript' });

    const denied = await fetch(`http://127.0.0.1:${proxy.port}/dictation/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' },
      body: JSON.stringify({ text: 'must not forward' }),
    });
    assert.equal(denied.status, 403);
    assert.equal(received, 1);
  } finally {
    await proxy.close();
    await close(gateway);
  }

  const unbound = await startDictationPolishProxy({
    gatewayUrl: 'http://127.0.0.1:1',
    apiKey: '',
    port: 0,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${unbound.port}/dictation/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'final raw transcript' }),
    });
    assert.equal(response.status, 503);
  } finally {
    await unbound.close();
  }

  console.log('PASS dictation polish loopback proxy');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
