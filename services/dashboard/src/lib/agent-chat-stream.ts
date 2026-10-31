import { withBasePath } from './base-path';

export interface AgentEvent { type: string; text?: string; tool?: string; reply?: string; message?: string; ok?: boolean; sha?: string }

/** Resume the same turn, acknowledging only complete SSE frames (including split UTF-8). */
export async function readAgentTurn(body: { prompt: string; session: string; context?: unknown },
  signal: AbortSignal, onEvent: (event: AgentEvent) => void,
  fetchImpl: typeof fetch = fetch): Promise<void> {
  const payload = JSON.stringify({ ...body, turn_id: crypto.randomUUID() });
  const timeout = AbortSignal.timeout(90000);
  const combined = AbortSignal.any([signal, timeout]);
  let cursor = '';
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    combined.throwIfAborted();
    let response: Response;
    try { response = await fetchImpl(withBasePath('/api/agent/chat'), {
      method: 'POST', body: payload, signal: combined,
      headers: { 'Content-Type': 'application/json', ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
    }); } catch (error) { if (combined.aborted) throw error; else continue; }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || `Agent request failed (${response.status}).`);
    }
    if (!response.body) throw new Error('The agent returned no stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch (error) { if (combined.aborted) throw error; else break; }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const lines = frame.split('\n');
          const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event: AgentEvent = JSON.parse(data);
          const id = lines.find(l => l.startsWith('id:'))?.slice(3).trim();
          if (id && seen.has(id)) continue;
          onEvent(event);
          if (id) { seen.add(id); cursor = id; }
          if (event.type === 'error' || event.type === 'stream-error' || event.type === 'rejected'
            || (event.type === 'done' && event.ok === false)) throw new Error(event.message || event.reply || event.text || 'The agent could not complete this turn.');
          if (event.type === 'turn-complete') return;
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  throw new Error('Connection ended before completion. Open this session again to check its history.');
}
