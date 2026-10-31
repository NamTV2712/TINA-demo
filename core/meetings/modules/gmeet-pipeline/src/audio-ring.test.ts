import assert from 'node:assert/strict';
import {createGmeetPipeline} from './gmeet-pipeline.js';
import {SpeakerStreamManager} from './speaker-streams.js';
import {AudioTimelinePool} from '@tina/transcribe-buffer';
const sr=100,epoch=1800000000000;
const timeline=new AudioTimelinePool(2,3000,sr),archived:any[]=[],faults:any[]=[],submitted:Float32Array[]=[];
const pipe=createGmeetPipeline({timeline,sessionId:'capture',config:{sampleRate:sr,minAudioDuration:0,submitInterval:100,confirmThreshold:1},onAudioFrame:f=>archived.push(f),onError:e=>faults.push(e),
 transcribe:async audio=>{submitted.push(audio);return {text:'heard',duration:audio.length/sr,language:'en',segments:[{text:'heard',start:0,end:audio.length/sr}]};},sink:{segment:()=>{},finalize:()=>{}}});
pipe.feedAudio(1000,'You',new Float32Array(100),epoch,undefined,0);
pipe.feedAudio(1000,'You',new Float32Array(100).fill(.2),epoch+99999,undefined,100);
await pipe.flush();
assert.equal(archived[1].captureMs,epoch+1000,'arrival/source jitter must not rewrite indexed time');
assert(submitted.some(pcm=>pcm.length===120&&pcm[0]===0&&pcm[20]!==0),'ASR receives 200ms pre-roll from the ring');
assert.equal(timeline.stats.sources,1);await pipe.dispose();assert.equal(timeline.stats.sources,0);
const manager=new SpeakerStreamManager({sampleRate:sr,maxRetainedDuration:30,submitInterval:999});
manager.addSpeaker('voice','Voice');let overflow=0;manager.onOverflow=n=>overflow+=n;
for(let i=0;i<40;i++)manager.feedAudio('voice',new Float32Array(100).fill(.1),epoch+i*1000);
assert(overflow>0);assert((manager as any).buffers.get('voice').totalSamples<=sr*30);manager.removeAll();
const limiting=new SpeakerStreamManager();let limit=0;limiting.onLimit=n=>limit=n;
for(let i=0;i<33;i++)limiting.addSpeaker(String(i),'Voice');assert.equal(limit,32);assert.equal((limiting as any).buffers.size,32);limiting.removeAll();
console.log('PASS ASR ring integration: source clock, archived PCM, onset pre-roll, bounded pending audio and active turns');

// A stalled backend and rapid name rotations must have bounded live requests and still drain.
{
 let release=false;const held:Array<()=>void>=[];let calls=0;
 const pool=new AudioTimelinePool(2,3000,100);
 const stress=createGmeetPipeline({timeline:pool,config:{sampleRate:100,submitInterval:999},onError:()=>{},
  transcribe:async audio=>{calls++;if(!release)await new Promise<void>(resolve=>held.push(resolve));return {text:'voice',duration:audio.length/100,language:'en',segments:[{text:'voice',start:0,end:audio.length/100}]};},
  sink:{segment:()=>{},finalize:()=>{}}});
 for(let i=0;i<200;i++)stress.feedAudio(0,i%2?'A':'B',new Float32Array(10).fill(.1),epoch+i*100,undefined,i*10);
 assert(calls<=32);release=true;for(const resolve of held)resolve();await stress.dispose();assert.equal(pool.stats.sources,0);
 console.log('PASS source overload: stalled ASR, rapid rotations, bounded requests and clean drain');
}
