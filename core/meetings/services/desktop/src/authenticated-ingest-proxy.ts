import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export interface AuthenticatedIngestProxyOptions {
  desktopPort: number;
  secret: string;
  port?: number;
}

export interface AuthenticatedIngestProxy {
  port: number;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const DEFAULT_PORT = 9099;
const CHALLENGE_HEADER = 'x-tina-capture-challenge';
const CHALLENGE_PATTERN = /^[0-9a-f]{32}$/;
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
const EXTENSION_SUBPROTOCOL = 'tina-extension.v1';
const API_KEY_SUBPROTOCOL_PREFIX = 'tina-api-key.';

function extensionApiKey(request: http.IncomingMessage): string | null {
  if (!EXTENSION_ORIGIN_PATTERN.test(request.headers.origin || '')) return null;
  const protocols = request.headers['sec-websocket-protocol']
    ?.split(',')
    .map(protocol => protocol.trim()) ?? [];
  if (!protocols.includes(EXTENSION_SUBPROTOCOL)) return null;
  const credentials = protocols.filter(protocol => protocol.startsWith(API_KEY_SUBPROTOCOL_PREFIX));
  if (credentials.length !== 1) return null;
  const encoded = credentials[0].slice(API_KEY_SUBPROTOCOL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const apiKey = Buffer.from(encoded, 'base64url').toString('utf8');
  return apiKey && Buffer.from(apiKey).toString('base64url') === encoded ? apiKey : null;
}

export async function startAuthenticatedIngestProxy(
  options: AuthenticatedIngestProxyOptions,
): Promise<AuthenticatedIngestProxy> {
  if (!/^[0-9a-f]{64}$/.test(options.secret)) {
    throw new Error('Invalid Desktop ingest secret');
  }
  if (!Number.isInteger(options.desktopPort) || options.desktopPort < 1 || options.desktopPort > 65535) {
    throw new Error('Invalid Desktop ingest port');
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: protocols => protocols.has(EXTENSION_SUBPROTOCOL) ? EXTENSION_SUBPROTOCOL : false,
  });
  const upstreams = new Set<WebSocket>();
  const extensionApiKeys = new WeakMap<http.IncomingMessage, string>();
  let closing = false;

  wss.on('headers', (headers, req) => {
    const challenge = req.headers[CHALLENGE_HEADER];
    if (typeof challenge !== 'string' || !CHALLENGE_PATTERN.test(challenge)) return;
    const proof = createHmac('sha256', Buffer.from(options.secret, 'hex'))
      .update(challenge)
      .digest('hex');
    headers.push(`X-TINA-Capture-Proof: ${proof}`);
  });

  server.on('upgrade', (req, socket, head) => {
    let path: string;
    try {
      path = new URL(req.url || '/', `http://${HOST}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (closing || path !== '/ingest') {
      socket.destroy();
      return;
    }

    const challenge = req.headers[CHALLENGE_HEADER];
    const apiKey = extensionApiKey(req);
    if ((typeof challenge !== 'string' || !CHALLENGE_PATTERN.test(challenge)) && !apiKey) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (apiKey) extensionApiKeys.set(req, apiKey);

    wss.handleUpgrade(req, socket, head, client => {
      wss.emit('connection', client, req);
    });
  });

  wss.on('connection', (client, req) => {
    const url = new URL(req.url || '/', `http://${HOST}`);
    const apiKey = extensionApiKeys.get(req);
    const upstream = new WebSocket(
      `ws://${HOST}:${options.desktopPort}${url.pathname}${url.search}`,
      apiKey
        ? { handshakeTimeout: 5_000, headers: { 'x-api-key': apiKey } }
        : { handshakeTimeout: 5_000 },
    );
    upstreams.add(upstream);
    const pending: Array<{ data: RawData; binary: boolean }> = [];

    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push({ data, binary });
      }
    });
    upstream.on('open', () => {
      for (const message of pending) {
        upstream.send(message.data, { binary: message.binary });
      }
      pending.length = 0;
    });
    upstream.on('message', (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN) {
        upstream.terminate();
      }
    });
    upstream.on('close', () => {
      upstreams.delete(upstream);
      if (client.readyState === WebSocket.OPEN) client.close();
    });
    client.on('error', () => upstream.terminate());
    upstream.on('error', () => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'TINA Desktop ingest is unavailable');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Authenticated Desktop ingest proxy failed to bind');
  }

  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      closing = true;
      for (const client of wss.clients) client.terminate();
      for (const upstream of upstreams) upstream.terminate();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
