import { expect, it, vi } from 'vitest';
import { readAgentTurn, type AgentEvent } from '../src/lib/agent-chat-stream';
it('decodes fragmented Vietnamese and resumes without duplicate events or a second nonce', async () => {
  const encoder = new TextEncoder();
  const frames = 'id: 1-0\ndata: {"type":"message-delta","text":"Tiếng Việt"}\n\n';
  const bytes = encoder.encode(frames);
  let call = 0;
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new ReadableStream({ start(controller) {
    if (call++ === 0) { controller.enqueue(bytes.slice(0, 54)); controller.enqueue(bytes.slice(54)); }
    else controller.enqueue(encoder.encode(frames + 'id: 2-0\ndata: {"type":"turn-complete"}\n\n'));
    controller.close();
  } })));
  const events: AgentEvent[] = [];
  await readAgentTurn({ prompt: 'hello', session: 'mine', research: true }, new AbortController().signal, e => events.push(e), fetch);
  expect(events.map(e => e.type)).toEqual(['message-delta', 'turn-complete']);
  expect(events[0].text).toBe('Tiếng Việt');
  expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
  expect(JSON.parse(fetch.mock.calls[0][1]?.body as string).research).toBe(true);
  expect(fetch.mock.calls[1][1]?.headers).toMatchObject({ 'Last-Event-ID': '1-0' });
});
it('surfaces authentication and model failures', async () => {
  const body = { prompt: 'hello', session: 'mine' }, signal = new AbortController().signal;
  await expect(readAgentTurn(body, signal, () => {}, async () => Response.json({ detail: 'Sign in' }, { status: 401 }))).rejects.toThrow('Sign in');
  await expect(readAgentTurn(body, signal, () => {}, async () => new Response('data: {"type":"done","ok":false,"reply":"Connect ChatGPT"}\n\n'))).rejects.toThrow('Connect ChatGPT');
});
