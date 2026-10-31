/** Frozen request-level continuity-policy comparison on the existing idle HTTP worker. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {TranscriptionClient,continuityPrompt} from '../../../core/meetings/modules/whisper/dist/index.js';
import {wavPcm,encodedPcm} from './quality_ab.mjs';

const [planPath,output]=process.argv.slice(2);assert(planPath&&output,'Usage: context_policy.mjs PLAN.json FRESH_OUTPUT');
assert(!existsSync(output),'Never overwrite a comparison');process.umask(0o077);mkdirSync(output,{recursive:true,mode:0o700});
const plan=JSON.parse(readFileSync(planPath));assert(Array.isArray(plan.cases)&&plan.cases.length);
const sha=data=>createHash('sha256').update(data).digest('hex');
writeFileSync(output+'/plan.json',JSON.stringify(plan,null,2)+'\n');
const client=new TranscriptionClient({serviceUrl:'http://127.0.0.1:18000',model:'custom',maxRetries:0,maxSpeechDurationSec:15,source:'extension'});
const result={status:'running',rows:[],requests:0};
const save=()=>writeFileSync(output+'/results.json',JSON.stringify(result,null,2)+'\n');save();
try{
 for(const [index,c] of plan.cases.entries()){
  assert(typeof c.id==='string'&&typeof c.reference==='string'&&typeof c.prompt==='string');
  const health=await(await fetch('http://127.0.0.1:8056/health')).json(),status=await(await fetch('http://127.0.0.1:18000/status')).json();
  assert.equal(health.live_sessions,0);assert.equal(status.queue.active,0);assert.equal(status.queue.waiting,0);
  assert(['vi','en'].includes(c.language));const file=readFileSync(c.audio_path);assert.equal(sha(file),c.audio_sha256);
  const raw=wavPcm(file),start=c.start_sample??0,end=c.end_sample??raw.length/2;
  assert(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>start&&end<=raw.length/2&&end-start<=90*16000);
  const pcm=Float32Array.from({length:end-start},(_,i)=>raw.readInt16LE((start+i)*2)/32768);
  const hash=sha(encodedPcm(pcm));assert.equal(hash,c.pcm_sha256);
  const prompts={baseline:c.prompt,candidate:continuityPrompt(c.prompt,pcm)};
  const row={id:c.id,kind:c.kind,language:c.language,reference:c.reference,source_samples:pcm.length,pcm_sha256:hash,
   shared_decode:prompts.baseline===prompts.candidate,order:index%2?['candidate','baseline']:['baseline','candidate']};
  for(const mode of row.order){
   if(row.shared_decode&&row[row.order[0]]){row[mode]=row[row.order[0]];continue;}
   const at=performance.now(),decoded=await client.transcribe(pcm,c.language,prompts[mode]);result.requests++;
   row[mode]={prompt:prompts[mode]??null,http_ms:performance.now()-at,result:decoded};
  }
  result.rows.push(row);save();console.log(JSON.stringify({id:c.id,complete:true}));
 }
 assert.equal(result.rows.length,plan.cases.length);result.status='complete';save();
}catch(error){result.status='incomplete';result.error=String(error);save();throw error;}
