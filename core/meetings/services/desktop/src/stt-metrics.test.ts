import assert from 'node:assert/strict';
import { SttMetrics } from './stt-metrics.js';
import { startDesktop } from './desktop.js';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
const stats=new SttMetrics();
stats.caption({completed:false,start:100,end:100},103000);
stats.caption({completed:true,start:100,end:102.5},103000);
const captions:any=stats.snapshot();
assert.equal(captions.latency.draft_age_ms.p50_ms,3000);
assert.equal(captions.latency.confirmed_caption_lag_ms.count,1);
assert.equal(captions.latency.confirmed_caption_lag_ms.p50_ms,500);
assert.equal(captions.latency.caption_lag_ms.count,2);
for(let n=0;n<300;n++)stats.record('asr_http_ms',n);
stats.record('asr_http_ms',NaN);stats.record('asr_http_ms',-1);stats.record('private-text',1);
const view:any=stats.snapshot();
assert.equal(view.latency.asr_http_ms.count,300);assert.equal(view.latency.asr_http_ms.retained,256);
assert.equal(view.latency.asr_http_ms.p95_ms,287);assert(!('private-text' in view.latency));
const desktop=await startDesktop({ingestPort:0,gatewayPort:0,statePath:':memory:',quiet:true,txUrl:'',canAccess:s=>s!=='denied',
  initialMeetings:[{id:1,platform:'desktop',native_meeting_id:'metrics',status:'completed',start_time:new Date().toISOString(),segments:[]}]});
try {
  const base=`http://127.0.0.1:${desktop.gatewayPort}/transcripts/desktop/metrics`;
  assert.equal((await fetch(base+'/metrics',{headers:{'X-API-Key':'denied'}})).status,403);
  assert.equal((await fetch(base+'/metrics',{headers:{Origin:'https://foreign.test'}})).status,403);
  assert.equal((await fetch(base+'/metrics',{method:'POST',body:JSON.stringify({text:'private words'})})).status,422);
  assert.equal((await fetch(base+'/metrics',{method:'POST',body:JSON.stringify({ui_commit_ms:3,ui_frame_ms:15})})).status,200);
  const result:any=await(await fetch(base+'/metrics')).json();
  const validate=new Ajv2020({strict:false}).compile(JSON.parse(readFileSync(new URL('../../../contracts/stt-metrics.v1/stt-metrics.schema.json',import.meta.url),'utf8')));
  assert(validate(result),JSON.stringify(validate.errors));
  assert.equal(result.latency.ui_commit_ms.p50_ms,3);assert.equal(result.storage.pcm_bytes,0);
  assert.equal((await fetch(base+'/foundation',{headers:{'X-API-Key':'denied'}})).status,403);
  assert.equal((await fetch(base+'/foundation')).status,200);
  console.log('PASS STT metrics: bounded percentiles, invalid values, owner/origin checks, private text rejected and UI/storage snapshot');
} finally {await desktop.close();}
