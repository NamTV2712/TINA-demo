import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { encodeAudioFrame, AUDIO_ACK_MODE } from '@tina/capture-codec';
import { startDesktop } from './desktop.js';
import { TranscriptJournal } from './transcript-journal.js';

const dir = mkdtempSync(join(tmpdir(),'tina-pcm-reconnect-'));
let desktop: Awaited<ReturnType<typeof startDesktop>> | undefined;
const epoch=1800000000000;
const frame=(start:number,value=.1,source=0)=>encodeAudioFrame(source,epoch+start/16,new Float32Array(1600).fill(value),'Synthetic speaker',start);
const samples=new Float32Array(1600).fill(.1);
{
  const journal=new TranscriptJournal(':memory:');
  const session=journal.captureSession('google_meet/replay','client');
  assert.equal(journal.captureSession('google_meet/replay','client'),session);
  assert.notEqual(journal.captureSession('google_meet/other','client'),session);
  assert.notEqual(journal.captureSession('google_meet/replay','other'),session);
  assert.throws(()=>journal.captureSession('meeting',''),/Invalid/);
  assert.equal(journal.receivePcm('meeting',session,0,0,epoch,samples).duplicate,false);
  assert.equal(journal.receivePcm('meeting',session,0,0,epoch,samples).duplicate,true);
  assert.throws(()=>journal.receivePcm('meeting',session,0,0,epoch,new Float32Array(1600).fill(.2)),/changed/);
  assert.throws(()=>journal.receivePcm('meeting',session,0,0,epoch+1,samples),/changed/);
  assert.throws(()=>journal.receivePcm('meeting',session,0,800,epoch+50,samples),/Overlapping/);
  assert.throws(()=>journal.receivePcm('meeting',session,0,-1,epoch,samples),/Invalid/);
  assert.equal(journal.receivePcm('meeting',session,1,0,epoch,samples).duplicate,false);
  journal.close();
}
async function connect(owner='synthetic-client',meeting='replay') {
  const ws=new WebSocket(`ws://127.0.0.1:${desktop!.ingestPort}/ingest?platform=google_meet&native_meeting_id=${meeting}&client_session=${owner}&audio_ack=${AUDIO_ACK_MODE}`);
  const [data]=await once(ws,'message');const ready=JSON.parse(String(data));
  assert.equal(ready.audio_ack,AUDIO_ACK_MODE);
  return {ws,ready};
}
async function send(ws:WebSocket,wire:ArrayBuffer) {
  const reply=once(ws,'message');ws.send(wire);return JSON.parse(String((await reply)[0]));
}
async function timeline() {return await(await fetch(`http://127.0.0.1:${desktop!.gatewayPort}/transcripts/google_meet/replay/audio-timeline`)).json() as any;}
async function close(ws:WebSocket) {const closed=once(ws,'close');ws.close();await closed;}
try {
  desktop=await startDesktop({gatewayPort:0,ingestPort:0,recordingsDir:dir,quiet:true,txUrl:''});
  const first=await connect();const session=first.ready.capture_session;
  const ack=await send(first.ws,frame(0));
  assert.deepEqual(ack,{type:'audio-ack',capture_session:session,source:0,start_sample:0,end_sample:1600});
  let status=await timeline();assert.equal(status.sources[0].stored_bytes,6400,'ACK follows durable insert');
  await close(first.ws);
  const resumed=await connect();assert.equal(resumed.ready.capture_session,session);
  assert.deepEqual(await send(resumed.ws,frame(0)),ack,'lost ACK is safe to replay');
  status=await timeline();assert.equal(status.sources[0].stored_bytes,6400);
  assert.equal(status.memory.sources,0,'duplicate PCM never feeds the new ASR ring');
  await send(resumed.ws,frame(3200,.2)); // intentional gap from Pause, never cumulative ACK
  status=await timeline();assert.equal(status.sources[0].stored_bytes,12800);
  await close(resumed.ws);await desktop.close();desktop=undefined;
  desktop=await startDesktop({gatewayPort:0,ingestPort:0,recordingsDir:dir,quiet:true,txUrl:''});
  const restarted=await connect();assert.equal(restarted.ready.capture_session,session);
  assert.deepEqual(await send(restarted.ws,frame(0)),ack,'deduplication survives process restart');
  status=await timeline();assert.equal(status.sources[0].stored_bytes,12800);assert.equal(status.memory.sources,0);
  const base=`http://127.0.0.1:${desktop.gatewayPort}/transcripts/google_meet/replay/audio-timeline?session=${session}&source=0`;
  const wav=await fetch(`${base}&start_sample=0&end_sample=1600`);
  assert.equal(wav.status,200);const pcm=Buffer.from(await wav.arrayBuffer()).subarray(44);
  assert.deepEqual(pcm,Buffer.from(samples.buffer),'stored PCM stays byte-identical across replay/restart');
  assert.equal((await fetch(`${base}&start_sample=0&end_sample=4800`)).status,409,'missing range stays missing');
  const closed=once(restarted.ws,'close');
  const conflict=await send(restarted.ws,frame(0,.3));assert.equal(conflict.type,'error');await closed;
  status=await timeline();assert.equal(status.sources[0].stored_bytes,12800,'conflicting range was never acknowledged or written');
  const separate=await connect('separate-client');assert.notEqual(separate.ready.capture_session,session);
  await send(separate.ws,frame(0,.8));await close(separate.ws);
  const otherMeeting=await connect('synthetic-client','other');assert.notEqual(otherMeeting.ready.capture_session,session);await close(otherMeeting.ws);
  console.log('PASS durable PCM: exact ACK after persistence, byte-identical reconnect/restart replay, no duplicate ASR feed, gap/conflict/session isolation');
} finally {await desktop?.close();rmSync(dir,{recursive:true,force:true});}
