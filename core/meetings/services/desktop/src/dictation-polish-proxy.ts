import * as http from 'node:http';
import {
  polishDictationText,
  supportsTranslationLanguage,
  translateTranscriptText,
} from './dictation-polish.js';

export interface DictationPolishProxyOptions {
  gatewayUrl: string;
  apiKey: string;
  port?: number;
}

export interface DictationPolishProxy {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 128 * 1024;

function send(res: http.ServerResponse, body: unknown, status: number): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        req.resume();
        reject(new RangeError('request too large'));
        return;
      }
      chunks.push(data);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on('error', error => {
      if (!tooLarge) reject(error);
    });
  });
}

export async function startDictationPolishProxy(options: DictationPolishProxyOptions): Promise<DictationPolishProxy> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const polish = url.pathname === '/dictation/polish';
    const translate = url.pathname === '/dictation/translate';
    if (req.method !== 'POST' || (!polish && !translate)) {
      return send(res, { error: 'not found' }, 404);
    }
    // Native Tauri calls this loopback-only service. Reject browser-originated requests
    // rather than turning the server-held account key into a browser-callable proxy.
    if (req.headers.origin) return send(res, { error: 'origin refused' }, 403);
    if (!options.apiKey) return send(res, {
      error: polish ? 'text polish is not configured' : 'live translation is not configured',
    }, 503);
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      req.resume();
      return send(res, { error: 'request too large' }, 413);
    }
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      req.resume();
      return send(res, { error: 'expected application/json' }, 415);
    }

    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (error) {
      return send(res, { error: error instanceof RangeError ? error.message : 'invalid request' },
        error instanceof RangeError ? 413 : 422);
    }
    const value = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    if (!value || typeof value.text !== 'string') {
      return send(res, { error: 'invalid request' }, 422);
    }
    if (polish && Object.keys(value).some(key => key !== 'text')) {
      return send(res, { error: 'invalid request' }, 422);
    }
    if (translate && (Object.keys(value).some(key => key !== 'text' && key !== 'target_language')
        || !supportsTranslationLanguage(value.target_language))) {
      return send(res, { error: 'invalid request' }, 422);
    }
    try {
      if (polish) {
        const polishedText = await polishDictationText(value.text, options);
        return send(res, { polished_text: polishedText }, 200);
      }
      if (!supportsTranslationLanguage(value.target_language)) {
        return send(res, { error: 'invalid request' }, 422);
      }
      const translatedText = await translateTranscriptText(
        value.text, value.target_language, options,
      );
      return send(res, { translated_text: translatedText }, 200);
    } catch {
      return send(res, { error: polish ? 'text polish is unavailable' : 'live translation is unavailable' }, 503);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8057, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Dictation polish proxy failed to bind');
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
