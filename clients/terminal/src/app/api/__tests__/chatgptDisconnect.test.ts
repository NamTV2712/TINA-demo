import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../models/openai/logout/route';
const mocks = vi.hoisted(() => ({ subject: vi.fn(), connection: vi.fn(), cancel: vi.fn() }));
vi.mock('../../../lib/chatgptPlanAuth', () => ({ currentTinaSubject: mocks.subject, chatGPTConnection: mocks.connection, cancelPendingChatGPTAuth: mocks.cancel }));
beforeEach(() => { vi.resetAllMocks(); mocks.subject.mockResolvedValue('user-one'); mocks.connection.mockResolvedValue({}); });
const request = (origin = 'http://127.0.0.1:23000') => new NextRequest('http://127.0.0.1:23000/api/models/openai/logout', { method: 'POST', headers: { origin, host: '127.0.0.1:23000' } });
describe('ChatGPT disconnect', () => {
  it('uses only the signed-in subject and returns no credentials', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ connected: false });
    expect(mocks.connection).toHaveBeenCalledWith('user-one', 'DELETE'); expect(mocks.cancel).toHaveBeenCalledWith('user-one');
  });
  it('rejects cross-site, malformed origin and anonymous calls', async () => {
    expect((await POST(request('https://foreign.invalid'))).status).toBe(403);
    expect((await POST(request('not a URL'))).status).toBe(403);
    mocks.subject.mockResolvedValue(null); expect((await POST(request())).status).toBe(401);
    expect(mocks.connection).not.toHaveBeenCalled();
  });
  it('does not pretend disconnect succeeded on an upstream failure', async () => {
    mocks.connection.mockRejectedValue(Error('private upstream error'));
    const response = await POST(request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private upstream error');
  });
});
