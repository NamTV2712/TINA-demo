import assert from 'node:assert/strict';
import {TranscriptJournal} from './transcript-journal.js';
import type {Meeting} from './desktop.js';
import {AsrRecovery} from './asr-recovery.js';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const epoch=1800000000000,key='zoom/checkpoint';
const journal=new TranscriptJournal(':memory:');
const meeting:Meeting={id:1,platform:'zoom',native_meeting_id:'checkpoint',status:'completed',start_time:new Date(epoch).toISOString(),segments:[]};
try{
 journal.save(meeting);const session=journal.captureSession(key,'source');
 journal.registerAsrSession(key,session,'original-route','en');
 journal.receivePcm(key,session,999,0,epoch,new Float32Array(48000).fill(.1));
 const segment=(id:string,start:number,end:number)=>({segment_id:id,speaker:'',speaker_key:'ch-999:test',text:`Source sentence ${id}.`,start:epoch/1000+start,end:epoch/1000+end,completed:true});
 for(const s of [segment('first',0,1),segment('last',2,3)]){meeting.segments.push(s);journal.save(meeting,s,session);}
 journal.correct(key,meeting.segments[0],0,'User edit must survive recovery.');
 journal.finishAsrCapture(session);
 let status:any=journal.asrStatus(key);
 assert.equal(status.sessions[0].state,'pending','Stop must not checkpoint audio that never produced a processed range');
 assert.deepEqual(status.checkpoints.map((s:any)=>[s.start_sample,s.end_sample]),[[0,16000],[32000,48000]]);
 const job=journal.nextAsrWindow(['original-route'])!;assert(job);
 assert.equal(job.start_sample,16000);assert.equal(job.end_sample,32000);
 journal.startAsrWindow(job.id);journal.retryAsrWindow(job);
 journal.finishAsrCapture(session);status=journal.asrStatus(key);
 assert.equal(status.sessions[0].state,'pending','Retry must remain uncheckpointed across repeated Stop');
 assert(!status.checkpoints.some((s:any)=>s.start_sample<=16000&&s.end_sample>=32000));
 journal.startAsrWindow(job.id);
 const recovered=segment(`recovery-${job.id}`,1,2),next={...meeting,segments:[...meeting.segments,recovered]};
 assert(journal.commitAsrWindow(job,next,[recovered]));
 assert.equal(journal.commitAsrWindow(job,next,[recovered]),false,'replayed completed job cannot duplicate its transcript');
 journal.finishAsrCapture(session);status=journal.asrStatus(key);
 assert.equal(status.sessions[0].state,'completed');
 assert.deepEqual(status.checkpoints.map((s:any)=>[s.start_sample,s.end_sample]),[[0,48000]]);
 const document:any=journal.document(next);
 assert.equal(document.segments[0].text,'User edit must survive recovery.');
 assert.equal(document.segments[0].raw_text,'Source sentence first.');
 assert.equal(document.segments[0].revision,1);
 assert.equal(document.segments.length,3);
 assert.deepEqual(journal.readSamples(key,session,999,0,48000).samples,new Float32Array(48000).fill(.1));
 journal.receivePcm(key,session,999,48000,epoch+3000,new Float32Array(3200).fill(.2));
 assert.equal((journal.asrStatus(key) as any).sessions[0].state,'pending','a late newly acknowledged frame must reopen a completed session');
 journal.finishAsrCapture(session);
 const late=journal.nextAsrWindow(['original-route'])!;assert(late);
 assert.deepEqual([late.start_sample,late.end_sample],[48000,51200]);
 console.log('PASS checkpoint: Stop preserves missing ranges, retries, idempotence, raw PCM and user revisions');
}finally{journal.close();}

