/** Virtual-clock policy experiment: constant ASR oracle, not a recognition benchmark. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createGmeetPipeline, setLogger } from '../../../core/meetings/modules/gmeet-pipeline/src/index.js';
const [output]=process.argv.slice(2);assert(output,'Usage: tsx caption_latency.ts FRESH_OUTPUT');
mkdirSync(output,{recursive:false,mode:0o700});setLogger(()=>{});
const config={minAudioDuration:2,submitInterval:1.5,confirmThreshold:3,maxBufferDuration:30,idleTimeoutSec:15};
const cases:any[]=[];
for(const speechMs of [600,4000])for(const httpMs of [0,150,1000])for(const endAtSpeech of [false,true]){
  const epoch=1800000000000,events:any[]=[],captions:any[]=[];let firstText:number|null=null,firstFinal:number|null=null;
  mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:epoch});
  const pipe=createGmeetPipeline({config,onDiagnostic:e=>events.push({...e,at_ms:e.at_ms-epoch}),
    transcribe:async(pcm)=>{await new Promise(r=>setTimeout(r,httpMs));return {text:'We can review this tomorrow.',segments:[{text:'We can review this tomorrow.',start:0,end:pcm.length/16000}]};},
    sink:{draft:s=>{if(s.text.trim()&&firstText===null)firstText=Date.now()-epoch;},segment:s=>{if(firstFinal===null)firstFinal=Date.now()-epoch;captions.push(s);},finalize(){}}});
  const tick=async()=>{mock.timers.tick(50);for(let i=0;i<8;i++)await Promise.resolve();};
  try{
    const feedUntil=endAtSpeech?speechMs+400:20000;
    for(let at=0;at<feedUntil;at+=100){
      pipe.feedAudio(0,'Synthetic channel',new Float32Array(1600).fill(at<speechMs?.1:0),epoch+at,undefined,at*16);
      await tick();await tick();
    }
    const dispose=pipe.dispose();
    for(let i=0;i<100;i++)await tick();await dispose;
    const submits=events.filter(e=>e.stage==='submit');
    assert(submits.length&&firstFinal!==null);assert(events.every(e=>!('text' in e)&&!('audio' in e)));
    if(endAtSpeech)assert(firstFinal<=speechMs+400+2*httpMs+100,'Explicit finalization must settle bounded in-flight/final requests');
    cases.push({speech_ms:speechMs,http_ms:httpMs,control:endAtSpeech?'explicit-stop':'continue-silence',
      first_draft_ms:firstText,first_final_ms:firstFinal,final_after_speech_ms:firstFinal-speechMs,requests:submits.length,
      first_submit_ms:submits[0].at_ms,confirm_reasons:events.filter(e=>e.stage==='confirm').map(e=>e.reason),events});
  }finally{mock.timers.reset();}
}
const result={kind:'virtual-clock-policy-investigation',config,cases,limits:['Constant synthetic text and controlled HTTP delay; no recognition quality, human speech, GPU or physical capture measurement.','Only the current per-channel Gmeet path is isolated here. Mixed lane uses different endpoint/confirmation policy.','No production threshold or scheduling change is applied.']};
writeFileSync(output+'/policy.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(cases.map(({events,...c})=>c),null,2));
