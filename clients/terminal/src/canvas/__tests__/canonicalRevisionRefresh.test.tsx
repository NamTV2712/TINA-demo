import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { createElement } from 'react';
const fetchDurableTranscript = vi.fn();
vi.mock('../../surfaces/liveMeetings', () => ({
  useLiveMeetings: () => [{ id: '42', native_id: 'room', session_uid: 'uid', platform: 'google_meet', status: 'stopped' }],
  fetchDurableTranscript: (...args: unknown[]) => fetchDurableTranscript(...args),
  mergeNotesById: (a: unknown[], b: unknown[]) => [...(a ?? []), ...(b ?? [])],
}));
vi.mock('../../surfaces/meetingLive', () => ({ useMeetingLive: () => ({ transcript: [{ id: 's1', speaker: 'You', text: 'late raw', completed: true }], notes: [], cards: [], errors: [], issues: [], note: '', ended: true, connected: false, reconnects: 0 }) }));
vi.mock('../../surfaces/gatewayWS', () => ({ onGatewayWSConnected: () => () => {} }));
vi.mock('../actions', () => ({ useCanvasActionState: () => ({}) }));
import { MeetingSourceProvider, useMeeting } from '../useMeeting';
const snapshot = (revision: number, text: string) => ({ lines: [{ id: 's1', revision, text, speaker: 'You', t: '00:01' }], notes: [] });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('canonical snapshot refresh', () => {
  it('retries a failed read without erasing accepted text and rejects later stale snapshots', async () => {
    vi.useFakeTimers(); fetchDurableTranscript.mockReset(); fetchDurableTranscript.mockResolvedValue(snapshot(1, 'acceptedone'));
    const wrapper = ({ children }: { children: React.ReactNode }) => createElement(MeetingSourceProvider, { meetingId: '42', children });
    const { result, unmount } = renderHook(() => useMeeting(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.transcript.segments[0].text).toBe('acceptedone');
    fetchDurableTranscript.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot(2, 'acceptedtwo'));
    await act(async () => { window.dispatchEvent(new CustomEvent('tina:transcript-corrected', { detail: { meetingId: '42' } })); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.transcript.segments[0].text).toBe('acceptedone');
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.transcript.segments[0].text).toBe('acceptedtwo');
    fetchDurableTranscript.mockResolvedValue(snapshot(0, 'stale raw'));
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.transcript.segments[0].text).toBe('acceptedtwo');
    unmount(); const calls = fetchDurableTranscript.mock.calls.length; await vi.advanceTimersByTimeAsync(5000);
    expect(fetchDurableTranscript).toHaveBeenCalledTimes(calls);
  });
});
