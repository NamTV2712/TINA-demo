import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { polishDictationText } from './dictation-polish.js';
import { startDictationPolishProxy } from './dictation-polish-proxy.js';

let passed = 0;

function check(name: string, ok: boolean): void {
  if (!ok) throw new Error(`FAIL ${name}`);
  passed++;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function main(): Promise<void> {
  let request: { url: string; init: RequestInit } | undefined;
  const polished = await polishDictationText('  raw transcript  ', {
    gatewayUrl: 'http://127.0.0.1:18056/',
    apiKey: 'desktop-user-key',
    fetch: async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({ polished_text: 'Polished transcript' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  check('returns the final polished text', polished === 'Polished transcript');
  check('uses the gateway agent polish route', request?.url === 'http://127.0.0.1:18056/agent/dictation/polish');
  check('authenticates with the Desktop-bound API key', (request?.init.headers as Record<string, string>)?.['X-API-Key'] === 'desktop-user-key');
  check('sends only the final transcript text', request?.init.body === JSON.stringify({ text: 'raw transcript' }));

  let calledOverPlaintext = false;
  await assert.rejects(
    polishDictationText('raw transcript', {
      gatewayUrl: 'http://gateway.example',
      apiKey: 'desktop-user-key',
      fetch: async () => {
        calledOverPlaintext = true;
        return new Response(JSON.stringify({ polished_text: 'must not be sent' }));
      },
    }),
    /Text polish is not configured/,
  );
  check('refuses to send the server API key to a remote HTTP Gateway', !calledOverPlaintext);

  let calledWithoutKey = false;
  await assert.rejects(
    polishDictationText('raw transcript', {
      gatewayUrl: 'http://127.0.0.1:18056',
      apiKey: '',
      fetch: async () => {
        calledWithoutKey = true;
        return new Response('{}');
      },
    }),
    /Text polish is not configured/,
  );
  check('does not contact the agent API without a bound key', !calledWithoutKey);

  let upstreamFailure = '';
  try {
    await polishDictationText('raw transcript', {
      gatewayUrl: 'http://127.0.0.1:18056',
      apiKey: 'desktop-user-key',
      fetch: async () => new Response('unavailable', { status: 503 }),
    });
  } catch (error) {
    upstreamFailure = error instanceof Error ? error.message : String(error);
  }
  check('does not expose upstream failure details', upstreamFailure === 'Text polish is unavailable');

  let forwarded: { key: string | undefined; text: string } | undefined;
  let upstreamRequests = 0;
  const gateway = createServer(async (req, res) => {
    upstreamRequests++;
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(req.url, '/agent/dictation/polish');
    forwarded = { key: req.headers['x-api-key'], text: JSON.parse(body).text };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ polished_text: 'Native polished transcript' }));
  });
  const gatewayUrl = await listen(gateway);
  const proxy = await startDictationPolishProxy({
    port: 0,
    gatewayUrl,
    apiKey: 'desktop-bound-key',
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/dictation/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'raw native transcript' }),
    });
    check('loopback bridge returns the agent polish result', response.status === 200
      && (await response.json() as any).polished_text === 'Native polished transcript');
    check('loopback bridge forwards only text and the server-side API key',
      forwarded?.text === 'raw native transcript' && forwarded.key === 'desktop-bound-key');

    const crossOrigin = await fetch(`http://127.0.0.1:${proxy.port}/dictation/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' },
      body: JSON.stringify({ text: 'do not forward' }),
    });
    check('loopback bridge rejects browser-originated requests', crossOrigin.status === 403);
    check('rejected origins do not reach the Gateway', upstreamRequests === 1);
  } finally {
    await proxy.close();
    await close(gateway);
  }

  const unbound = await startDictationPolishProxy({
    port: 0,
    gatewayUrl: 'http://127.0.0.1:1',
    apiKey: '',
  });
  try {
    const response = await fetch(`http://127.0.0.1:${unbound.port}/dictation/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'raw native transcript' }),
    });
    check('loopback bridge disables forwarding when no API key is bound', response.status === 503);
  } finally {
    await unbound.close();
  }

  console.log(`PASS dictation-polish: ${passed} checks`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
