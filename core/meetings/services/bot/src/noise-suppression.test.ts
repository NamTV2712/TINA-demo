import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NoiseSuppressor,type NoiseFactory} from './noise-suppression.js';
const frame=(index:number)=>({channel:0,pcm:new Float32Array(1024).fill(index/100),stamp:1800000000000+index*64,startSample:index*1024});

test('off is exact immediate bypass without starting a process',async()=>{
  const ns=new NoiseSuppressor(()=>{throw Error('must not start');},()=>{});const value=frame(1);let out:Float32Array|undefined;
  ns.feed(value,pcm=>{out=pcm;});assert.equal(out,value.pcm);await ns.close();
  ns.setEnabled(true);ns.feed({...value,channel:-1},pcm=>{out=pcm;});assert.equal(out,value.pcm);
  assert.equal(ns.state,'starting','invalid capture is left to the existing pipeline without spawning NS');await ns.close();
});

test('failed/disabled filtering drains unacknowledged raw frames once and fences late output',async()=>{
  let emit!:(event:any)=>void;let fail!:()=>void;const sent:any[]=[],got:Float32Array[]=[];
  const factory:NoiseFactory=(event,failed)=>{emit=event;fail=failed;return{send:v=>{sent.push(v);return true;},close(){}};};
  const ns=new NoiseSuppressor(factory,()=>{});ns.setEnabled(true);
  const a=frame(1),b=frame(2);ns.feed(a,pcm=>got.push(pcm));ns.feed(b,pcm=>got.push(pcm));
  const processed=new Float32Array(1024).fill(.005);
  emit({ready:true});emit({seq:sent[0].seq,audio:Buffer.from(processed.buffer).toString('base64')});
  fail();emit({seq:sent[1].seq,audio:sent[1].audio});
  assert.equal(got.length,2);assert.deepEqual(got[0],processed);assert.equal(got[1],b.pcm);assert.equal(ns.state,'failed');
  ns.setEnabled(false);assert.equal(got.length,2);await ns.close();
});

test('capture overload fails open with every frame accounted for',async()=>{
  const got:number[]=[],ns=new NoiseSuppressor(()=>({send:()=>true,close(){}}),()=>{});ns.setEnabled(true);
  for(let i=0;i<70;i++)ns.feed(frame(i),()=>got.push(i));
  assert.deepEqual(got,Array.from({length:70},(_,i)=>i));assert.equal(ns.state,'failed');await ns.close();
});

test('graceful close flushes a final original frame before consumer shutdown',async()=>{
  let emit!:(event:any)=>void;const sent:any[]=[];let result:Float32Array|undefined;
  const ns=new NoiseSuppressor(event=>{emit=event;return{close(){},send(v:any){if(v.type==='flush')for(const item of sent)emit({seq:item.seq,audio:item.audio});else sent.push(v);return true;}};},()=>{});
  ns.setEnabled(true);ns.feed(frame(1),pcm=>result=pcm);assert.equal(result,undefined);
  await ns.close();assert.deepEqual(result,frame(1).pcm);
});
