import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Chat } from '../chat';
import { ServicesProvider, createContainer, reg, CommandServiceId, createCommandService } from '../../platform';
import { LayoutServiceId, createLayoutService } from '../../workbench/layout';

vi.mock('../liveMeetings', () => ({ useLiveMeetings: () => [] }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('hydrates earlier questions, assistant paragraphs and descriptive tools after a fresh page load', async () => {
  const fetch = vi.fn(async (url: string) => Response.json(url.endsWith('/history') ? { turns: [
    { role: 'user', text: '<!--tina:user-input-below-->Earlier question' },
    { role: 'agent', text: 'Earlier answer.\n\nYour brief is ready.', ops: [{ label: 'tool', tool: 'Bash' }] },
    { role: 'user', text: 'Latest question' },
    { role: 'agent', text: 'Latest answer.' },
  ] } : { sessions: [] }));
  vi.stubGlobal('fetch', fetch);
  const container = createContainer([
    reg(LayoutServiceId, () => createLayoutService('sessions')),
    reg(CommandServiceId, services => createCommandService(services)),
  ]);
  render(<ServicesProvider container={container}><Chat params={{ subject: 'history-test', session: 'reloaded' }} /></ServicesProvider>);
  await screen.findByText('Earlier question');
  expect(screen.getByText('Your brief is ready.')).toBeTruthy();
  expect(screen.getByText('Latest question')).toBeTruthy();
  expect(screen.getByText('Latest answer.')).toBeTruthy();
  expect(screen.getByText('Running · Bash')).toBeTruthy();
  expect(screen.queryByText('Working')).toBeNull();
});
