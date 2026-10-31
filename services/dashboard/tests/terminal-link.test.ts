import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
import { GET } from '../src/app/api/config/route';
afterEach(() => vi.unstubAllEnvs());

it('builds the Terminal link from the public Host rather than the Docker bind address', async () => {
  vi.stubEnv('TINA_API_URL', 'http://gateway:8000');
  vi.stubEnv('TINA_TERMINAL_PUBLIC_PORT', '23000');
  vi.stubEnv('TINA_TERMINAL_URL', '');
  const response = await GET(new NextRequest('http://0.0.0.0:3000/api/config', {
    headers: { host: '127.0.0.1:13001' },
  }));
  expect((await response.json()).terminalUrl).toBe('http://127.0.0.1:23000/');
});

it('honors a configured public Terminal URL and refuses non-HTTP links', async () => {
  vi.stubEnv('TINA_API_URL', 'http://gateway:8000');
  const request = new NextRequest('http://dashboard/api/config', { headers: { host: 'dashboard' } });
  vi.stubEnv('TINA_TERMINAL_URL', 'https://terminal.example.test/tina');
  expect((await (await GET(request)).json()).terminalUrl).toBe('https://terminal.example.test/tina');
  vi.stubEnv('TINA_TERMINAL_URL', 'javascript:alert(1)');
  expect((await (await GET(request)).json()).terminalUrl).toBeNull();
});
