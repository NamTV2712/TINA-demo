import assert from 'node:assert/strict';
import {ChunkedTranscriber} from './chunked-transcriber.js';
let heartbeat=()=>{};
let now=10000;
const calls:number[]=[];
const submitted:Float32Array[]=[];
const lane=await ChunkedTranscriber.create({
  turnSource:'csrc',language:'en',
  clock:{now:()=>now,setHeartbeat:fn=>{heartbeat=fn;return()=>{};}},
  transcribe:async pcm=>{
    calls.push(pcm.length/16);submitted.push(pcm.slice());
    return {text:pcm.some(v=>v>.015)?'retained tail':'forming speech',language:'en',duration:pcm.length/16000,segments:[]};
  },
  publish:()=>{},publishPending:()=>{},clearPending:()=>{},rename:()=>{},
  makeSegmenter:async()=>({appendFrame:async()=>{},reset:()=>{}}),
});
const idle=()=>new Promise(resolve=>setTimeout(resolve,30));
lane.recordTransportEvent({csrc:1,active:true,tMs:now});
await idle();
for(let i=0;i<60;i++){
  lane.feedAudio(new Float32Array(1600).fill(.01),now);now+=100;
  lane.recordTransportEvent({csrc:1,active:true,tMs:now});
}
// A previous quiet gap followed by more speech must not become a retroactive close.
for(let i=0;i<20;i++){
  lane.feedAudio(new Float32Array(1600).fill(i<5 ? 0 : .01),now);now+=100;
  lane.recordTransportEvent({csrc:1,active:true,tMs:now});
}
// First tick makes a pending hypothesis; the next must not hard-close ongoing speech.
heartbeat();await idle();
const before=calls.length;
heartbeat();await idle();
assert.equal(calls.length,before,'provisional timer does not finalize at a voiced live edge');
for(let i=0;i<5;i++){
  lane.feedAudio(new Float32Array(1600),now);now+=100;
  lane.recordTransportEvent({csrc:1,active:true,tMs:now});
}
heartbeat();await idle();
assert(calls.length>before,'a sustained quiet gap finalizes the preceding speech');
assert(calls.at(-1)!<8500 && calls.at(-1)!>8000,'cut stays inside silence and keeps its tail');
for(let i=0;i<10;i++){
  lane.feedAudio(new Float32Array(1600).fill(.02),now);now+=100;
  lane.recordTransportEvent({csrc:1,active:true,tMs:now});
}
await lane.dispose();
assert.equal(calls.at(-1),1250,'the 250ms quiet remainder and following second reach the successor');
assert(submitted.at(-1)!.slice(0,4000).every(v=>v===0));
assert(submitted.at(-1)!.slice(4000).every(v=>v===Math.fround(.02)));
console.log('silence-roll: voiced edge deferred; quiet boundary closes without discarding tail');
