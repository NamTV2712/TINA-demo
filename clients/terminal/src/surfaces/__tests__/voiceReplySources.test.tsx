import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { VoiceReplySources } from '../VoiceReplySources';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('removes revoked source quotes and aborts the old meeting request on unmount', async () => {
  vi.useFakeTimers(); let allowed = true; const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    signals.push(init.signal);
    return { ok: true, json: async () => allowed ? { sources: [{ id: 'ctx-' + 'a'.repeat(64), kind: 'transcript', quote: 'Lan phụ trách demo.', segment_id: 'demo', speaker_name: 'Lan', start_ms: 42000 }], unavailable: 0 }
      : { sources: [], unavailable: 1 } };
  }));
  let mounted: ReturnType<typeof render>;
  await act(async () => { mounted = render(<VoiceReplySources base="/api/meetings/1/voice-assistant" requestId="reply" />); });
  expect(screen.getByText('Lan phụ trách demo.')).toBeTruthy();
  expect(screen.getByText('Lan · 0:42')).toBeTruthy();
  allowed = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByText('Lan phụ trách demo.')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('không còn được chia sẻ');
  mounted!.unmount(); expect(signals.at(-1)!.aborted).toBe(true);
});

it('keeps untrusted source markup as text and clears quotes when revalidation fails', async () => {
  vi.useFakeTimers(); let online = true;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!online) throw Error('offline');
    return { ok: true, json: async () => ({ sources: [{ id: 'ctx-' + 'b'.repeat(64), kind: 'document', path: 'wiki/demo.md', paragraph: 1, quote: '<img src=x onerror=alert(1)>' }], unavailable: 0 }) };
  }));
  const { container } = await act(async () => render(<VoiceReplySources base="/api/meetings/1/voice-assistant" requestId="reply" />));
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy(); expect(container.querySelector('img')).toBeNull();
  online = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByText('<img src=x onerror=alert(1)>')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Chưa kiểm tra được nguồn');
});
