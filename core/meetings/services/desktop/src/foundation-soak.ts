/** Accelerated one-hour source clock. Real SQLite/crash/PCM; deterministic mock ASR. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { TranscriptJournal } from './transcript-journal.js';

const output=process.env.TINA_SOAK_OUTPUT || mkdtempSync(join(tmpdir(),'tina-hour-soak-'));
mkdirSync(output,{recursive:true,mode:0o700});
const disk=statfsSync(output);assert(disk.bavail*disk.bsize>2*1024**3,'Need 2 GiB free for the isolated PCM soak');
const path=join(output,'transcripts.sqlite'),epoch=1800000000000,key='google_meet/hour-soak';
const model=fileURLToPath(new URL('../dist/transcript-journal.js',import.meta.url));
const writer=join(output,'writer.mjs');
writeFileSync(writer,`
import {TranscriptJournal} from ${JSON.stringify('file://'+model)};
const journal=new TranscriptJournal(${JSON.stringify(path)}),epoch=${epoch},key=${JSON.stringify(key)};
const meeting=journal.load()[0]||{id:1,platform:'google_meet',native_meeting_id:'hour-soak',status:'active',start_time:new Date(epoch).toISOString(),segments:[]};
journal.save(meeting);const session=journal.captureSession(key,'stable-client');
let duplicates=0;const pcm=new Float32Array(160000);let peak=0;
for(let turn=0;turn<360;turn++)for(let channel=0;channel<3;channel++){
 pcm.fill(.1+channel*.03+(turn%9)*.001);
 const receipt=journal.receivePcm(key,session,channel,turn*160000,epoch+turn*10000,pcm,'Speaker '+channel);
 duplicates+=Number(receipt.duplicate);
 if(process.argv[2]==='crash'&&turn===180&&channel===1){process.send({type:'ack-before-crash',session});await new Promise(()=>{});}
 const id='source-'+channel+'-turn-'+turn;
 if(!meeting.segments.some(s=>s.segment_id===id)){
  const segment={segment_id:id,speaker_key:'ch-'+channel+':turn-'+turn,speaker:'Speaker '+channel,text:'Source '+channel+' turn '+turn,start:epoch/1000+turn*10,end:epoch/1000+turn*10+10,completed:true};
  meeting.segments.push(segment);journal.save(meeting,segment);
 }
 peak=Math.max(peak,process.memoryUsage().rss);
 if(channel===2&&turn%60===0)process.send({type:'progress',minutes:turn/6});
}
meeting.status='completed';journal.save(meeting);journal.close();process.send({type:'done',duplicates,peak_rss_bytes:peak});
`);
const started=performance.now();
async function run(mode:string){
  const child=fork(writer,[mode],{stdio:['ignore','inherit','inherit','ipc']});
  let result:any;
  child.on('message',(message:any)=>{
    if(message.type==='progress')console.log(JSON.stringify(message));
    if(message.type==='ack-before-crash'){result=message;child.kill('SIGKILL');}
    if(message.type==='done')result=message;
  });
  const [code,signal]=await once(child,'exit');
  assert(result);if(mode==='crash')assert.equal(signal,'SIGKILL');else assert.equal(code,0);
  return result;
}
const crash=await run('crash');
let journal=new TranscriptJournal(path),meeting=journal.load()[0];
const first:any=journal.foundation(meeting);
const original=meeting.segments[0];journal.correct(key,original,0,'User edit before reconnect');journal.close();
const resumed=await run('resume');
journal=new TranscriptJournal(path);meeting=journal.load()[0];
try {
  assert.equal(meeting.status,'completed');assert.equal(meeting.segments.length,1080);
  assert.equal(new Set(meeting.segments.map(s=>s.segment_id)).size,1080);
  assert.equal((journal as any).db.prepare('SELECT COUNT(*) AS n FROM audio_chunks').get().n,1080);
  const expected=new Float32Array(160000);
  for(const row of (journal as any).db.prepare('SELECT channel,start_sample,pcm FROM audio_chunks ORDER BY channel,start_sample').iterate()){
    const turn=row.start_sample/160000;expected.fill(.1+row.channel*.03+(turn%9)*.001);
    assert(Buffer.from(row.pcm).equals(Buffer.from(expected.buffer)),'All archived source bytes must match');
  }
  const doc:any=journal.document(meeting);assert.equal(doc.segments[0].text,'User edit before reconnect');assert.equal(doc.segments[0].revision,1);
  for(const channel of [0,1,2])for(const turn of [0,180,359]){
    const s=meeting.segments.find(s=>s.segment_id===`source-${channel}-turn-${turn}`)!;
    const clip=journal.clip(key,s);assert(clip);expected.fill(.1+channel*.03+(turn%9)*.001);
    assert(clip.subarray(44).equals(Buffer.from(expected.buffer)),'Beginning/middle/end playback is exact');
  }
  journal.correct(key,original,1,null);
  const final:any=journal.foundation(meeting);
  assert.equal(final.meeting_uid,first.meeting_uid);assert.equal(final.segments.length,1080);
  const restored=final.segments.find((s:any)=>s.segment_id===original.segment_id);
  assert.equal(restored.revision,2);assert.equal(restored.raw_text,restored.text);
  assert(final.segments.every((s:any)=>s.audio.length===1&&s.audio[0].end_sample-s.audio[0].start_sample===160000));
  writeFileSync(join(output,'foundation.json'),JSON.stringify(final));
  const summary={source_clock_seconds:3600,wall_seconds:(performance.now()-started)/1000,sources:3,segments:1080,
    acknowledged_source_bytes:1080*160000*4,replayed_duplicates:resumed.duplicates,peak_writer_rss_bytes:resumed.peak_rss_bytes,
    crash:'SIGKILL after durable ACK and before transcript commit',checks:['no lost/duplicate PCM','no duplicate segment IDs','source byte equality','beginning/middle/end playback','edit survives replay','Restore revision 2','stable identities across crash'],
    limits:['Accelerated source-clock test, not a one-hour wall-clock meeting or real ASR quality/latency benchmark.','Actual WebSocket crash/recovery is covered separately by asr-recovery.test.ts and pcm-reconnect.test.ts.']};
  writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
} finally {journal.close();}
