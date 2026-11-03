import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ServicesProvider, createContainer, reg } from '../../platform';
import { LayoutServiceId, createLayoutService } from '../../workbench/layout';
import { registry } from '../../contributions';
import * as api from '../workspaceApi';
import '../workspace';

vi.mock('../workspaceApi', async (original) => ({
  ...(await original<typeof import('../workspaceApi')>()), readWorkspaceFile: vi.fn(),
}));
vi.mock('../../ui-kit/MdxDoc', () => ({ MdxDoc: ({ children }: { children: string }) => <div>{children}</div> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['initial', 'focus'])('ignores a late %s read after switching documents', async (kind) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  let finishOld!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finishOld = resolve; });
  vi.mocked(api.readWorkspaceFile).mockImplementation((path) => path === 'notes/b.md'
    ? Promise.resolve('CONTENT_B') : pending);
  if (kind === 'focus') vi.mocked(api.readWorkspaceFile).mockResolvedValueOnce('CONTENT_A');
  const Comp = registry.tabComponent('doc')!;
  const container = createContainer([reg(LayoutServiceId, () => createLayoutService('files'))]);
  const view = render(<ServicesProvider container={container}><Comp id="doc:preview" params={{ path: 'notes/a.md' }} active /></ServicesProvider>);
  if (kind === 'focus') {
    await screen.findByText('CONTENT_A');
    window.dispatchEvent(new Event('focus'));
  }
  await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('notes/a.md', undefined));
  view.rerender(<ServicesProvider container={container}><Comp id="doc:preview" params={{ path: 'notes/b.md' }} active /></ServicesProvider>);
  await screen.findByText('CONTENT_B');
  await act(async () => finishOld('OLD_RESPONSE'));
  expect(screen.getByText('b.md')).toBeTruthy();
  expect(screen.getByText('CONTENT_B')).toBeTruthy();
  expect(screen.queryByText('OLD_RESPONSE')).toBeNull();
});
