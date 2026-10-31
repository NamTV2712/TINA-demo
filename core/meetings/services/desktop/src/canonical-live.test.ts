import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { AUDIO_ACK_MODE, encodeAudioFrame } from '@tina/capture-codec';
import { startDesktop } from './desktop.js';

const directory=mkdtempSync(join(tmpdir(),'tina-canonical-live-'));
const epoch=1800000000000, segmentId=`ch-1000:1:${epoch}`;
const raw='Bản ASR gốc được giữ nguyên.';
const late='This is a late raw ASR response that must not overwrite an accepted correction.';
const stt=createServer(async(req,res)=>{
  for await(const _ of req) { /* Drain the synthetic audio request. */ }
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({text:late,language:'en',segments:[{text:late,start:0,end:3}]}));
});
await new Promise<void>(resolve=>stt.listen(0,'127.0.0.1',resolve));
const desktop=await startDesktop({gatewayPort:0,ingestPort:0,recordingsDir:directory,quiet:true,
  txUrl:`http://127.0.0.1:${(stt.address() as any).port}`,canAccess:subject=>subject!=='denied',
  initialMeetings:[{id:1,platform:'google_meet',native_meeting_id:'canonical-live',status:'completed',start_time:new Date(epoch).toISOString(),
    segments:[{segment_id:segmentId,speaker:'You',speaker_key:'ch-1000:1',text:raw,start:epoch/1000,end:epoch/1000+3,completed:true}]}]});
const base=`http://127.0.0.1:${desktop.gatewayPort}`;
const path='/transcripts/google_meet/canonical-live';
const clients:WebSocket[]=[];
const received:any[]=[],leaked:any[]=[];
async function subscribe(key='',events=received) {
  const socket=new WebSocket(`${base.replace('http','ws')}/ws?api_key=${key}`);clients.push(socket);
  await once(socket,'open');socket.on('message',data=>events.push(JSON.parse(String(data))));
  const subscribed=once(socket,'message');socket.send(JSON.stringify({action:'subscribe',meetings:[{platform:'google_meet',native_id:'canonical-live'}]}));await subscribed;
  return socket;
}
const patch=(revision:number,text:string|null)=>fetch(base+path+'/segments/'+encodeURIComponent(segmentId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:revision,text})});
async function replay(client:string) {
  const ingest=new WebSocket(`ws://127.0.0.1:${desktop.ingestPort}/ingest?platform=google_meet&native_meeting_id=canonical-live&client_session=${client}&audio_ack=${AUDIO_ACK_MODE}`);clients.push(ingest);
  await once(ingest,'message');const ack=once(ingest,'message');ingest.send(encodeAudioFrame(1000,epoch,new Float32Array(48000).fill(.1),'You',0));
  assert.equal(JSON.parse(String((await ack)[0])).type,'audio-ack');
  const ended=await fetch(base+'/extension/sessions/end',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:'google_meet',native_meeting_id:'canonical-live'})});
  assert.equal(ended.status,200);await new Promise(r=>setTimeout(r,30));
}
try {
  await subscribe();await subscribe('denied',leaked);
  assert.equal((await patch(0,'Câu đã được chủ cuộc họp sửa.')).status,200);
  await replay('corrected-session');
  let events=received.filter(event=>event.type==='transcript');
  assert(events.some(event=>event.confirmed?.some((s:any)=>s.segment_id===segmentId&&s.text==='Câu đã được chủ cuộc họp sửa.')));
  assert(!JSON.stringify(events).includes(late),'raw ASR cannot leak over the canonical live feed');
  assert(!events.some(event=>event.pending?.some((s:any)=>s.segment_id===segmentId)),'edited rows cannot return as forming raw drafts');
  assert.equal(leaked.filter(event=>event.type==='transcript').length,0);
  let doc:any=await(await fetch(base+path+'/document')).json();
  assert.equal(doc.segments[0].raw_text,raw);assert.equal(doc.segments[0].revision,1);
  assert.equal(doc.segments[0].end_ms,epoch+3000,'late ASR cannot extend edited source timestamps');
  assert.equal((await patch(1,null)).status,200);
  received.length=0;await replay('restored-session');
  events=received.filter(event=>event.type==='transcript');
  assert(events.some(event=>event.confirmed?.some((s:any)=>s.text===raw)),'Restore stays authoritative over subsequent raw confirmations');
  assert(!JSON.stringify(events).includes(late));
  assert.equal((await patch(0,'stale edit')).status,409);
  doc=await(await fetch(base+path+'/document')).json();assert.equal(doc.segments[0].raw_text,raw);assert.equal(doc.segments[0].text,raw);assert.equal(doc.segments[0].revision,2);
  console.log('PASS canonical live wire: owner edit/Restore beat late ASR and drafts, raw/history intact, stale CAS denied and subscriber access isolated');
} finally {
  for(const socket of clients)socket.terminate();await desktop.close();stt.closeAllConnections();await new Promise<void>(r=>stt.close(()=>r()));rmSync(directory,{recursive:true,force:true});
}
