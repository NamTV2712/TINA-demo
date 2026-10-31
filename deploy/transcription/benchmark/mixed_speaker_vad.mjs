/** Paired FSMN-VAD on/off replay on frozen PCM via an isolated CPU Qwen worker. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,openSync,closeSync,existsSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {TranscriptionClient} from '../../../core/meetings/modules/whisper/dist/index.js';
import {wavPcm,encodedPcm} from './quality_ab.mjs';

const root=process.argv[2];assert(root,'Usage: mixed_speaker_vad.mjs FROZEN_VAD_STUDY');
const plan=JSON.parse(readFileSync(root+'/vad-plan.json')),sha=b=>createHash('sha256').update(b).digest('hex');
const expectedSchedules={'mixed-only':72,'probe-only':0,'trace-only':12,'mixed-plus-headsets':216,'all-sources':432};
assert(expectedSchedules[plan.scope]!==undefined);assert.equal(plan.probe_worker,'http://127.0.0.1:18018');
assert.equal(plan.baseline_worker,'http://127.0.0.1:18000');assert.equal(plan.schedule.length,expectedSchedules[plan.scope]);
const runPath=root+'/vad-run.json',logPath=root+'/worker.log';assert(!existsSync(runPath),'Never overwrite a partial or complete VAD run');let worker,fd;
const originalPlan=JSON.parse(readFileSync(plan.parent_experiment+'/plan.json'));
const baseline=JSON.parse(await(await fetch(plan.baseline_worker+'/status')).text());
const health=JSON.parse(await(await fetch('http://127.0.0.1:8056/health')).text());
assert.equal(health.live_sessions,0);assert.equal(baseline.queue.active,0);assert.equal(baseline.queue.waiting,0);
const originalSource=execFileSync('lsof',['-t','-iTCP:18000','-sTCP:LISTEN'],{encoding:'utf8'}).trim();assert(/^[0-9]+$/.test(originalSource));
fd=openSync(logPath,'a',0o600);
const sourceFiles=['deploy/transcription/funasr/server.py','.venv/funasr/lib/python3.11/site-packages/funasr/auto/auto_model.py'];
const hashes=Object.fromEntries(sourceFiles.map(f=>[f,sha(readFileSync(f))]));
const state={status:'starting',plan_sha256:sha(readFileSync(root+'/vad-plan.json')),production_started_at_ms:baseline.started_at_ms,source_hashes:hashes,rows:[],warmup:[]};
const save=()=>writeFileSync(runPath,JSON.stringify(state,null,2)+'\n',{mode:0o600});save();
const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});assert(r.ok);return r.json();};
const idle=async()=>{const h=await get('http://127.0.0.1:8056/health'),p=await get(plan.baseline_worker+'/status');assert.equal(h.live_sessions,0,'User capture active; stop the scratch experiment');assert.equal(p.queue.active,0);assert.equal(p.queue.waiting,0);assert.equal(p.started_at_ms,baseline.started_at_ms);assert.equal(execFileSync('lsof',['-t','-iTCP:18000','-sTCP:LISTEN'],{encoding:'utf8'}).trim(),originalSource);};
async function scratchStatus(){const r=await fetch(plan.probe_worker+'/status',{signal:AbortSignal.timeout(2500)});if(!r.ok)throw new Error(`Scratch ASR status ${r.status}`);return r.json();}
const runInput=async(c,arm,mode,repeat,warmup=false)=>{
 await idle();const meta=c.arms[arm],wav=readFileSync(meta.path);assert.equal(sha(wav),meta.sha256);
 const disk=wavPcm(wav),pcm=Float32Array.from({length:disk.length/2},(_,i)=>disk.readInt16LE(i*2)/32768),wire=encodedPcm(pcm);
 assert.equal(sha(wire),meta.wire_pcm_sha256);assert.equal(pcm.length,160000);
 const bodyClient=new TranscriptionClient({serviceUrl:plan.probe_worker+'/'+mode,model:'custom',maxRetries:0,requestTimeoutMs:120000,
   sampleRate:16000,maxSpeechDurationSec:15,minSilenceDurationMs:100,source:`vad-probe:${mode}:${randomUUID()}`});
 const requestSource=bodyClient['source'];const wavBody=bodyClient['float32ToWav'](pcm);assert(sha(wavBody.subarray(44))===meta.wire_pcm_sha256);
 const form=new FormData();form.set('file',new Blob([wavBody],{type:'audio/wav'}),'audio.wav');form.set('model','custom');form.set('language','en');form.set('response_format','verbose_json');form.set('timestamp_granularities','word');form.set('max_speech_duration_s','15');form.set('min_silence_duration_ms','100');
 const started=performance.now(),response=await fetch(plan.probe_worker+'/'+mode+'/v1/audio/transcriptions',{method:'POST',headers:{'X-ASR-Source':requestSource},body:form,signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);const raw=await response.json(),http_ms=performance.now()-started;
 assert(raw._vad_probe&&raw._vad_probe.mode===mode);const spans=raw._vad_probe.vad_ranges;
 if(mode==='off')assert.deepEqual(spans,[],'VAD-off arm must bypass the FSMN model');
 for(const [a,b]of spans){assert(a>=0&&b>a&&b<=10);}
 const status=await scratchStatus(),timing=status.recent.find(x=>x.request_id===requestSource.split(':')[2]);assert(timing&&timing.http_status===200&&timing.source==='unknown');
 const row={case:c.id,arm,vad_mode:mode,repeat,reference:c.reference.map(w=>({speaker:w.speaker,text:w.text,start:w.start,end:w.end})),active_speakers:c.speakers,vad_probe_calls:raw._vad_probe.inference_calls,
   text:raw.text,pcm_sha256:meta.wire_pcm_sha256,samples:pcm.length,http_ms,duration_s:10,raw:{text:raw.text,language:raw.language,duration:raw.duration,segments:raw.segments},vad_ranges:spans,
   vad_audio_s:spans.reduce((n,x)=>n+x[1]-x[0],0),vad_probe_calls:raw._vad_probe.inference_calls,server_timing:timing,source_pcm_unchanged:true,probe_cpu_device:status.model.device};
 assert.equal(row.raw.duration,10);assert.equal(status.model.asr_model,'Qwen/Qwen3-ASR-0.6B');assert.equal(status.model.vad_model,'fsmn-vad');
 return row;
};
try{
 const listener=await fetch(plan.probe_worker+'/health').then(r=>r.status).catch(()=>null);assert.equal(listener,null,'Scratch port already occupied');
 worker=spawn('/Users/jky/orca/pre-TINA/TINA/.venv/funasr/bin/python',['/Users/jky/orca/pre-TINA/TINA/deploy/transcription/benchmark/funasr_vad_probe.py'],
  {env:{...process.env,FUNASR_PORT:'18018',FUNASR_DEVICE:'cpu',FUNASR_HUB:'hf',FUNASR_MODEL:'Qwen/Qwen3-ASR-0.6B',FUNASR_MODEL_REVISION:plan.qwen_hf_cache_revision,
   HF_HUB_OFFLINE:'1',MODELSCOPE_CACHE:process.env.HOME+'/.cache/modelscope',MODELSCOPE_OFFLINE:'1',OMP_NUM_THREADS:'4',MKL_NUM_THREADS:'4'},stdio:['ignore',fd,fd]});
 let status;for(let i=0;i<600;i++){if(worker.exitCode!==null)throw new Error(`Scratch worker exited ${worker.exitCode}`);try{status=await scratchStatus();break;}catch{}if(i%10===0){state.status='loading-scratch-cpu-qwen';state.wait_s=i;save();}await new Promise(r=>setTimeout(r,1000));}
 assert(status,'Scratch Qwen worker did not load within ten minutes');assert.equal(status.model.device,'cpu');assert.equal(status.model.asr_model,baseline.model.asr_model);assert.equal(status.model.vad_model,baseline.model.vad_model);assert.equal(status.model.qwen_hf_snapshot,plan.qwen_hf_cache_revision);assert.equal(status.model.fsmn_modelscope_snapshot,plan.fsmn_vad_cache_revision);state.probe_started_at_ms=status.started_at_ms;state.probe_model=status.model;state.status='warming';save();
 for(const mode of ['fsmn','off']){const warm=await runInput(plan.warmup_case,'controlled-mix',mode,-1,true);state.warmup.push({mode,request_id:warm.server_timing.request_id,pcm_sha256:warm.pcm_sha256,elapsed_ms:warm.http_ms,text:warm.text,vad_ranges:warm.vad_ranges,vad_probe_calls:warm.vad_probe_calls});save();}
 assert(state.warmup.every(w=>w.text.trim().length>0),'Scratch Qwen warm-up must return speech in both VAD modes');
 assert(state.warmup.find(w=>w.mode==='fsmn').vad_probe_calls.some(x=>x.is_fsmn),'FSMN-on warm-up must instrument the actual VAD model call');
 assert(state.warmup.find(w=>w.mode==='off').vad_probe_calls.every(x=>!x.is_fsmn),'VAD-off warm-up must not call the FSMN model');
 state.status='running';save();
 for(const task of plan.schedule){const c=plan.cases.find(x=>x.id===task.case);assert(c);const row=await runInput(c,task.arm,task.vad_mode,task.repeat);state.rows.push(row);save();console.log(JSON.stringify({case:row.case,arm:row.arm,vad:row.vad_mode,repeat:row.repeat,complete:true}));}
 assert.equal(state.rows.length,plan.schedule.length);await idle();assert.equal(sha(readFileSync(root+'/vad-plan.json')),state.plan_sha256);
 for(const [f,h]of Object.entries(hashes))assert.equal(sha(readFileSync(f)),h,f);state.status='complete';state.finished_at=new Date().toISOString();save();
}catch(error){state.status='incomplete';state.error=String(error);save();throw error;}
finally{if(worker&&worker.exitCode===null){worker.kill('SIGTERM');await Promise.race([new Promise(r=>worker.once('close',r)),new Promise(r=>setTimeout(r,20000))]);}closeSync(fd);}
