import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';
import { WebSocket } from 'ws';
import { AUDIO_ACK_MODE, encodeAudioFrame } from '@tina/capture-codec';
import { TranscriptJournal } from './transcript-journal.js';
import { asrRoute } from './asr-recovery.js';
import { startDesktop, type Meeting } from './desktop.js';

const directory = mkdtempSync(join(tmpdir(), 'tina-asr-recovery-'));
const epoch = 1800000000000;
const key = 'google_meet/recovery';
const meeting = (): Meeting => ({id:1,platform:'google_meet',native_meeting_id:'recovery',status:'interrupted',start_time:new Date(epoch).toISOString(),segments:[]});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, detail: string) {
  for (let i=0;i<300;i++) {if(await check())return;await sleep(20);}
  throw new Error(`Timed out: ${detail}`);
}
// Source/sample checkpoints, gap/name boundaries, transaction rollback and interrupted jobs.
{
  const path=join(directory,'unit.sqlite');let journal=new TranscriptJournal(path),m=meeting();journal.save(m);
  const session=journal.captureSession(key,'unit-client');
  journal.registerAsrSession(key,session,'pinned-route','vi-en');
  const pcm=new Float32Array(16000).fill(.1);
  for(const [start,name] of [[0,'Hà'],[16000,'Hà'],[48000,'Hà'],[64000,'Minh']] as const)
    journal.receivePcm(key,session,0,start,epoch+start/16,pcm,name);
  journal.capture(key,session,1000,epoch,new Float32Array(16000*31).fill(.2),0,epoch,'samples','You');
  const live={segment_id:'live',speaker:'Hà',speaker_key:'ch-0:1',text:'Mình sẽ kiểm tra audio.',start:epoch/1000,end:epoch/1000+1,completed:true};
  m.segments.push(live);journal.save(m,live,session);
  for(let i=0;i<6;i++)assert(journal.planAsrWindow(session));
  assert.equal(journal.planAsrWindow(session),false);
  const status=journal.asrStatus(key) as any;
  const channel=status.windows.filter((w:any)=>w.source===0).sort((a:any,b:any)=>a.start_sample-b.start_sample);
  assert.deepEqual(channel.map((w:any)=>[w.start_sample,w.end_sample]),[[16000,32000],[48000,64000],[64000,80000]]);
  assert(status.windows.every((w:any)=>w.end_sample-w.start_sample<=16000*15));
  const job=journal.nextAsrWindow(['pinned-route'])!;assert(job);journal.startAsrWindow(job.id);
  journal.close();journal=new TranscriptJournal(path);
  const resumed=journal.nextAsrWindow(['pinned-route'])!;assert.equal(resumed.id,job.id);assert.equal(resumed.attempts,1);
  journal.startAsrWindow(job.id);
  const segment={...live,segment_id:`recovery-${job.id}:one`,start:epoch/1000+1,end:epoch/1000+2,text:'Em sẽ gửi bản demo.'};
  const next={...m,segments:[...m.segments,segment]};
  const invalid={...segment,text:null} as any;
  assert.throws(()=>journal.commitAsrWindow(job,{...m,segments:[...m.segments,invalid]},[invalid]));
  assert.equal(journal.load()[0].segments.length,1,'failed result insert rolls back the meeting too');
  assert.equal((journal.asrStatus(key) as any).windows.find((w:any)=>w.id===job.id).state,'running');
  assert(journal.commitAsrWindow(job,next,[segment]));
  assert.equal(journal.commitAsrWindow(job,next,[segment]),false,'completed job cannot append twice');
  assert.equal(journal.load()[0].segments.length,2);
  journal.correct(key,segment,0,'Bản chủ cuộc họp đã sửa.');
  journal.close();journal=new TranscriptJournal(path);
  assert.equal((journal.document(journal.load()[0]) as any).segments.find((s:any)=>s.segment_id===segment.segment_id).text,'Bản chủ cuộc họp đã sửa.');
  assert.throws(()=>journal.registerAsrSession(key,session,'changed-route','vi-en'),/settings changed/);
  assert.equal(journal.nextAsrWindow(['other-route']),null,'a different backend cannot claim the source');
  // A live confirm racing a recovery request supersedes it; only the remaining samples get a job.
  const overlap=journal.nextAsrWindow(['pinned-route'])!;journal.startAsrWindow(overlap.id);
  const confirmed={...live,segment_id:'live-race',start:epoch/1000+3,end:epoch/1000+3.5};
  m=journal.load()[0];m.segments.push(confirmed);journal.save(m,confirmed,session);
  assert.equal(journal.commitAsrWindow(overlap,m,[]),false);
  assert(journal.planAsrWindow(session));
  const remainder=(journal.asrStatus(key) as any).windows.find((w:any)=>w.start_sample===56000);
  assert(remainder,'uncovered tail is replanned after a racing live confirmation');
  journal.capture('google_meet/legacy','old-capture',0,epoch,pcm,0,epoch,'samples');
  assert.equal(journal.registerAsrSession('google_meet/legacy','old-capture','unproven-route','vi'),false);
  assert.deepEqual((journal.asrStatus('google_meet/legacy') as any).sessions,[],'historical PCM cannot inherit a newly selected backend');
  journal.close();
  console.log('PASS recovery journal: bounded windows, exact checkpoints, gap/name isolation, restart, rollback, idempotence, revision safety and live race');
}

