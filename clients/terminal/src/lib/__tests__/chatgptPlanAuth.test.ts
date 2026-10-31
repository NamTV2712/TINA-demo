import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginChatGPTAuth, storePending, takePending, cancelPendingChatGPTAuth, chatGPTConnection, completeChatGPTSignIn } from '../chatgptPlanAuth';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const begin = (subject_id: string) => beginChatGPTAuth({ subject_id, generation: 'one', host_id: 'host', client_id: 'dynamic_agent_client', redirect_uri: 'http://127.0.0.1:23000/api/models/openai/callback', ui_origin: 'http://127.0.0.1:23000' });
describe('ChatGPT auth connection boundary', () => {
  it('cancels one user pending callbacks without affecting another user', () => {
    const one = begin('one'), two = begin('two'); storePending(one.pending); storePending(two.pending);
    cancelPendingChatGPTAuth('one'); expect(takePending(one.pending.state, 'one')).toBeNull(); expect(takePending(two.pending.state, 'two')?.subject_id).toBe('two');
    expect(takePending(two.pending.state, 'two')).toBeNull();
    expect(new URL(begin('one').authorizationUrl).searchParams.has('login_hint')).toBe(false);
  });
  it('does not consume a callback belonging to another TINA user', async () => {
    const login = begin('one'); storePending(login.pending);
    const url = new URL('http://127.0.0.1:23000/api/models/openai/callback');
    url.search = new URLSearchParams({ state: login.pending.state, error: 'access_denied' }).toString();
    await expect(completeChatGPTSignIn('other', url)).rejects.toThrow('another TINA user');
    await expect(completeChatGPTSignIn('one', url)).rejects.toThrow('plan access was not approved');
    await expect(completeChatGPTSignIn('one', url)).rejects.toThrow('already used');
  });
  it('uses the authenticated internal broker and does not send secrets on an unconfigured edge', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ generation: 'test' })); vi.stubGlobal('fetch', fetch);
    vi.stubEnv('TINA_INTERNAL_API_SECRET', 'private-internal'); vi.stubEnv('AGENT_API_URL', 'http://agent-api:8100');
    expect(await chatGPTConnection('one', 'GET')).toEqual({ generation: 'test' });
    expect(fetch.mock.calls[0][0]).toBe('http://agent-api:8100/internal/openai-auth/one');
    expect(fetch.mock.calls[0][1].headers['X-Internal-Secret']).toBe('private-internal');
    await expect(chatGPTConnection('../two', 'DELETE')).rejects.toThrow('Invalid TINA subject');
    vi.stubEnv('TINA_INTERNAL_API_SECRET', ''); await expect(chatGPTConnection('one', 'GET')).rejects.toThrow('not configured');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
