/** Real-time file replay through scratch Desktop, indexed PCM and the unchanged HTTP ASR. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statfsSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startDesktop } from '../../../core/meetings/services/desktop/dist/desktop.js';
import { encodeAudioFrame, AUDIO_ACK_MODE } from '../../../core/meetings/modules/capture-codec/dist/index.js';

const require=createRequire(new URL('../../../core/meetings/services/desktop/package.json',import.meta.url));
const {WebSocket}=require('ws');
const [manifestFile,output,asrEndpoint='http://127.0.0.1:18000']=process.argv.slice(2);assert(manifestFile&&output,'Usage: acceptance_replay.mjs MANIFEST.json FRESH_OUTPUT [LOOPBACK_ASR_PROXY]');
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(asrEndpoint),'ASR proxy must be loopback HTTP');
assert(!existsSync(output),'Output must be fresh; never overwrite a previous baseline');
process.umask(0o077);mkdirSync(output,{recursive:true,mode:0o700});
const manifest=JSON.parse(readFileSync(manifestFile)),source=readFileSync(manifest.audio_path);
const sha=data=>createHash('sha256').update(data).digest('hex');assert.equal(sha(source),manifest.audio_sha256);
assert(['smoke','acceptance'].includes(manifest.purpose));
assert.equal(source.toString('ascii',0,4),'RIFF');assert.equal(source.toString('ascii',8,12),'WAVE');
let raw;
for(let offset=12;offset+8<=source.length;){const size=source.readUInt32LE(offset+4),start=offset+8;assert(start+size<=source.length);
  if(source.toString('ascii',offset,offset+4)==='fmt '){assert.equal(source.readUInt16LE(start),1);assert.equal(source.readUInt16LE(start+2),1);assert.equal(source.readUInt32LE(start+4),16000);assert.equal(source.readUInt16LE(start+14),16);}
  if(source.toString('ascii',offset,offset+4)==='data')raw=source.subarray(start,start+size);offset=start+size+(size%2);}
assert(raw?.length&&raw.length%2===0);const total=raw.length/2,duration=total/16000;
if(manifest.purpose==='acceptance')assert(duration>=2700&&duration<=3600,'Acceptance needs one continuous 45–60 minute file');
const disk=statfsSync(output);assert(disk.bavail*disk.bsize>raw.length*3+512*1024**2,'Insufficient disk for a private archive');
const write=(name,data)=>writeFileSync(`${output}/${name}`,JSON.stringify(data,null,2)+'\n');
assert.equal((await(await fetch('http://127.0.0.1:8056/health')).json()).live_sessions,0,'Real user capture is active');
const before=await(await fetch('http://127.0.0.1:18000/status')).json();assert.equal(before.queue.active,0);assert.equal(before.queue.waiting,0);
const pid=Number(execFileSync('lsof',['-t','-iTCP:18000','-sTCP:LISTEN'],{encoding:'utf8'}).trim());
write('manifest.json',manifest);write('worker-before.json',before);
let desk,ws,observer,start,origin,readySession,done=false,firstText=null,lastFinal=null,lastWire;
const acks=new Set(),finals=new Map(),conflicts=[],faults=[],samples=[];let sent=0,reconnected=false,maxSendLag=0,lastHealth=-1,lastSample=-1;
const channel=999,platform='zoom',native=`public-${manifest.meeting_id}`;
const receiptKey=e=>`${e.source}:${e.start_sample}:${e.end_sample}`;
async function connect(){
  const socket=new WebSocket(`ws://127.0.0.1:${desk.ingestPort}/ingest?platform=${platform}&native_meeting_id=${native}&client_session=public-replay&language=en&audio_ack=${AUDIO_ACK_MODE}`);
  const ready=once(socket,'message');socket.on('message',data=>{const e=JSON.parse(String(data));if(e.type==='audio-ack')acks.add(receiptKey(e));if(e.type==='error')faults.push({kind:'ingest',message:e.message});});
  const e=JSON.parse(String((await ready)[0]));assert.equal(e.type,'ready');assert.equal(e.audio_ack,AUDIO_ACK_MODE);
  if(readySession)assert.equal(e.capture_session,readySession);readySession=e.capture_session;return socket;
}
try{
  desk=await startDesktop({gatewayPort:0,ingestPort:0,recordingsDir:output+'/journal',txUrl:asrEndpoint,txModel:'custom',txToken:'',quiet:true});
  const base=`http://127.0.0.1:${desk.gatewayPort}`,path=`/transcripts/${platform}/${native}`;
  observer=new WebSocket(`${base.replace('http:','ws:')}/ws`);await once(observer,'open');
  observer.on('message',data=>{const e=JSON.parse(String(data));if(e.meeting!==`${platform}/${native}`)return;const at=start==null?null:(performance.now()-start)/1000;
    if(e.type==='health')faults.push({at,...e});
    if(e.type==='transcript'){
      for(const s of e.confirmed||[]){const previous=finals.get(s.segment_id);if(previous&&(previous.start!==s.start||previous.end!==s.end))conflicts.push({id:s.segment_id,at});finals.set(s.segment_id,s);lastFinal=at;}
      if(firstText===null&&[...(e.confirmed||[]),...(e.pending||[])].some(s=>s.text?.trim()))firstText=at;
      appendFileSync(output+'/events.jsonl',JSON.stringify({at,...e})+'\n');
    }
  });
  ws=await connect();origin=Date.now();start=performance.now();
  write('runtime.json',{gateway_port:desk.gatewayPort,ingest_port:desk.ingestPort,pid:process.pid,asr_pid:pid,source_origin_ms:origin,source_seconds:duration,started_at:new Date().toISOString(),limits:['Real recorded English conversation replay; no physical mic/browser meeting capture, Vietnamese or cross-host clock validation.','Mixed source has no real-name attribution; speaker/overlap annotations are scoring metadata only.']});
  for(let offset=0;offset<total;offset+=1600){
    await delay(Math.max(0,start+offset/16-performance.now()));const elapsed=(performance.now()-start)/1000;
    if(Math.floor(elapsed/5)!==lastHealth){lastHealth=Math.floor(elapsed/5);assert.equal((await(await fetch('http://127.0.0.1:8056/health',{signal:AbortSignal.timeout(3000)})).json()).live_sessions,0,'User capture started; stop the experiment');}
    if(!reconnected&&offset>=total/2){ws.terminate();await delay(300);ws=await connect();if(lastWire)ws.send(lastWire);reconnected=true;appendFileSync(output+'/controls.jsonl',JSON.stringify({kind:'disconnect-reconnect',source_sample:offset,at:elapsed})+'\n');}
    const pcm=Float32Array.from({length:Math.min(1600,total-offset)},(_,i)=>raw.readInt16LE((offset+i)*2)/32768);
    lastWire=Buffer.from(encodeAudioFrame(channel,origin+offset/16,pcm,undefined,offset));ws.send(lastWire);sent++;
    maxSendLag=Math.max(maxSendLag,performance.now()-start-offset/16);
    if(Math.floor(elapsed/10)!==lastSample){lastSample=Math.floor(elapsed/10);
      const rssKiB=Number(execFileSync('ps',['-o','rss=','-p',String(pid)],{encoding:'utf8'}).trim());
      const row={at:elapsed,source_seconds:offset/16000,sent,acked:acks.size,segments:finals.size,node_rss_bytes:process.memoryUsage().rss,asr_rss_bytes:rssKiB*1024};samples.push(row);appendFileSync(output+'/progress.jsonl',JSON.stringify(row)+'\n');
      write('progress.json',{status:'running',...row,first_text_seconds:firstText,max_send_lag_ms:maxSendLag});
      console.log(JSON.stringify(row));
    }
  }
  await delay(Math.max(0,start+total/16-performance.now()));const audioEnded=performance.now();
  for(let i=0;i<200&&acks.size<sent;i++)await delay(50);assert.equal(acks.size,sent,'All sent source frames require durable exact-range ACK');
  const stopped=await fetch(base+'/extension/sessions/end',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform,native_meeting_id:native}),signal:AbortSignal.timeout(180000)});assert.equal(stopped.status,200);
  const stopResponse=(performance.now()-audioEnded)/1000;
  write('document-at-stop.json',await(await fetch(base+path+'/document')).json());
  let recovered=false;
  for(let i=0;i<180;i++){
    const status=await(await fetch(base+path+'/asr-recovery')).json();
    if(status.sessions.length&&status.sessions.every(s=>s.state==='completed')){recovered=true;break;}
    assert.equal((await(await fetch('http://127.0.0.1:8056/health')).json()).live_sessions,0,'User capture started; stop the experiment');
    if(i%5===0)console.log(JSON.stringify({stage:'waiting-for-recovery',seconds:i,sessions:status.sessions.map(s=>s.state)}));
    await delay(1000);
  }
  assert(recovered,'Stop returned but recovery did not settle within 180 seconds; retain journal as incomplete');
  const stopTail=(performance.now()-audioEnded)/1000;
  const doc=await(await fetch(base+path+'/document')).json();assert(doc.segments.length>0);assert.equal(new Set(doc.segments.map(s=>s.segment_id)).size,doc.segments.length);
  const hash=createHash('sha256');
  for(let left=0;left<total;left+=30*16000){const right=Math.min(total,left+30*16000);const r=await fetch(base+path+`/audio-timeline?session=${readySession}&source=${channel}&start_sample=${left}&end_sample=${right}`);assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer()).subarray(44);
    const expected=Buffer.alloc((right-left)*4);for(let i=left;i<right;i++)expected.writeFloatLE(raw.readInt16LE(i*2)/32768,(i-left)*4);assert(bytes.equals(expected),'Archive PCM differs from the real recording');hash.update(bytes);}
  const target=doc.segments[0],endpoint=base+path+'/segments/'+encodeURIComponent(target.segment_id);
  const patch=async(revision,text)=>(await fetch(endpoint,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:revision,text})})).status;
  assert.equal(await patch(target.revision,'Reviewed public recording sentence.'),200);assert.equal(await patch(target.revision,'Stale worker attempt'),409);assert.equal(await patch(target.revision+1,null),200);
  const restored=await(await fetch(base+path+'/document')).json();assert.equal(restored.segments.find(s=>s.segment_id===target.segment_id).text,target.raw_text);
  write('document.json',doc);write('metrics.json',await(await fetch(base+path+'/metrics')).json());write('worker-after.json',await(await fetch('http://127.0.0.1:18000/status')).json());
  const summary={status:'complete',source_seconds:duration,wall_seconds:(performance.now()-start)/1000,sent_frames:sent,acked_frames:acks.size,segments:doc.segments.length,segment_id_bound_changes:conflicts,first_text_seconds:firstText,last_final_seconds:lastFinal,stop_response_seconds:stopResponse,stop_tail_seconds:stopTail,recovery_settled:true,max_send_lag_ms:maxSendLag,reconnected,archive_float32_sha256:hash.digest('hex'),faults,samples:samples.length,revision_checks:'manual edit, stale CAS 409 and Restore passed',live_edit:'Current product refuses edits while this capture is active; tested post-stop only',hardware_acceptance:'pending'};
  summary.acceptance_verdict=faults.length||conflicts.length?'failed-software-checks':'quality-not-yet-scored';write('recovery-status.json',await(await fetch(base+path+'/asr-recovery')).json());write('summary.json',summary);write('progress.json',summary);done=true;console.log(JSON.stringify(summary));
}catch(error){write('progress.json',{status:'incomplete',error:String(error),sent,acked:acks.size,segments:finals.size,source_seconds:duration});throw error;}
finally{ws?.terminate();observer?.terminate();if(desk)await desk.close();if(!done)console.error('Run incomplete; no acceptance verdict.');}
