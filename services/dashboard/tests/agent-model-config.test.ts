import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const forward = vi.fn();
vi.mock('@/lib/agent-proxy', () => ({ forwardAgent: (...args: unknown[]) => forward(...args) }));
import { GET } from '../src/app/api/ai/config/route';
afterEach(() => vi.clearAllMocks());
it('uses the authenticated shared model endpoint, not Dashboard AI environment settings', async () => {
  forward.mockResolvedValueOnce(Response.json({ chat_model: 'chosen-by-owner', chatgpt_connected: true }));
  const response = await GET(new NextRequest('http://dashboard/api/ai/config'));
  expect(await response.json()).toMatchObject({ model: 'chosen-by-owner', enabled: true, sharedWithTerminal: true });
  expect(forward.mock.calls[0][1]).toEqual(['models']);
});
it('preserves auth failure and exposes a disconnected ChatGPT account accurately', async () => {
  forward.mockResolvedValueOnce(Response.json({ detail: 'Sign in' }, { status: 401 }));
  expect((await GET(new NextRequest('http://dashboard/api/ai/config'))).status).toBe(401);
  forward.mockResolvedValueOnce(Response.json({ chat_model: 'owner-model', chatgpt_connected: false }));
  expect((await (await GET(new NextRequest('http://dashboard/api/ai/config'))).json()).enabled).toBe(false);
});
