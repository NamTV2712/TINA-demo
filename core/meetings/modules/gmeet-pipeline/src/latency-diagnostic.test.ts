import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createGmeetPipeline } from './gmeet-pipeline.js';
import { setLogger } from './log.js';
setLogger(()=>{});

async function replay(trace: boolean, throws = false) {
  const events:any[]=[],segments:any[]=[],requests:number[]=[];
  const epoch=1800000000000;
  mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:epoch});
  const pipe=createGmeetPipeline({config:{minAudioDuration:2,submitInterval:1.5,confirmThreshold:3,idleTimeoutSec:15},
    ...(trace?{onDiagnostic:(event:any)=>{assert(!('text' in event)&&!('audio' in event));events.push(event);if(throws)throw Error('observer unavailable');}}:{}),
    transcribe:async(pcm)=>{requests.push(Date.now()-epoch);return {text:'We can review this tomorrow.',segments:[{text:'We can review this tomorrow.',start:0,end:pcm.length/16000}]};},
    sink:{segment:s=>segments.push(s),draft:()=>{},finalize(){}}});
  try{
    for(let i=0;i<40;i++){
      pipe.feedAudio(0,'Synthetic channel',new Float32Array(1600).fill(.1),epoch+i*100,undefined,i*1600);
      mock.timers.tick(100);await Promise.resolve();await Promise.resolve();
    }
    for(let i=0;i<40;i++){mock.timers.tick(100);await Promise.resolve();await Promise.resolve();}
    await pipe.dispose();return {events,segments,requests};
  }finally{mock.timers.reset();}
}
const baseline=await replay(false),observed=await replay(true),failedObserver=await replay(true,true);
assert.deepEqual(observed.segments,baseline.segments);assert.deepEqual(observed.requests,baseline.requests);
assert.deepEqual(failedObserver.segments,baseline.segments);assert.deepEqual(failedObserver.requests,baseline.requests);
const request=observed.events.find(e=>e.stage==='submit');assert(request&&request.request_id>0);
assert(observed.events.some(e=>e.stage==='wait'&&e.reason==='minimum-audio'));
assert(observed.events.some(e=>e.stage==='result'&&e.request_id===request.request_id));
assert(observed.events.some(e=>e.stage==='draft'));assert(observed.events.some(e=>e.stage==='confirm'));
console.log('PASS latency diagnostic: correlated content-free decision events; observer disabled/enabled/throwing preserve requests and transcript');
