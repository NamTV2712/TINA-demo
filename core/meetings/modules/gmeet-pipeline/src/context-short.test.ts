import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createGmeetPipeline} from './gmeet-pipeline.js';
import {SpeakerStreamManager} from './speaker-streams.js';

const context='Earlier confirmed text must not dominate a short utterance.';
mock.method(SpeakerStreamManager.prototype,'getLastConfirmedText',()=>context);
try{
 for(const seconds of [.5,2]){
  const prompts:Array<string|undefined>=[],published:string[]=[];
  const pipeline=createGmeetPipeline({config:{minAudioDuration:.2,submitInterval:3600,confirmThreshold:1},
   transcribe:async(pcm,prompt)=>{prompts.push(prompt);return {text:'Please keep both copies, yes yes.',language:'en',duration:pcm.length/16000,segments:[{text:'Please keep both copies, yes yes.',start:0,end:pcm.length/16000}]};},
   sink:{segment:s=>published.push(s.text),finalize(){}}});
  pipeline.feedAudio(0,'Test speaker',new Float32Array(seconds*16000).fill(.1),1800000000000,undefined,0);
  await pipeline.dispose();
  assert(prompts.length>0);assert(prompts.every(p=>p===(seconds<2?undefined:context)));
  assert(published.includes('Please keep both copies, yes yes.'));
 }
 console.log('PASS per-channel context: short flush omits inherited text; two-second window and real repetitions survive');
}finally{mock.restoreAll();}