// Real process death during live ASR, then another death during recovery ASR.
let mode: 'hold'|'ok'|'fail'='hold';let requests=0;const durations:number[]=[];
const stt=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.end('{}');return;}
  requests++;
  if(mode==='hold')return;
  if(mode==='fail'){res.writeHead(503);res.end('temporarily unavailable');return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const body=Buffer.concat(chunks);
  const wav=body.indexOf(Buffer.from('RIFF'));assert(wav>=0);
  const sample=body.readInt16LE(wav+44);
  const size=body.readUInt32LE(wav+40);durations.push(size/2/16000);
  const text=sample>6000?'I will send the reviewed document tomorrow.':'Mình sẽ kiểm tra bản demo vào thứ Sáu.';
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text,language:sample>6000?'en':'vi',segments:[{text,start:0,end:size/2/16000}]}));
});
await new Promise<void>(r=>stt.listen(0,'127.0.0.1',r));
const txUrl=`http://127.0.0.1:${(stt.address() as any).port}`;
const dir=join(directory,'process');let child:ChildProcess|undefined,desktop:Awaited<ReturnType<typeof startDesktop>>|undefined;
async function boot() {
  const script=`import {startDesktop} from ${JSON.stringify(new URL('../dist/desktop.js',import.meta.url).href)};
    const desktop=await startDesktop(${JSON.stringify({ingestPort:0,gatewayPort:0,recordingsDir:dir,quiet:true,txUrl,txToken:'synthetic-provider-secret'})});
    console.log('READY '+JSON.stringify({ingestPort:desktop.ingestPort,gatewayPort:desktop.gatewayPort}));`;
  child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  let output='';let errors='';child.stdout!.on('data',b=>output+=b);child.stderr!.on('data',b=>errors+=b);
  await until(async()=>{if(child!.exitCode!==null)throw new Error(errors);return output.includes('READY ');},'Desktop child ready');
  return JSON.parse(output.split('READY ')[1].split('\n')[0]);
}
async function kill() {const exited=once(child!,'exit');child!.kill('SIGKILL');await exited;child=undefined;}
try{
  const ports=await boot();const ws=new WebSocket(`ws://127.0.0.1:${ports.ingestPort}/ingest?platform=google_meet&native_meeting_id=recovery&client_session=crash-client&audio_ack=${AUDIO_ACK_MODE}`);
  const [wire]=await once(ws,'message');const ready=JSON.parse(String(wire));
  for(const [source,value,name] of [[0,.1,'Hà'],[1000,.3,'You']] as const){
    const ack=once(ws,'message');ws.send(encodeAudioFrame(source,epoch,new Float32Array(48000).fill(value),name,0));assert.equal(JSON.parse(String((await ack)[0])).type,'audio-ack');
  }
  await until(async()=>requests>0,'live ASR request');
  await kill();ws.terminate();
  const before=requests;await boot();await until(async()=>requests>before,'recovery ASR request');
  await kill();mode='ok';
  const options={ingestPort:0,gatewayPort:0,recordingsDir:dir,quiet:true,txUrl,txToken:'synthetic-provider-secret',canAccess:(subject:string)=>subject!=='denied'};
  desktop=await startDesktop(options);
  let base=`http://127.0.0.1:${desktop.gatewayPort}/transcripts/google_meet/recovery`;
  let status:any;
  await until(async()=>{status=await(await fetch(base+'/asr-recovery')).json();return status.sessions?.length===1&&status.sessions[0].state==='completed';},'recover all acknowledged PCM');
  const validate=new Ajv2020({strict:true}).compile(JSON.parse(readFileSync(new URL('../../../contracts/asr-recovery.v1/asr-recovery.schema.json',import.meta.url),'utf8')));
  assert(validate(status),JSON.stringify(validate.errors));
  const transcript:any=await(await fetch(base)).json();
  assert.equal(transcript.segments.length,2);assert.equal(new Set(transcript.segments.map((s:any)=>s.segment_id)).size,2);
  assert.deepEqual(new Set(transcript.segments.map((s:any)=>s.speaker)),new Set(['Unknown speaker','You']));
  // The saved channel name is a hint; recovery has no verified participant ID.
  // Keep that hint for review without promoting it to a confirmed identity.
  const registry:any=await(await fetch(base+'/speakers')).json();
  assert(registry.speakers.some((s:any)=>s.candidate_name==='Hà'&&s.name===null));
  assert(transcript.segments.every((s:any)=>s.start===epoch/1000&&s.end===epoch/1000+3));
  assert(status.windows.every((w:any)=>w.state==='completed'));
  assert(status.windows.some((w:any)=>w.attempts>=2),'interrupted job reused its durable identity');
  assert(durations.every(s=>s<=15));
  assert.equal((await fetch(base+'/asr-recovery',{headers:{origin:'https://foreign.example'}})).status,403);
  assert.equal((await fetch(base+'/asr-recovery',{headers:{'X-API-Key':'denied'}})).status,403);
  await desktop.close();desktop=undefined;
  const count=requests;desktop=await startDesktop(options);base=`http://127.0.0.1:${desktop.gatewayPort}/transcripts/google_meet/recovery`;
  await sleep(1200);assert.equal(requests,count,'completed windows do not run again after restart');
  assert.equal((await(await fetch(base)).json() as any).segments.length,2);
  assert(!readFileSync(join(dir,'transcripts.sqlite')).includes(Buffer.from('synthetic-provider-secret')),'provider credential never persisted');
  await desktop.close();desktop=undefined;
  // Queued windows wait for the pinned backend and survive a transient HTTP failure.
  const retryDir=join(directory,'retry');
  const retryPath=join(directory,'retry.sqlite');const saved=new TranscriptJournal(retryPath);saved.save(meeting());
  const capture=saved.captureSession(key,'retry-client');
  const route=asrRoute({url:txUrl,token:'synthetic-provider-secret',model:'whisper-1',summary:{backend:'deployment',model:'whisper-1',label:'Deployment endpoint',source:'environment'}},'');
  saved.registerAsrSession(key,capture,route,'vi-en');saved.receivePcm(key,capture,0,0,epoch,new Float32Array(48000).fill(.1),'Hà');saved.close();
  const retryOptions={...options,recordingsDir:retryDir,statePath:retryPath};
  const noCalls=requests;desktop=await startDesktop({...retryOptions,txModel:'different-model'});
  base=`http://127.0.0.1:${desktop.gatewayPort}/transcripts/google_meet/recovery`;
  await until(async()=>((await(await fetch(base+'/asr-recovery')).json()) as any).sessions[0]?.state==='blocked','pinned backend unavailable');
  assert.equal(requests,noCalls,'recovery never sends source audio to a substituted backend');
  await desktop.close();desktop=undefined;mode='fail';desktop=await startDesktop(retryOptions);
  base=`http://127.0.0.1:${desktop.gatewayPort}/transcripts/google_meet/recovery`;
  await until(async()=>((await(await fetch(base+'/asr-recovery')).json()) as any).windows.some((w:any)=>w.state==='retry'),'ASR failure retained for retry');
  assert.equal((await(await fetch(base)).json() as any).segments.length,0);
  await desktop.close();desktop=undefined;mode='ok';desktop=await startDesktop(retryOptions);
  base=`http://127.0.0.1:${desktop.gatewayPort}/transcripts/google_meet/recovery`;
  await until(async()=>((await(await fetch(base+'/asr-recovery')).json()) as any).sessions[0]?.state==='completed','retry after restart');
  assert.equal((await(await fetch(base)).json() as any).segments.length,1);
  console.log('PASS process recovery: SIGKILL during live/recovery HTTP → automatic source-correct VI/EN completion, original timestamps and no duplicate rows after another restart');
}finally{
  if(child)await kill();await desktop?.close();stt.closeAllConnections();await new Promise<void>(r=>stt.close(()=>r()));rmSync(directory,{recursive:true,force:true});
}
