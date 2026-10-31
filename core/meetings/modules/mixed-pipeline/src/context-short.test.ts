import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ChunkedTranscriber} from './chunked-transcriber.js';
import type {BoundaryEvent} from './pyannote-segmenter.js';

for(const [language,context,repetition] of [
 ['en','Earlier confirmation: Yes, yes.','Yes, yes.'],
 ['vi','Xác nhận trước đó: Vâng, vâng.','Vâng, vâng.'],
]){
let emit!:(event:BoundaryEvent)=>void;
const prompts:Array<string|undefined>=[],confirmed:string[]=[],durations:number[]=[];
const lane=await ChunkedTranscriber.create({
 language,makeSegmenter:async callback=>{emit=callback;return {appendFrame:async()=>{},reset(){}};},
 transcribe:async(pcm,prompt)=>{
  prompts.push(prompt);durations.push(pcm.length/16000);
  const text=prompts.length===1?context:prompts.length===2?repetition:'Keep the next source sentence.';
  return {text,language,duration:pcm.length/16000,segments:[{text,start:0,end:pcm.length/16000}]};
 },
 publish:(_name,segments)=>confirmed.push(...segments.map(s=>s.text)),publishPending:()=>{},clearPending:()=>{},rename:()=>{},
});
async function turn(start:number,seconds:number){
 lane.feedAudio(new Float32Array(seconds*16000).fill(.1),start);
 emit({kind:'silence→speaker',tMs:start,confidence:1});
 emit({kind:'speaker→silence',tMs:start+seconds*1000,confidence:1});
 const count=confirmed.length;
 for(let i=0;i<100&&confirmed.length===count;i++)await delay(5);
 assert(confirmed.length>count,'turn must publish after its closing decode');
}
try{
 await turn(0,3);await turn(3000,.5);await turn(3500,3);
 assert.equal(prompts[0],undefined);
 assert.equal(prompts[1],undefined,'a sub-second request must not inherit the previous sentence');
 assert(prompts[2]?.includes(repetition),'long windows retain their continuity context');
 assert.deepEqual(durations,[3,.5,3],'prompt policy cannot drop or pad source audio');
 assert(confirmed.includes(repetition),'real short repetitions survive without text stripping');
 console.log(`PASS ${language} mixed short context: no inherited prompt for short PCM; long context, repeated words and source duration preserved`);
}finally{await lane.dispose();}
}
