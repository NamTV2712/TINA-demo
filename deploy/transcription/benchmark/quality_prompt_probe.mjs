/** Hold short request PCM fixed; vary only continuity prompt on the existing idle ASR worker. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {TranscriptionClient} from '../../../core/meetings/modules/whisper/dist/index.js';
import {wavPcm,encodedPcm} from './quality_ab.mjs';

const [output]=process.argv.slice(2);assert(output,'Usage: quality_prompt_probe.mjs COMPLETE_AB_OUTPUT');
assert.equal(JSON.parse(readFileSync(output+'/run.json')).status,'complete');
assert(!existsSync(output+'/prompt-probe-plan.json'),'Never overwrite a probe');
process.umask(0o077);
const plan=JSON.parse(readFileSync(output+'/plan.json')),cases=[];
for(const file of plan.clips){
 const clip=JSON.parse(readFileSync(file));
 const requests=readFileSync(`${output}/${clip.meeting_id}-requests.jsonl`,'utf8').trim().split('\n').map(JSON.parse)
  .filter(r=>r.path==='live'&&r.match_kind==='unique'&&r.prompt&&r.http_status===200);
 for(const [condition,rows] of [['short',requests.filter(r=>r.samples<16000).slice(0,2)],
                              ['longer-control',requests.filter(r=>r.samples>=32000&&r.samples<=80000).slice(0,1)]]){
  for(const request of rows)cases.push({clip_file:file,condition,request});
 }
}
assert(cases.length,'No eligible requests');
writeFileSync(output+'/prompt-probe-plan.json',JSON.stringify({selection:'First two uniquely matched <1s requests and first 2–5s control with nonempty prompt per clip, by request arrival; no response-based selection.',cases},null,2)+'\n',{flag:'wx'});
const endpoint='http://127.0.0.1:18000',client=new TranscriptionClient({serviceUrl:endpoint,model:'custom',sampleRate:16000,maxSpeechDurationSec:15,source:'extension',maxRetries:0});
const rows=[];
try{
for(const [index,probe] of cases.entries()){
 const health=await(await fetch('http://127.0.0.1:8056/health')).json(),status=await(await fetch(endpoint+'/status')).json();
 assert.equal(health.live_sessions,0);assert.equal(status.queue.active,0);assert.equal(status.queue.waiting,0);
 const clip=JSON.parse(readFileSync(probe.clip_file)),request=probe.request,raw=wavPcm(readFileSync(clip.audio_path));
 const pcm=Float32Array.from({length:request.samples},(_,i)=>raw.readInt16LE((request.source_start_sample+i)*2)/32768);
 assert.equal(createHash('sha256').update(encodedPcm(pcm)).digest('hex'),request.sha256,'Probe input must match the recorded live request exactly');
 const result={clip:clip.meeting_id,condition:probe.condition,request_id:request.id,start_sample:request.source_start_sample,
  samples:request.samples,pcm_sha256:request.sha256,original_response:request.response,order:index%2?'without-then-with':'with-then-without'};
 for(const withPrompt of index%2?[false,true]:[true,false])result[withPrompt?'with_prompt':'without_prompt']=await client.transcribe(pcm,'en',withPrompt?request.prompt:undefined);
 rows.push(result);writeFileSync(output+'/prompt-probe.json',JSON.stringify({status:'running',rows},null,2)+'\n');
}
writeFileSync(output+'/prompt-probe.json',JSON.stringify({status:'complete',rows,limits:['Exact source PCM per request; fixed language/model/VAD defaults. Prompt is the only changed request field apart from diagnostic request ID.', 'Selected short-window diagnostic; not a VI/EN quality acceptance or policy rollout.']},null,2)+'\n');
console.log(JSON.stringify({cases:rows.length,short:rows.filter(r=>r.condition==='short').length,status:'complete'}));
}catch(error){writeFileSync(output+'/prompt-probe.json',JSON.stringify({status:'incomplete',rows,error:String(error)},null,2)+'\n');throw error;}
