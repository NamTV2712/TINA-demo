import assert from 'node:assert/strict';
import vm from 'node:vm';
import {WORKLET_SRC,createPcmCaptureNode} from './pcm-capture.js';
let Processor:any;
const messages:any[]=[];
const sandbox:any={AudioWorkletProcessor:class{port={postMessage:(x:any)=>messages.push(x)}},Float32Array,currentFrame:0,registerProcessor:(_name:string,p:any)=>{Processor=p}};
vm.runInNewContext(WORKLET_SRC,sandbox);
const processor=new Processor();
for(let i=0;i<64;i++){sandbox.currentFrame=i*128;processor.process([[new Float32Array(128).fill(.1)]]);}
assert.deepEqual(messages.map(m=>m.startFrame),[0,4096]);
sandbox.currentFrame=12000;
for(let i=0;i<32;i++){sandbox.currentFrame=12000+i*128;processor.process([[new Float32Array(128).fill(.2)]]);}
assert.equal(messages[2].startFrame,12000);
let node:any;
(globalThis as any).AudioWorkletNode=class{port:any={};constructor(){node=this}};
const received:any[]=[];
const old=Date.now;Date.now=()=>10000;
const context:any={currentTime:0,sampleRate:16000,audioWorklet:{addModule:async()=>{}}};
await createPcmCaptureNode(context,(pcm,timeline)=>received.push({pcm,timeline}),'local-worklet');
for(const data of messages){Date.now=()=>999999;node.port.onmessage({data});}
Date.now=old;
assert.deepEqual(received.map(r=>r.timeline.startSample),[0,4096,12000]);
assert.equal(received[1].timeline.captureMs,10256);
assert.equal(received[2].timeline.captureMs,10750);
assert.deepEqual(received[0].pcm,new Float32Array(4096).fill(.1));
console.log('worklet sample clock: callbacks delayed, frame gaps and source timestamps OK');
