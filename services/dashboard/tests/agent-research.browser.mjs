// From services/dashboard: node tests/agent-research.browser.mjs (installed Chrome required).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';
const entry = 'virtual:research-test';
const bundle = await build({
  configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error',
  define: { 'process.env': '{}' }, esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/stores/auth-store': 'virtual:research-auth', '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  plugins: [{ name: 'research-fixture',
    resolveId(id) { if ([entry, 'virtual:research-auth'].includes(id)) return '\0' + id; },
    load(id) {
      if (id === '\0virtual:research-auth') return 'export const useAuthStore = select => select({user:{id:"owner"}});';
      if (id === '\0' + entry) return `
        import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
        import {AgentChat} from '@/components/agent/agent-chat';
        import {WorkspaceEditor} from '@/components/workspace/workspace-editor';
        function App(){const [knowledge,setKnowledge]=useState(false);return React.createElement(React.Fragment,null,
          React.createElement('button',{onClick:()=>setKnowledge(!knowledge)},knowledge?'Chat':'Open Knowledge'),
          knowledge?React.createElement(WorkspaceEditor):React.createElement(AgentChat));}
        createRoot(document.getElementById('root')).render(React.createElement(App));`;
    },
  }],
  build: { write: false, minify: false, rollupOptions: { input: entry, output: { format: 'iife' } } },
});
const code = bundle.output.find(item => item.type === 'chunk').code;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reply = 'Đã lưu ghi chú. [Python pathlib](https://docs.python.org/3/library/pathlib.html)';
const note = `---\ntype: research\ncreated_at: 2026-11-03T17:00:00+00:00\n---\n# Research proof\n\n| source_type | source | evidence version | verified_at |\n| --- | --- | --- | --- |\n| meeting | Meeting 42 · segment 3 | revision 2 | 2026-11-03 |\n| repo | docs/design.md | commit abc123 | 2026-11-03 |\n| web | [Python pathlib](https://docs.python.org/3/library/pathlib.html) | accessed page | 2026-11-03 |`;
try {
  const page = await browser.newPage();
  const errors = [], requests = [], historyReads = [];
  let session = '', saved = false;
  page.on('pageerror', error => { errors.push(error.message); console.error('Fixture page error:', error.message); });
  await page.route('https://research.test/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = data => route.fulfill({ json: data });
    if (url.pathname === '/ui.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: code });
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><div id="root"></div><script src="/ui.js"></script>' });
    if (url.pathname === '/api/agent/chat') {
      const body = request.postDataJSON(); requests.push(body); session = body.session; saved = true;
      const events = [{ type: 'message-delta', text: 'Đã lưu. citeturn0search0' }, { type: 'done', ok: true, reply }, { type: 'turn-complete' }];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map((event, i) => `id: ${i + 1}-0\ndata: ${JSON.stringify(event)}\n\n`).join('') });
    }
    if (url.pathname === '/api/agent/sessions') return json({ sessions: session ? [{ session, title: 'Research proof' }] : [] });
    if (url.pathname.endsWith('/history')) { historyReads.push(url.pathname); return json({ turns: [{ role: 'user', text: 'Research Python' }, { role: 'agent', text: reply }] }); }
    if (url.pathname.endsWith('/active')) return json({ active: [{ slug: 'personal', role: 'private', write: true, primary: true }] });
    if (url.pathname.endsWith('/tree')) return json({ files: saved ? ['notes/research/research-proof.md'] : [] });
    if (url.pathname.endsWith('/document')) return json({ content: note, sha256: 'a'.repeat(64), writable: true });
    if (url.pathname.endsWith('/git')) return json({ branch: 'main', changes: [], commits: [] });
    return json({});
  });
  await page.goto('https://research.test/');
  await page.getByLabel('Nghiên cứu & lưu ghi chú').check();
  await page.getByLabel('Tin nhắn cho agent').fill('Research Python with workspace and web evidence');
  await page.getByRole('button', { name: 'Gửi', exact: true }).click();
  await page.getByRole('link', { name: 'Python pathlib', exact: true }).waitFor();
  assert.equal(requests[0].research, true);
  assert.equal(await page.getByText(/turn0search0/).count(), 0);
  assert.equal(new URL(page.url()).searchParams.get('agentSession'), session);
  await page.reload();
  const source = page.getByRole('link', { name: 'Python pathlib', exact: true });
  await source.waitFor();
  assert.equal(await source.getAttribute('href'), 'https://docs.python.org/3/library/pathlib.html');
  assert.equal(historyReads.at(-1), `/api/agent/sessions/${session}/history`);
  assert.equal(await page.getByLabel('Nghiên cứu & lưu ghi chú').isChecked(), false);
  await page.getByRole('button', { name: 'Open Knowledge', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^research$/ }).click();
  await page.getByRole('button', { name: 'research-proof.md', exact: true }).click();
  await page.getByRole('columnheader', { name: 'verified_at', exact: true }).waitFor();
  for (const kind of ['meeting', 'repo', 'web']) assert.equal(await page.getByRole('cell', { name: kind, exact: true }).count(), 1);
  assert.equal(await page.getByRole('link', { name: 'Python pathlib', exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: research opt-in, final source links, Dashboard session/reload persistence, and Knowledge source-type/version/date table.');
} finally { await browser.close(); }
