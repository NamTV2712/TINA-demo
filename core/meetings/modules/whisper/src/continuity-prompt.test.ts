import assert from 'node:assert/strict';
import {continuityPrompt,TranscriptionClient} from './transcription-client.js';

const text='Nội dung trước đó. Earlier confirmed sentence.',short=new Float32Array(31999).fill(.1),copy=short.slice();
assert.equal(continuityPrompt(text,short),undefined);
assert.equal(continuityPrompt(text,new Float32Array(32000)),text);
assert.equal(continuityPrompt(text,new Float32Array(16000),8000),text);
assert.equal(continuityPrompt('',new Float32Array(32000)),undefined);
assert.deepEqual(short,copy,'context selection never changes PCM');
const fetch=globalThis.fetch;
try{
 globalThis.fetch=async(_url,options)=>{
  const body=Buffer.from(options!.body as Buffer).toString();
  assert(body.includes('explicit vocabulary hint'),'direct/refinement prompts remain explicit, independent of live continuity policy');
  return Response.json({text:'Vâng, vâng. Yes, yes.',language:'Vietnamese',duration:short.length/16000,segments:[]});
 };
 const result=await new TranscriptionClient({serviceUrl:'http://asr.test',maxRetries:0}).transcribe(short,'vi','explicit vocabulary hint');
 assert.equal(result.text,'Vâng, vâng. Yes, yes.','the policy never strips repeated recognized words');
 const replies=[{text:'你好',language:'Chinese',segments:[]},{text:'Yes.',language:'English',segments:[]}];
 globalThis.fetch=async(_url,options)=>{
  assert(!Buffer.from(options!.body as Buffer).toString().includes('name="prompt"'));
  return Response.json(replies.shift());
 };
 const held=await new TranscriptionClient({serviceUrl:'http://asr.test',maxRetries:0}).transcribe(short,'vi-en',continuityPrompt(text,short));
 assert.equal(held.text,'');assert.deepEqual(held.segments,[]);assert.equal(held.language_review?.original.text,'你好');
 console.log('PASS continuity context: actual PCM duration, two-second edge, sample rate, unchanged audio/text and explicit refinement hints');
}finally{globalThis.fetch=fetch;}
