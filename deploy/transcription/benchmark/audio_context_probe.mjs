/** Diagnostic only: compare a frozen clipped request with extra source audio, never publish it. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {TranscriptionClient} from '../../../core/meetings/modules/whisper/dist/index.js';
import {wavPcm,encodedPcm} from './quality_ab.mjs';

const [planFile,output]=process.argv.slice(2);assert(planFile&&output,'Usage: audio_context_probe.mjs PLAN.json FRESH_OUTPUT');
assert(!existsSync(output));process.umask(0o077);mkdirSync(output,{recursive:true,mode:0o700});
const plan=JSON.parse(readFileSync(planFile));assert(plan.cases.length);
writeFileSync(output+'/plan.json',JSON.stringify(plan,null,2)+'\n');
const client=new TranscriptionClient({serviceUrl:'http://127.0.0.1:18000',model:'custom',maxRetries:0,maxSpeechDurationSec:15,source:'extension'});
const result={status:'running',rows:[]},save=()=>writeFileSync(output+'/results.json',JSON.stringify(result,null,2)+'\n');save();
try{
 for(const [index,c]of plan.cases.entries()){
  const h=await(await fetch('http://127.0.0.1:8056/health')).json(),s=await(await fetch('http://127.0.0.1:18000/status')).json();assert.equal(h.live_sessions,0);assert.equal(s.queue.active,0);assert.equal(s.queue.waiting,0);
  const file=readFileSync(c.audio_path);assert.equal(createHash('sha256').update(file).digest('hex'),c.audio_sha256);
  const raw=wavPcm(file),full=Float32Array.from({length:raw.length/2},(_,i)=>raw.readInt16LE(i*2)/32768);
  const row={id:c.id,clip:c.clip,rows_source_only:true};
  for(const mode of index%2?['candidate','baseline']:['baseline','candidate']){
   const [start,end]=mode==='baseline'?c.original_samples:c.context_samples;
   assert(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>start&&end<=full.length&&end-start<=15*16000);
   const pcm=full.subarray(start,end),hash=createHash('sha256').update(encodedPcm(pcm)).digest('hex');
   if(mode==='baseline')assert.equal(hash,c.request_pcm_sha256);
   row[mode]={start_sample:start,end_sample:end,pcm_sha256:hash,result:await client.transcribe(pcm,'en')};
  }
  result.rows.push(row);save();
 }
 result.status='complete';save();
}catch(error){result.status='incomplete';result.error=String(error);save();throw error;}
