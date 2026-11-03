// From clients/terminal: node tests/brief-flow.browser.mjs (Chrome and Dashboard dev dependencies required).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
const require = createRequire(new URL('../../../services/dashboard/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = await import(require.resolve('vite'));

const entry = 'virtual:brief-flow';
const bundle = await build({
  configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error',
  define: { 'process.env': '{}' },
  plugins: [{
    name: 'brief-fixture', enforce: 'pre',
    resolveId(id) {
      if (id === entry) return '\0' + entry;
      if (id.endsWith('/liveMeetings')) return '\0brief-meetings';
    },
    load(id) {
      if (id === '\0brief-meetings') return 'export const useLiveMeetings=()=>globalThis.fixtureMeetings; export const refreshMeetings=()=>{};';
      if (id !== '\0' + entry) return;
      return `
        import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {ServicesProvider,createContainer,reg,CommandServiceId,createCommandService} from './src/platform';
        import {LayoutServiceId,createLayoutService} from './src/workbench/layout';
        import {registry} from './src/contributions'; import './src/surfaces/meetingPrep';
        import {Chat} from './src/surfaces/chat';
        const layout=createLayoutService('meetings');layout.setActiveTab({kind:'meetingPrep',params:{meetingId:'77'}});
        const container=createContainer([reg(LayoutServiceId,()=>layout),reg(CommandServiceId,c=>createCommandService(c))]);
        const Prep=registry.tabComponent('meetingPrep');
        const meeting={id:'77',title:'Họp kế hoạch',title_custom:'Họp kế hoạch',when:'',platform:'Google Meet',status:'past',live_status:'idle',participants:[],mentioned:[],actions:[],transcript:[],insights:[]};
        function App(){ const [shared,setShared]=useState(false);
          globalThis.fixtureMeetings=[{...meeting,workspace_id:shared?'team':undefined}];
          return React.createElement(ServicesProvider,{container},
            React.createElement('button',{onClick:()=>setShared(!shared)},shared?'Private mode':'Shared mode'),
            React.createElement(Prep,{id:'prep:77',params:{meetingId:'77'},active:true}),
            React.createElement(Chat,{params:{subject:'browser-fixture',session:'brief-test'}})); }
        createRoot(document.getElementById('root')).render(React.createElement(App));`;
    },
  }, react()],
  build: { write: false, minify: false, rollupOptions: { input: entry, output: { format: 'iife' } } },
});
const code = bundle.output.find(item => item.type === 'chunk').code;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let own = null, shared = null, failShared = false, researchSaved = false;
  const citedReply = 'Verified. [Python pathlib](https://docs.python.org/3/library/pathlib.html)';
  const requests = [];
  await page.route('http://brief.test/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/ui.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: code });
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<meta charset="utf-8"><div id="root"></div><script src="/ui.js"></script>' });
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { turns: researchSaved ? [{role:'user',text:'Research Python'}, {role:'agent',text:citedReply}] : [] } });
    if (url.pathname.endsWith('/active')) return route.fulfill({ json: { active: [{ slug: 'private-home', path: '/workspaces/owner', primary: true, role: 'private', write: true }] } });
    if (url.pathname.endsWith('/tree')) return route.fulfill({ json: { files: own ? ['kg/entities/meeting/brief-row-77.md'] : [] } });
    if (url.pathname.endsWith('/file')) {
      if (url.searchParams.get('slug') === 'team' && failShared) return route.fulfill({ status: 503, json: { detail: 'Fixture read failure' } });
      const content = url.searchParams.get('slug') === 'team' ? shared : own;
      return route.fulfill({ status: content ? 200 : 404, json: content ? { content } : { detail: 'Not found' } });
    }
    if (url.pathname === '/api/chat') {
      requests.push(request.postDataJSON()); own = '# Private brief ready';
      if (requests.at(-1).research) {
        researchSaved = true;
        const events = [{type:'message-delta',text:'Verified. citeturn0search0'},{type:'done',ok:true,reply:citedReply},{type:'turn-complete'}];
        return route.fulfill({contentType:'text/event-stream',body:events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')});
      }
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"message-delta","text":"Your brief is ready."}\n\ndata: {"type":"turn-complete"}\n\n' });
    }
    return route.fulfill({ json: { sessions: [], memberships: [] } });
  });
  await page.goto('http://brief.test/');
  await page.getByRole('button', { name: 'Start brief chat', exact: true }).click();
  await page.getByText('Your brief is ready.', { exact: true }).waitFor();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].context.focus.meeting_id, '77');
  assert.match(requests[0].prompt, /\/workspaces\/owner\/kg\/entities\/meeting\/brief-row-77\.md/);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText('Private brief ready', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Private brief ready', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Shared mode', exact: true }).click();
  await page.getByText('No brief yet.', { exact: true }).waitFor();
  await page.clock.install();
  shared = '# Shared brief ready';
  await page.clock.runFor(12050);
  await page.getByText('Shared brief ready', { exact: true }).waitFor();
  failShared = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('alert').filter({ hasText: 'Could not read the shared brief' }).waitFor();
  assert.equal(await page.getByText('Shared brief ready', { exact: true }).isVisible(), true);
  await page.getByLabel('Nghiên cứu & lưu ghi chú').check();
  await page.locator('textarea').last().fill('Research Python');
  await page.getByRole('button', {name:'Send',exact:true}).click();
  await page.getByRole('link', {name:'Python pathlib',exact:true}).waitFor();
  assert.equal(requests.at(-1).research, true);
  assert.equal(await page.getByText(/turn0search0/).count(), 0);
  await page.reload();
  const source = page.getByRole('link', {name:'Python pathlib',exact:true});
  await source.waitFor();
  assert.equal(await source.getAttribute('href'), 'https://docs.python.org/3/library/pathlib.html');
  assert.deepEqual(errors, []);
  console.log('PASS: Start brief delivery, explicit meeting/private path, same-file reload recovery, shared polling and stale-good render during a read failure.');
} finally { await browser.close(); }
