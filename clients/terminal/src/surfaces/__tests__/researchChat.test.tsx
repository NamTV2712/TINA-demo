import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServicesProvider, createContainer, reg, CommandServiceId, createCommandService } from '../../platform';
import { LayoutServiceId, createLayoutService } from '../../workbench/layout';
import { Chat } from '../chat';
import { ASK_CHAT_EVENT } from '../../canvas/actions';
import { streamChatTurn } from '../chatStream';

vi.mock('../liveMeetings', () => ({ useLiveMeetings: () => [] }));
vi.mock('../chatStream', () => ({ streamChatTurn: vi.fn(async (_request, callbacks) => {
  callbacks.onDelta('Verified. citeturn0search0');
  callbacks.onReply('Verified. [Python documentation](https://docs.python.org/3/library/pathlib.html)');
  return { terminal: true, aborted: false, sawVisibleOutput: true };
}) }));
const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
afterEach(() => {
  cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals();
  if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

it('runs /research without a checkbox, preserves source links and keeps ordinary turns ordinary', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/history') ? { turns: [] } : { sessions: [] })));
  const layout = createLayoutService('sessions');
  const container = createContainer([reg(LayoutServiceId, () => layout), reg(CommandServiceId, c => createCommandService(c))]);
  render(<ServicesProvider container={container}><Chat params={{ subject: 'research-ui', session: 'research-ui-test' }} /></ServicesProvider>);
  expect(screen.queryByLabelText('Nghiên cứu & lưu ghi chú')).toBeNull();
  const composer = screen.getByPlaceholderText('Type / for skills, or ask the agent…');
  fireEvent.change(composer, { target: { value: '/research Compare the docs with our repository' } });
  fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
  const source = await screen.findByRole('link', { name: 'Python documentation' });
  expect(source.getAttribute('href')).toBe('https://docs.python.org/3/library/pathlib.html');
  expect(screen.queryByText(/turn0search0/)).toBeNull();
  expect(vi.mocked(streamChatTurn).mock.calls[0][0].research).toBe(true);
  await waitFor(() => expect(screen.getByRole('button', { name: /^Send$/ })).toBeTruthy());
  fireEvent.change(composer, { target: { value: 'An ordinary follow-up' } });
  fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
  await waitFor(() => expect(vi.mocked(streamChatTurn).mock.calls.length).toBe(2));
  expect(vi.mocked(streamChatTurn).mock.calls[1][0].research).toBeUndefined();
  await act(async () => { window.dispatchEvent(new CustomEvent(ASK_CHAT_EVENT, { detail: { prompt: 'Start a normal brief' } })); });
  expect(vi.mocked(streamChatTurn).mock.calls[2][0].research).toBeUndefined();
  fireEvent.change(composer, { target: { value: '/research' } });
  fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
  await screen.findByText(/Nhập chủ đề sau \/research/);
  expect(vi.mocked(streamChatTurn).mock.calls.length).toBe(3);
});
