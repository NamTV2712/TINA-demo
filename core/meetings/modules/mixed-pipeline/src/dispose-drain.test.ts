import assert from 'node:assert/strict';
import {ChunkedTranscriber} from './chunked-transcriber.js';
import {setTimeout as delay} from 'node:timers/promises';

let release!:()=>void,reset=0,calls=0;
const held=new Promise<void>(resolve=>{release=resolve;});
const confirmed:string[]=[],original=new Float32Array(32000).fill(.1);
const lane=await ChunkedTranscriber.create({
 language:'en',
 makeSegmenter:async onBoundary=>({
  appendFrame:async()=>{await held;onBoundary({kind:'silence→speaker',tMs:0,confidence:.9});},
  reset:()=>{reset++;},
 }),
 transcribe:async pcm=>{calls++;assert.deepEqual(pcm,original,'audio arriving after Stop cannot join the final request');return {text:'Keep the final source sentence.',language:'en',duration:2,segments:[{text:'Keep the final source sentence.',start:0,end:2}]};},
 publish:(_speaker,segments)=>{confirmed.push(...segments.map(s=>s.text));},
 publishPending:()=>{},clearPending:()=>{},rename:()=>{},
});
try{
 lane.feedAudio(original,0);
 let closed=false;const first=lane.dispose().then(()=>{closed=true;}),second=lane.dispose();
 lane.feedAudio(new Float32Array(16000).fill(.2),2000);
 await delay(10);assert.equal(closed,false,'Stop/reconnect must wait for an in-flight segmentation boundary');
 release();await Promise.all([first,second]);
 assert(calls>0);assert.deepEqual(confirmed,['Keep the final source sentence.']);assert.equal(reset,1);
 console.log('PASS mixed disposal: late boundary drains once, closing rejects new PCM and concurrent closes share completion');
}finally{release();await lane.dispose();}
