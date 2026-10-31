/** Fixed-window native-microphone diagnostic; only scratch finalization, no production writes. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {TranscriptionClient} from '../../../core/meetings/modules/whisper/dist/index.js';
import {createGmeetPipeline} from '../../../core/meetings/modules/gmeet-pipeline/dist/index.js';
import {hallucinationRule} from '../../../core/meetings/modules/mixed-pipeline/dist/index.js';
import {wavPcm,encodedPcm} from './quality_ab.mjs';

const root=resolve(process.argv[2]??'');assert(process.argv[2],'Usage: mixed_speaker.mjs FROZEN_EXPERIMENT');
assert(!existsSync(root+'/run.json'),'Never overwrite an experiment');process.umask(0o077);
const planBytes=readFileSync(root+'/plan.json'),plan=JSON.parse(planBytes),sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(plan.asr.url,'http://127.0.0.1:18000');assert.equal(plan.asr.prompt,null);assert.equal(plan.repeats,3);
const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();};
const listener=()=>execFileSync('lsof',['-t','-iTCP:18000','-sTCP:LISTEN'],{encoding:'utf8'}).trim();
const before=await get(plan.asr.url+'/status'),pid=listener();assert(/^\d+$/.test(pid));
async function idle(){const h=await get('http://127.0.0.1:8056/health'),s=await get(plan.asr.url+'/status');assert.equal(h.live_sessions,0,'User capture active; retain incomplete experiment');assert.equal(s.queue.active,0);assert.equal(s.queue.waiting,0);assert.equal(s.started_at_ms,before.started_at_ms);assert.deepEqual(s.model,before.model);assert.equal(listener(),pid);}
await idle();
const files=['core/meetings/modules/whisper/dist/transcription-client.js','core/meetings/modules/gmeet-pipeline/dist/speaker-streams.js','core/meetings/modules/mixed-pipeline/dist/hallucination-gate.js','deploy/transcription/funasr/server.py'];
const fingerprints=Object.fromEntries(files.map(p=>[p,sha(readFileSync(p))]));
const run={status:'running',plan_sha256:sha(planBytes),worker_pid:pid,worker_model:before.model,started_at:new Date().toISOString(),fingerprints,rows:[],warmup:[]};
const save=()=>writeFileSync(root+'/run.json',JSON.stringify(run,null,2)+'\n',{mode:0o600});save();
let request,raw,current;
const proxy=createServer(async(req,res)=>{
 try{
  assert.equal(req.method,'POST');assert.equal(req.url,'/v1/audio/transcriptions');const chunks=[];let size=0;
  for await(const b of req){size+=b.length;assert(size<1024*1024);chunks.push(b);}const body=Buffer.concat(chunks);
  const headers={'Content-Type':req.headers['content-type'],'X-ASR-Request-ID':req.headers['x-asr-request-id'],'X-ASR-Source':'extension'};
  const form=await new Request('http://127.0.0.1/',{method:'POST',headers,body}).formData(),pcm=wavPcm(Buffer.from(await form.get('file').arrayBuffer()));
  assert.equal(sha(pcm),current.wire_pcm_sha256);assert.equal(pcm.length/2,plan.duration_s*16000);assert.equal(form.get('prompt'),null);
  assert.equal(form.get('language'),plan.asr.language);assert.equal(form.get('max_speech_duration_s'),String(plan.asr.max_speech_duration_s));assert.equal(form.get('min_silence_duration_ms'),String(plan.asr.min_silence_duration_ms));
  request={request_id:headers['X-ASR-Request-ID'],pcm_sha256:sha(pcm),samples:pcm.length/2,language:form.get('language'),prompt:null,model:form.get('model')};
  const response=await fetch(plan.asr.url+req.url,{method:'POST',headers,body,signal:AbortSignal.timeout(60000)});assert.equal(response.status,200);raw=await response.json();
  res.writeHead(response.status,{'Content-Type':'application/json'});res.end(JSON.stringify(raw));
 }catch(error){res.writeHead(502);res.end(JSON.stringify({detail:String(error)}));}
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const client=new TranscriptionClient({serviceUrl:`http://127.0.0.1:${proxy.address().port}`,model:plan.asr.model,maxRetries:0,requestTimeoutMs:60000,maxSpeechDurationSec:plan.asr.max_speech_duration_s,minSilenceDurationMs:plan.asr.min_silence_duration_ms,source:'extension'});
const rms=()=>Number(execFileSync('ps',['-o','rss=','-p',pid],{encoding:'utf8'}).trim())*1024;
try{
 const warm=plan.cases.find(c=>c.role==='warmup');const tasks=[...Object.keys(warm.arms).map(arm=>({case:warm.id,arm,repeat:-1})),...plan.schedule];
 for(const task of tasks){
  await idle();const c=plan.cases.find(c=>c.id===task.case);assert(c);current=c.arms[task.arm];const bytes=readFileSync(current.path);assert.equal(sha(bytes),current.sha256);
  const wire=wavPcm(bytes),pcm=Float32Array.from({length:wire.length/2},(_,i)=>wire.readInt16LE(i*2)/32768);assert.equal(sha(encodedPcm(pcm)),current.wire_pcm_sha256);
  raw=null;request=null;const rssBefore=rms(),at=performance.now(),decoded=await client.transcribe(pcm,plan.asr.language),http_ms=performance.now()-at;assert(raw&&request);
  const published=[],faults=[],calls=[],origin=1800000000000+c.start_s*1000;
  const lane=createGmeetPipeline({sessionId:task.case,config:{minAudioDuration:.2,maxBufferDuration:15,submitInterval:15,callbackStampedFrames:true,hallucinationFilter:text=>hallucinationRule(text)!==null},
   transcribe:async audio=>{const hash=sha(encodedPcm(audio));calls.push(hash);assert.equal(hash,current.wire_pcm_sha256,'Finalization requested another PCM range; no cached response substitution allowed');return structuredClone(decoded);},
   sink:{segment:s=>published.push(s),finalize(){}},onError:e=>faults.push(String(e))});
  const finalAt=performance.now();lane.feedAudio(0,task.arm.startsWith('headset-')?task.arm.slice(8):undefined,pcm,origin,undefined,0);await lane.dispose();
  for(const s of published){assert(s.start>=origin/1000);assert(s.end<=origin/1000+plan.duration_s+.001);}
  const status=await get(plan.asr.url+'/status');const row={...task,raw,decoded,request,http_ms,finalize_ms:performance.now()-finalAt,final_text:published.map(s=>s.text).join(' '),published,calls,faults,
   finalization_comparable:faults.length===0,source_pcm_unchanged:sha(encodedPcm(pcm))===current.wire_pcm_sha256,sampled_rss_bytes:Math.max(rssBefore,rms()),server_timing:status.recent.find(r=>r.request_id===request.request_id)??null};
  assert(row.source_pcm_unchanged);(task.repeat<0?run.warmup:run.rows).push(row);save();console.log(JSON.stringify({case:task.case,arm:task.arm,repeat:task.repeat,complete:true}));
 }
 assert.equal(run.rows.length,plan.schedule.length);assert.equal(sha(readFileSync(root+'/plan.json')),run.plan_sha256);
 for(const [p,h]of Object.entries(fingerprints))assert.equal(sha(readFileSync(p)),h);await idle();run.status='complete';run.finished_at=new Date().toISOString();save();
}catch(error){run.status='incomplete';run.error=String(error);save();throw error;}
finally{proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
