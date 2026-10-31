/** Paired public-audio diagnostic; proxy forwards original requests and retains source attribution. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TranscriptionClient} from '../../../core/meetings/modules/whisper/dist/index.js';

const sha=data=>createHash('sha256').update(data).digest('hex');
export function wavPcm(wav){
 assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');
 let pcm,format=false;
 for(let at=12;at+8<=wav.length;){const size=wav.readUInt32LE(at+4),start=at+8;assert(start+size<=wav.length,'Truncated WAV');
  if(wav.toString('ascii',at,at+4)==='fmt '){assert(size>=16);assert.equal(wav.readUInt16LE(start),1);assert.equal(wav.readUInt16LE(start+2),1);assert.equal(wav.readUInt32LE(start+4),16000);assert.equal(wav.readUInt16LE(start+14),16);format=true;}
  if(wav.toString('ascii',at,at+4)==='data')pcm=wav.subarray(start,start+size);
  at=start+size+(size%2);
 }
 assert(format&&pcm?.length&&pcm.length%2===0,'Expected mono PCM16 / 16 kHz');return pcm;
}
export function encodedPcm(pcm){
 const bytes=Buffer.alloc(pcm.length*2);
 for(let i=0;i<pcm.length;i++){const sample=Math.max(-1,Math.min(1,pcm[i]));bytes.writeInt16LE(Math.round(sample*(sample<0?32768:32767)),i*2);}
 return bytes;
}
export function locatePcm(source,request){
 const start=source.indexOf(request),next=start<0?-1:source.indexOf(request,start+2);
 const unique=start>=0&&start%2===0&&next<0;
 return {source_start_sample:unique?start/2:null,match_kind:start<0?'not-contiguous':unique?'unique':'ambiguous'};
}

async function idle(){
 const health=await(await fetch('http://127.0.0.1:8056/health',{signal:AbortSignal.timeout(3000)})).json();
 assert.equal(health.live_sessions,0,'User capture active; stop benchmark');
}
async function main(output){
 process.umask(0o077);output=resolve(output);
 const plan=JSON.parse(readFileSync(output+'/plan.json'));
 assert.equal(plan.endpoint,'http://127.0.0.1:18000');assert.equal(plan.model,'custom');assert.equal(plan.language,'en');
 assert.equal(plan.direct_window_seconds,15);assert(!existsSync(output+'/run.json'),'Never overwrite a benchmark run');
 const state={status:'running',started_at:new Date().toISOString(),completed_clips:[]};
 const save=()=>writeFileSync(output+'/run.json',JSON.stringify(state,null,2)+'\n');
 await idle();
 const before=await(await fetch(plan.endpoint+'/status')).json();assert.equal(before.queue.active,0);assert.equal(before.queue.waiting,0);
 const asrPid=execFileSync('lsof',['-t','-iTCP:18000','-sTCP:LISTEN'],{encoding:'utf8'}).trim();
 save();
 writeFileSync(output+'/worker-before.json',JSON.stringify(before,null,2)+'\n');
 let clip,wire,path='direct',number=0,proxyFailures=0;
 const proxy=createServer(async(req,res)=>{
  try{
   assert.equal(req.method,'POST');assert.equal(req.url,'/v1/audio/transcriptions');
   const chunks=[];let size=0;for await(const b of req){size+=b.length;assert(size<=25*1024*1024+65536);chunks.push(b);}
   const body=Buffer.concat(chunks),headers={'Content-Type':req.headers['content-type']};
   for(const h of ['x-asr-request-id','x-asr-source','x-asr-capture-ms'])if(req.headers[h])headers[h]=req.headers[h];
   const form=await new Request('http://127.0.0.1/',{method:'POST',headers,body}).formData();
   const wav=Buffer.from(await form.get('file').arrayBuffer()),pcm=wavPcm(wav);
   const row={id:++number,path,received_at_ms:Date.now(),samples:pcm.length/2,sha256:sha(pcm),...locatePcm(wire,pcm),
    language:form.get('language'),prompt:form.get('prompt'),min_silence_duration_ms:form.get('min_silence_duration_ms')};
   const response=await fetch(plan.endpoint+req.url,{method:'POST',headers,body,signal:AbortSignal.timeout(60000)});
   const data=await response.text();row.http_status=response.status;
   try{row.response=JSON.parse(data);}catch{row.response={detail:'Non-JSON response'};}
   appendFileSync(`${output}/${clip.meeting_id}-requests.jsonl`,JSON.stringify(row)+'\n');
   res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json'});res.end(data);
  }catch(error){proxyFailures++;appendFileSync(output+'/proxy-errors.jsonl',JSON.stringify({clip:clip?.meeting_id,path,error:String(error)})+'\n');res.writeHead(502);res.end(JSON.stringify({detail:String(error)}));}
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const endpoint=`http://127.0.0.1:${proxy.address().port}`;
 const client=new TranscriptionClient({serviceUrl:endpoint,model:'custom',sampleRate:16000,maxSpeechDurationSec:15,source:'extension'});
 try{
  for(const manifestPath of plan.clips){
   clip=JSON.parse(readFileSync(manifestPath));const wav=readFileSync(clip.audio_path);assert.equal(sha(wav),clip.audio_sha256);
   const bytes=wavPcm(wav),pcm=Float32Array.from({length:bytes.length/2},(_,i)=>bytes.readInt16LE(i*2)/32768);wire=encodedPcm(pcm);
   const direct=[];path='direct';
   for(let start=0;start<pcm.length;start+=15*16000){
    await idle();const end=Math.min(pcm.length,start+15*16000),at=performance.now();
    direct.push({start_sample:start,end_sample:end,result:await client.transcribe(pcm.subarray(start,end),'en'),http_ms:performance.now()-at});
   }
   writeFileSync(`${output}/${clip.meeting_id}-direct.json`,JSON.stringify(direct,null,2)+'\n');path='live';await idle();
   const log=openSync(`${output}/${clip.meeting_id}-live.log`,'wx',0o600);
   try{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./acceptance_replay.mjs',import.meta.url)),manifestPath,`${output}/${clip.meeting_id}`,endpoint],{stdio:['ignore',log,log]});
    const [code]=await once(child,'exit');assert.equal(code,0,'Live replay failed; inspect its retained log');
   }finally{closeSync(log);}
   assert.equal(execFileSync('lsof',['-t','-iTCP:18000','-sTCP:LISTEN'],{encoding:'utf8'}).trim(),asrPid,'ASR worker changed');
   assert.equal(proxyFailures,0,'Proxy failure invalidates the diagnostic; inspect proxy-errors.jsonl');
   state.completed_clips.push(clip.meeting_id);save();console.log(JSON.stringify({clip:clip.meeting_id,complete:true}));
  }
  state.status='complete';state.finished_at=new Date().toISOString();save();
  writeFileSync(output+'/worker-after.json',JSON.stringify(await(await fetch(plan.endpoint+'/status')).json(),null,2)+'\n');
 }catch(error){state.status='incomplete';state.error=String(error);save();throw error;}
 finally{await new Promise(r=>proxy.close(r));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert(process.argv[2],'Usage: quality_ab.mjs FROZEN_OUTPUT');await main(process.argv[2]);
}