// Near-zero tails are processed by the existing energy gate without inventing words or PCM.
const quiet=new TranscriptJournal(':memory:'),silent={...meeting,native_meeting_id:'quiet-tail',segments:[]};
const silentKey='zoom/quiet-tail';quiet.save(silent);
const faults:string[]=[],worker=new AsrRecovery(quiet,()=>false,key=>key===silentKey?silent:undefined,()=>{},(_key,detail)=>faults.push(detail));
try{
 const route=worker.register({url:'http://127.0.0.1:1',token:'',model:'custom',summary:{backend:'deployment',label:'Test',model:'custom',source:'environment'}},'');
 const session=quiet.captureSession(silentKey,'quiet-source');quiet.registerAsrSession(silentKey,session,route,'en');
 quiet.receivePcm(silentKey,session,999,0,epoch,new Float32Array(6400));
 quiet.receivePcm(silentKey,session,999,8000,epoch+500,new Float32Array(6400));
 quiet.finishAsrCapture(session);worker.kick();
 let status:any;
 for(let i=0;i<300;i++){status=quiet.asrStatus(silentKey);if(status.sessions[0].state==='completed')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(status.sessions[0].state,'completed');assert.deepEqual(faults,[]);
 assert.deepEqual(status.checkpoints.map((s:any)=>[s.start_sample,s.end_sample]),[[0,6400],[8000,14400]],'missing captured PCM never becomes covered');
 assert.equal(silent.segments.length,0,'silence must not create an empty or fabricated transcript');
 console.log('PASS quiet tail: successful energy-gate processing settles, captured gaps remain gaps, no fabricated transcript');
}finally{await worker.close();quiet.close();}

const archiveOnly=new TranscriptJournal(':memory:');
try{
 const rawMeeting={...meeting,native_meeting_id:'raw-mic-only',segments:[]},rawKey='zoom/raw-mic-only';
 archiveOnly.save(rawMeeting);const session=archiveOnly.captureSession(rawKey,'raw-source');
 archiveOnly.registerAsrSession(rawKey,session,'original-route','en');
 const pcm=new Float32Array(6400).fill(.3);
 archiveOnly.receivePcm(rawKey,session,1002,0,epoch,pcm,'You (raw)');
 archiveOnly.finishAsrCapture(session);
 assert.equal(archiveOnly.nextAsrWindow(['original-route']),null);
 assert.equal((archiveOnly.asrStatus(rawKey) as any).sessions[0].state,'completed');
 assert.deepEqual(archiveOnly.readSamples(rawKey,session,1002,0,6400).samples,pcm);
}finally{archiveOnly.close();}

// A crash/error cannot leave ACK-able PCM behind a still-completed recovery checkpoint.
const directory=mkdtempSync(join(tmpdir(),'tina-checkpoint-atomic-'));
const file=join(directory,'journal.sqlite'),atomic=new TranscriptJournal(file);
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),control=new DatabaseSync(file);
try{
 atomic.save(meeting);const session=atomic.captureSession(key,'atomic-source');
 atomic.registerAsrSession(key,session,'original-route','en');atomic.finishAsrCapture(session);
 assert.equal((atomic.asrStatus(key) as any).sessions[0].state,'completed');
 control.exec("CREATE TRIGGER fail_reopen BEFORE UPDATE OF state ON asr_sessions WHEN NEW.state='pending' BEGIN SELECT RAISE(ABORT,'simulated reopen failure'); END");
 assert.throws(()=>atomic.receivePcm(key,session,999,0,epoch,new Float32Array(6400).fill(.1)),/simulated reopen failure/);
 assert.equal((atomic.storageMetrics(key) as any).audio_chunks,0,'failed state update rolls back PCM before any ACK');
 control.exec('DROP TRIGGER fail_reopen');
 atomic.receivePcm(key,session,999,0,epoch,new Float32Array(6400).fill(.1));
 assert.equal((atomic.storageMetrics(key) as any).audio_chunks,1);
 assert.equal((atomic.asrStatus(key) as any).sessions[0].state,'pending');
 console.log('PASS late-frame atomicity: persistence/reopen roll back together before ACK; retry writes PCM once');

 const rawMic=new Float32Array(6400).fill(.3);
 atomic.receivePcm(key,session,1002,0,epoch,rawMic,'You (raw)');
 control.prepare("INSERT INTO asr_windows(id,session,source,start_sample,end_sample,start_ms,state) VALUES (?,?,?,?,?,?,?)")
  .run('legacy-raw-mic',session,1002,0,6400,epoch,'queued');
 assert.equal(atomic.nextAsrWindow(['original-route']),null,'previously queued raw AEC mic must never reach ASR');
 atomic.finishAsrCapture(session);
 assert.equal(atomic.nextAsrWindow(['original-route'])?.source,999,'normal source recovery still proceeds');
 const rawWindow=(atomic.asrStatus(key) as any).windows.find((w:any)=>w.id==='legacy-raw-mic');
 assert.equal(rawWindow.state,'superseded','legacy raw-mic jobs stop retrying');
 assert.deepEqual(atomic.readSamples(key,session,1002,0,6400).samples,rawMic,'archive-only PCM stays available');
 console.log('PASS AEC archive: raw mic remains intact and is excluded from new and legacy ASR recovery');
}finally{control.close();atomic.close();rmSync(directory,{recursive:true,force:true});}
