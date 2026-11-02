// Run from services/dashboard with Chrome installed: node tests/workspace-editor.browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

const entry = 'virtual:workspace-editor-test';
const bundle = await build({
  configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error',
  define: { 'process.env': '{}' },
  resolve: { alias: {
    '@/stores/auth-store': 'virtual:test-auth',
    '@': fileURLToPath(new URL('../src', import.meta.url)),
  } },
  plugins: [{
    name: 'workspace-editor-test',
    resolveId(id) {
      if ([entry, 'virtual:test-auth'].includes(id)) return '\0' + id;
    },
    load(id) {
      if (id === '\0virtual:test-auth') return 'export const useAuthStore = select => select({user:{id:globalThis.testOwner}});';
      if (id === '\0' + entry) return `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {WorkspaceEditor} from '@/components/workspace/workspace-editor';
        import {MeetingKnowledge} from '@/components/meetings/meeting-knowledge';
        function App() {
          const [open, setOpen] = useState(true), [owner, setOwner] = useState('owner'), [questions, setQuestions] = useState(false);
          globalThis.testOwner = owner;
          return React.createElement(React.Fragment, null,
            React.createElement('button', {onClick: () => setOpen(!open)}, open ? 'Leave route' : 'Return route'),
            React.createElement('button', {onClick: () => setOwner(owner === 'owner' ? 'other' : 'owner')}, 'Switch owner'),
            React.createElement('button', {onClick: () => setQuestions(true)}, 'Meeting questions'),
            open ? (questions ? React.createElement(MeetingKnowledge, {meetingId:'42'}) : React.createElement(WorkspaceEditor)) : React.createElement('p', null, 'Other route'));
        }
        createRoot(document.getElementById('root')).render(React.createElement(App));`;
    },
  }],
  build: { write: false, minify: false, rollupOptions: { input: entry, output: { format: 'iife' } } },
});
const script = bundle.output.find(item => item.type === 'chunk').code;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let document = { content: 'Server original', sha256: 'a'.repeat(64), writable: true };
  let primary = 'home';
  const writes = [];
  let moved = false, deleted = false, asked = false, applied = false, askBody;
  const answer = { id: 'a'.repeat(32), question: 'Budget changed?', claims: [{ text: 'Budget increased.', source_ids: ['s0'] }],
    sources: [{ id: 's0', kind: 'transcript', meeting_id: 43, meeting_title: 'Budget meeting', speaker_name: 'Lan', start_ms: 12000, quote: 'Budget increased from ten to twelve.', audio_available: false }],
    stale: false, saved_path: null, coverage: { selected: 2, available: 2, bounded: false } };
  await page.route('http://knowledge.test/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><div id="root"></div><script src="/ui.js"></script>' });
    if (url.pathname.endsWith('/active')) return route.fulfill({ json: { active: ['home', 'other-workspace'].map(slug => ({ slug, primary: slug === primary, role: 'private', write: true })) } });
    if (url.pathname.endsWith('/tree')) return route.fulfill({ json: { files: [...(deleted ? [] : [moved ? 'notes/moved.md' : 'wiki/test.md']), 'wiki/budget.md'] } });
    if (url.pathname.endsWith('/search')) return route.fulfill({ json: { hits: [{ path: 'wiki/test.md', line: 7, text: 'Budget approved' }], scanned: 2, bounded: false } });
    if (url.pathname.endsWith('/git')) return route.fulfill({ json: { changes: [], commits: [{ sha: '1'.repeat(40), msg: 'Reviewed budget', author: 'owner' }] } });
    if (url.pathname.endsWith('/git/show')) return route.fulfill({ json: { diff: '+Budget approved' } });
    if (url.pathname.endsWith('/document/move/preview')) return route.fulfill({ json: {
      path: 'wiki/budget.md', destination: 'notes/moved.md', fingerprint: 'e'.repeat(64), warnings: [],
      changes: [{ path: 'wiki/test.md', replacements: 1, diff: '-[[Budget]]\n+[[notes/moved.md|Budget]]\n' }],
    } });
    if (url.pathname.endsWith('/document/move')) {
      assert.equal(request.postDataJSON().update_links, true);
      assert.equal(request.postDataJSON().expected_plan, 'e'.repeat(64));
      moved = true; return route.fulfill({ json: { path: 'notes/moved.md', updated_links: 1, warnings: [] } });
    }
    if (url.pathname.endsWith('/document/delete')) { deleted = true; return route.fulfill({ json: { deleted: 'notes/moved.md' } }); }
    if (url.pathname === '/api/tina/meetings') return route.fulfill({ json: { meetings: [{ id: 43, title: 'Budget meeting' }] } });
    if (url.pathname.endsWith('/ask')) { askBody = request.postDataJSON(); asked = true; return route.fulfill({ json: answer }); }
    if (url.pathname.endsWith('/apply')) { applied = true; return route.fulfill({ json: { path: 'wiki/meetings/42/a.md' } }); }
    if (url.pathname.includes('/meeting-knowledge/')) return route.fulfill({ json: { documents: [], segment_count: 1, answers: asked ? [answer] : [] } });
    if (request.method() === 'PUT') {
      const body = request.postDataJSON(); writes.push(body);
      if (body.expected_sha256 !== document.sha256) return route.fulfill({ status: 409, json: { detail: 'Document changed. Your draft was kept; reload before saving.' } });
      document = { ...document, content: body.content, sha256: 'b'.repeat(64) };
      return route.fulfill({ json: { sha256: document.sha256 } });
    }
    return route.fulfill({ json: document });
  });
  await page.route('http://knowledge.test/ui.js', route => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script }));
  await page.goto('http://knowledge.test/workspace?path=wiki/test.md');
  const edit = async () => {
    await page.getByRole('button', { name: 'Sửa văn bản', exact: true }).click();
    return page.getByRole('textbox', { name: 'Nội dung tài liệu' });
  };
  await (await edit()).fill('Unsaved owner draft');
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  assert.equal(await (await edit()).inputValue(), 'Unsaved owner draft');
  await page.getByRole('button', { name: 'Leave route' }).click();
  const unloadBlocked = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(await unloadBlocked(), true);
  primary = 'other-workspace';
  await page.evaluate(() => window.history.replaceState({}, '', '/workspace?path=wiki/test.md'));
  await page.getByRole('button', { name: 'Return route' }).click();
  assert.equal(await (await edit()).inputValue(), 'Server original');
  await page.getByRole('button', { name: 'Leave route' }).click();
  primary = 'home';
  await page.evaluate(() => window.history.replaceState({}, '', '/workspace?path=wiki/test.md'));
  await page.getByRole('button', { name: 'Return route' }).click();
  assert.equal(await (await edit()).inputValue(), 'Unsaved owner draft');
  await page.getByRole('button', { name: 'Switch owner' }).click();
  assert.equal(await (await edit()).inputValue(), 'Server original');
  await page.getByRole('button', { name: 'Switch owner' }).click();
  assert.equal(await (await edit()).inputValue(), 'Unsaved owner draft');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Đã lưu tài liệu.' }).waitFor();
  assert.equal(await unloadBlocked(), false);
  await page.getByRole('textbox', { name: 'Nội dung tài liệu' }).fill('Draft before concurrent edit');
  await page.getByRole('button', { name: 'Leave route' }).click();
  document = { ...document, content: 'Changed elsewhere', sha256: 'c'.repeat(64) };
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  assert.equal(await (await edit()).inputValue(), 'Draft before concurrent edit');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Document changed' }).waitFor();
  assert.equal(writes.at(-1).expected_sha256, 'b'.repeat(64));
  assert.equal(writes.at(-1).slug, 'home');
  assert.equal(document.content, 'Changed elsewhere');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Tải lại tài liệu', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Nội dung tài liệu' }).inputValue(), 'Draft before concurrent edit');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Tải lại tài liệu', exact: true }).click();
  assert.equal(await (await edit()).inputValue(), 'Changed elsewhere');
  await page.getByRole('button', { name: 'Leave route' }).click();
  await page.getByRole('button', { name: 'Return route' }).click();
  assert.equal(await (await edit()).inputValue(), 'Changed elsewhere');
  assert.equal(await page.getByRole('button', { name: 'Lưu', exact: true }).isDisabled(), true);
  document = { ...document, content: '---\ntitle: "Keep this YAML"\ncustom: [one, two]\n---\n# Notes\n\nBudget approved\n\n[[Budget]]\n', sha256: 'd'.repeat(64) };
  await page.getByRole('button', { name: 'Leave route' }).click();
  await page.getByRole('button', { name: 'Return route' }).click();
  await page.getByRole('link', { name: 'Budget', exact: true }).waitFor();
  const source = await edit();
  const original = await source.inputValue();
  await source.evaluate(field => { const start = field.value.indexOf('Budget approved'); field.setSelectionRange(start, start + 6); });
  await page.getByRole('button', { name: 'Đậm', exact: true }).click();
  assert.equal(await source.inputValue(), original.replace('Budget approved', '**Budget** approved'));
  await page.getByRole('textbox', { name: 'Mô tả phiên bản' }).fill('Preserve source formatting');
  await page.getByRole('button', { name: 'Lưu và ghi phiên bản', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Đã lưu tài liệu.' }).waitFor();
  assert.equal(writes.at(-1).commit_message, 'Preserve source formatting');
  assert.equal(writes.at(-1).content, original.replace('Budget approved', '**Budget** approved'));
  await page.getByRole('checkbox', { name: 'Tìm trong nội dung', exact: true }).check();
  await page.getByRole('textbox', { name: 'Tìm tài liệu' }).fill('approved');
  await page.getByRole('status').filter({ hasText: '1 kết quả' }).waitFor();
  await page.getByRole('button', { name: /wiki\/test.md:7/ }).waitFor();
  await page.getByText('Lịch sử workspace · 0 file chưa ghi phiên bản', { exact: true }).click();
  await page.getByRole('button', { name: /Reviewed budget/ }).click();
  await page.getByText('+Budget approved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await page.getByRole('link', { name: 'Budget', exact: true }).click();
  await page.locator('header strong').filter({ hasText: 'wiki/budget.md' }).waitFor();
  await page.getByText('Đổi tên, di chuyển hoặc xóa tài liệu', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Đường dẫn đích' }).fill('notes/moved.md');
  await page.getByRole('button', { name: 'Đổi tên / di chuyển', exact: true }).click();
  const moveReview = page.getByRole('region', { name: 'Duyệt di chuyển và cập nhật liên kết' });
  await moveReview.getByText('wiki/test.md · 1 liên kết', { exact: true }).waitFor();
  assert.equal(moved, false);
  await page.getByRole('button', { name: 'Hủy di chuyển', exact: true }).click();
  assert.equal(moved, false);
  await page.getByRole('button', { name: 'Đổi tên / di chuyển', exact: true }).click();
  await page.getByRole('button', { name: 'Xác nhận di chuyển và cập nhật liên kết', exact: true }).click();
  await page.locator('header strong').filter({ hasText: 'notes/moved.md' }).waitFor();
  assert.equal(moved, true);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Xóa tài liệu', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Đã xóa tài liệu.' }).waitFor();
  assert.equal(deleted, true);
  await page.getByRole('button', { name: 'Meeting questions' }).click();
  await page.getByText('Hỏi cùng các cuộc họp khác (0/4)', { exact: true }).click();
  await page.getByRole('button', { name: 'Chọn thêm cuộc họp' }).click();
  await page.getByRole('checkbox', { name: 'Budget meeting', exact: true }).check();
  await page.getByRole('textbox', { name: 'Câu hỏi về cuộc họp' }).fill('Budget changed?');
  await page.getByRole('button', { name: 'Hỏi TINA', exact: true }).click();
  await page.getByText('Budget increased.', { exact: true }).waitFor();
  assert.deepEqual(askBody.meeting_ids, [43]);
  await page.getByRole('button', { name: 'Budget meeting · Lan · 0:12', exact: true }).click();
  await page.getByRole('dialog', { name: 'Nguồn trích dẫn' }).getByText('Budget increased from ten to twelve.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  assert.equal(applied, false);
  await page.getByRole('button', { name: 'Đề xuất cập nhật Wiki', exact: true }).click();
  const appliedResponse = page.waitForResponse(response => response.url().endsWith('/apply'));
  await page.getByRole('button', { name: 'Xác nhận lưu vào Wiki', exact: true }).click();
  await appliedResponse;
  assert.equal(applied, true);
  assert.deepEqual(errors.filter(message => message !== 'Failed to load resource: the server responded with a status of 409 (Conflict)'), []);
  console.log('PASS: real reload draft recovery and conflicts, toolbar, search, history, wikilinks, preview/cancel/confirm move, delete, multi-meeting Q&A and Wiki Apply; no unexpected browser errors.');
} finally {
  await browser.close();
}
