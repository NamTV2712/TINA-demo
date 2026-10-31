import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MeetingKnowledge, MeetingWikiSourceStatus } from '../MeetingKnowledge';

const openDoc = vi.fn();
vi.mock('../../ui-kit/docLinks', () => ({ useOpenEntity: () => openDoc, invalidateDocLinkCaches: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const answer = { id: 'a'.repeat(32), question: 'Ai gửi demo?', claims: [{ text: 'Minh gửi demo.', source_ids: ['s0'] }],
  sources: [{ id: 's0', kind: 'transcript', quote: 'Minh sẽ gửi demo.', speaker_name: 'Lan', start_ms: 12000, segment_id: 'seg1', revision: 0, audio_available: true }],
  stale: false, saved_path: null, coverage: { selected: 1, available: 1, bounded: false } };
function mockServer(answers: unknown[] = []) {
  const state = { documents: [{ path: 'kg/entities/project/demo.md', title: 'Demo' }], segment_count: 1, answers };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && _url.endsWith('/ask')) state.answers = [answer];
    return { ok: true, json: async () => structuredClone(state) };
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, state };
}
it('asks with this meeting only by default and saves only after explicit review', async () => {
  const { fetch } = mockServer();
  render(<MeetingKnowledge meetingId="42" />);
  await screen.findByText('Dùng Demo');
  fireEvent.change(screen.getByLabelText('Câu hỏi về cuộc họp'), { target: { value: 'Ai gửi demo?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Hỏi TINA' }));
  await screen.findByText('Minh gửi demo.');
  const ask = fetch.mock.calls.find(([url]) => url.endsWith('/ask'))!;
  expect(JSON.parse(ask[1]!.body as string)).toEqual({ question: 'Ai gửi demo?', documents: [] });
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(false);
  fireEvent.click(screen.getByText('Đề xuất cập nhật Wiki'));
  expect(screen.getByRole('region', { name: 'Duyệt bản nháp Wiki' })).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(false);
  fireEvent.click(screen.getByText('Xác nhận lưu vào Wiki'));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(true));
});
it('refreshes after revision and disables saving stale evidence', async () => {
  const { state } = mockServer([answer]);
  render(<MeetingKnowledge meetingId="42" />);
  await screen.findByText('Minh gửi demo.');
  state.answers = [{ ...answer, stale: true }];
  window.dispatchEvent(new CustomEvent('tina:transcript-corrected', { detail: { meetingId: '42' } }));
  await screen.findByText('Nguồn đã thay đổi — hãy hỏi lại trước khi dùng hoặc lưu.');
  expect((screen.getByText('Đề xuất cập nhật Wiki') as HTMLButtonElement).disabled).toBe(true);
});
it('fails closed when freshness cannot be checked and allows opening linked documents', async () => {
  const { fetch } = mockServer([answer]);
  render(<MeetingKnowledge meetingId="42" />);
  await screen.findByText('Dùng Demo');
  fireEvent.click(screen.getByText('Mở tài liệu'));
  expect(openDoc).toHaveBeenCalledWith({ path: 'kg/entities/project/demo.md' });
  fetch.mockRejectedValueOnce(new Error('offline'));
  window.dispatchEvent(new Event('focus'));
  await screen.findByText('offline');
  expect((screen.getByText('Đề xuất cập nhật Wiki') as HTMLButtonElement).disabled).toBe(true);
});

it('opens the exact source quote and saved segment audio after revalidation', async () => {
  mockServer([answer]);
  render(<MeetingKnowledge meetingId="42" />);
  const dialog = document.querySelector('dialog')!;
  dialog.showModal = () => { dialog.open = true; };
  await screen.findByText('Minh gửi demo.');
  fireEvent.click(screen.getByText('Lan · 0:12'));
  expect(await screen.findByText('Minh sẽ gửi demo.')).toBeTruthy();
  expect(screen.getByLabelText('Nghe đoạn audio gốc').getAttribute('src')).toBe('/api/transcripts/by-id/42/segments/seg1/audio');
});

it('checks source freshness when a saved Wiki page opens', async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ stale: true }) }));
  vi.stubGlobal('fetch', fetch);
  render(<MeetingWikiSourceStatus path={`wiki/meetings/42/${'a'.repeat(32)}.md`} slug="workspace-1" />);
  expect(await screen.findByText(/Nguồn đã thay đổi — hãy kiểm tra lại/)).toBeTruthy();
  expect(fetch.mock.calls.length).toBe(1);
});
