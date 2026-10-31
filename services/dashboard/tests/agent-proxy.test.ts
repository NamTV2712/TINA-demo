import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const values = new Map<string, string>();
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => values.has(name) ? { value: values.get(name) } : undefined }) }));
import { forwardAgent } from '../src/lib/agent-proxy';
afterEach(() => { values.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('requires a user cookie even with deployment credentials', async () => {
  vi.stubEnv('AGENT_API_TOKEN', 'service-secret'); vi.stubEnv('TINA_API_KEY', 'deployment-key');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect((await forwardAgent(new NextRequest('http://dashboard/api/agent/workspace/tree'), ['workspace', 'tree'])).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
it('forwards only the cookie identity through Gateway and preserves errors', async () => {
  values.set('tina-token', 'owner-key'); vi.stubEnv('TINA_API_URL', 'http://gateway');
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ detail: 'Sources changed' }, { status: 409 })); vi.stubGlobal('fetch', fetch);
  const response = await forwardAgent(new NextRequest('http://dashboard/api/agent/workspace/tree', { headers: { 'X-User-Id': 'victim' } }), ['workspace', 'tree']);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ detail: 'Sources changed' });
  expect(fetch.mock.calls[0][0]).toBe('http://gateway/agent/workspace/tree');
  expect(fetch.mock.calls[0][1]?.headers).toEqual({ 'X-API-Key': 'owner-key' });
});
it('preserves SSE, cursor and prompt without injecting identity', async () => {
  values.set('tina-token', 'owner-key'); vi.stubEnv('TINA_API_URL', 'http://gateway');
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('data: {"type":"message-delta","text":"hello"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })); vi.stubGlobal('fetch', fetch);
  const response = await forwardAgent(new NextRequest('http://dashboard/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Last-Event-ID': '1-0' }, body: '{"prompt":"hello","session":"mine"}' }), ['chat']);
  expect(await response.text()).toContain('message-delta');
  expect(fetch.mock.calls[0][1]?.body).toBe('{"prompt":"hello","session":"mine"}');
  expect(fetch.mock.calls[0][1]?.headers).toEqual({ 'X-API-Key': 'owner-key', 'Content-Type': 'application/json', 'Last-Event-ID': '1-0' });
});
it('refuses traversal and cross-origin writes', async () => {
  values.set('tina-token', 'key'); vi.stubEnv('TINA_API_URL', 'http://gateway');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect((await forwardAgent(new NextRequest('http://dashboard/api/agent/x'), ['..', 'internal'])).status).toBe(400);
  expect((await forwardAgent(new NextRequest('http://dashboard/api/agent/chat', { method: 'POST', headers: { origin: 'https://foreign' } }), ['chat'])).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
it('accepts the browser-facing Host and localhost aliases on the same port', async () => {
  values.set('tina-token', 'key'); vi.stubEnv('TINA_API_URL', 'http://gateway');
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:13001');
  const fetch = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetch);
  const response = await forwardAgent(new NextRequest('http://container:3000/api/agent/chat', {
    method: 'POST', headers: { origin: 'http://127.0.0.1:13001', host: '127.0.0.1:13001' }, body: '{}',
  }), ['chat']);
  expect(response.status).toBe(200);
  expect((await forwardAgent(new NextRequest('http://container:3000/api/agent/chat', {
    method: 'POST', headers: { origin: 'http://127.0.0.1:13002', host: '127.0.0.1:13001' }, body: '{}',
  }), ['chat'])).status).toBe(403);
});
