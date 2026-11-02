import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceContentSearch } from '../WorkspaceContentSearch';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('searches authorized mounted workspaces and opens the matching workspace', async () => {
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ bounded: false,
    hits: url.includes('slug=shared') ? [{ path: 'wiki/budget.md', line: 3, text: 'Budget approved' }] : [] }) }));
  vi.stubGlobal('fetch', fetch);
  const open = vi.fn();
  render(<WorkspaceContentSearch mounts={[{ slug: 'home' }, { slug: 'shared', name: 'Team' }]} onOpen={open} />);
  fireEvent.click(screen.getByText('Tìm trong nội dung Knowledge'));
  fireEvent.change(screen.getByLabelText('Nội dung cần tìm'), { target: { value: 'budget' } });
  fireEvent.click(screen.getByRole('button', { name: /^Tìm nội dung$/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Team · wiki\/budget.md:3/ }));
  expect(open).toHaveBeenCalledWith('wiki/budget.md', 'shared');
  expect(fetch).toHaveBeenCalledTimes(2);
});
