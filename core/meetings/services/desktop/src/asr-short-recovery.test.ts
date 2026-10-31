import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {TranscriptJournal} from './transcript-journal.js';
import {AsrRecovery} from './asr-recovery.js';
import type {Meeting} from './desktop.js';
import {isHallucination} from '@tina/gmeet-pipeline';

let response:any;
const server=createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(server.address() as any).port}`,epoch=1800000000000;
try{
 assert.equal(isHallucination('Insane.'),true,'the live Gmeet default is unchanged; batch recovery selects its own policy');
 for(const [platform,text,expected,lowConfidence] of [
  ['zoom','Insane.',true,false],['teams','Yeah.',true,false],['zoom','Vâng.',true,false],
  ['google_meet','Insane.',true,false],['zoom','Thanks for watching!',false,false],
  ['zoom','It is a loop It is a loop It is a loop',false,false],['zoom','Noise speech.',false,true],
 ] as const){
  const journal=new TranscriptJournal(':memory:'),faults:string[]=[];
  const meeting:Meeting={id:1,platform,native_meeting_id:'short',status:'completed',start_time:new Date(epoch).toISOString(),segments:[]};
  const key=platform+'/short';journal.save(meeting);
  const worker=new AsrRecovery(journal,()=>false,k=>k===key?meeting:undefined,()=>{},(_key,detail)=>faults.push(detail));
  try{
   response={text,language:text==='Vâng.'?'vi':'en',duration:.8,segments:[{text,start:0,end:.8,...(lowConfidence?{avg_logprob:-2,no_speech_prob:.9}:{})}]};
   const route=worker.register({url,token:'',model:'custom',summary:{backend:'deployment',label:'Test',model:'custom',source:'environment'}},'');
   const session=journal.captureSession(key,'short-source');journal.registerAsrSession(key,session,route,'auto');
   const pcm=new Float32Array(12800).fill(.1);journal.receivePcm(key,session,999,0,epoch,pcm);worker.kick();
   let state:any;
   for(let i=0;i<300;i++){state=journal.asrStatus(key);if(state.sessions[0].state==='completed')break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(state.sessions[0].state,'completed');assert.deepEqual(faults,[]);
   assert.equal(meeting.segments.length,expected?1:0,`${platform} recovery policy for ${text}`);
   if(expected){assert.equal(meeting.segments[0].text,text);assert.equal(meeting.segments[0].start,epoch/1000);assert.equal(meeting.segments[0].end,epoch/1000+.8);}
   assert.deepEqual(journal.readSamples(key,session,999,0,12800).samples,pcm);
  }finally{await worker.close();journal.close();}
 }
 console.log('PASS recovery policy: mixed short VI/EN speech retained; Gmeet default, media/repetition/confidence guards and source clocks unchanged');
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
