// The replay uses the production boundary helper, with no reference text or speaker labels.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {silenceCut} from '../../../core/meetings/modules/buffer/dist/index.js';
const [directory]=process.argv.slice(2);
assert(directory,'Usage: node meeting_e2e_windows.mjs OUTPUT');
const source=readFileSync(`${directory}/meeting.wav`);
assert.equal(source.toString('ascii',0,4),'RIFF');assert.equal(source.toString('ascii',8,12),'WAVE');
let data;
for(let offset=12;offset+8<=source.length;){
  const size=source.readUInt32LE(offset+4),start=offset+8;
  assert(start+size<=source.length,'Truncated WAV');
  if(source.toString('ascii',offset,offset+4)==='fmt '){
    assert.equal(source.readUInt16LE(start),1);assert.equal(source.readUInt16LE(start+2),1);
    assert.equal(source.readUInt32LE(start+4),16000);assert.equal(source.readUInt16LE(start+14),16);
  }
  if(source.toString('ascii',offset,offset+4)==='data')data=source.subarray(start,start+size);
  offset=start+size+(size%2);
}
assert(data?.length);
const pcm=Float32Array.from({length:data.length/2},(_,i)=>data.readInt16LE(i*2)/32768);
const windows=[];
let start=0;
while(start<pcm.length){
  let observed=Math.min(start+8*16000,pcm.length),cut;
  while((cut=silenceCut(pcm.subarray(start,observed),16000,4*16000))===null && observed<pcm.length && observed-start<25*16000)
    observed=Math.min(observed+16000,pcm.length,start+25*16000);
  const end=cut===null ? observed : start+cut;
  assert(end>start && end<=observed && observed-start<=25*16000);
  windows.push({start_sample:start,end_sample:end,available_at_seconds:observed/16000,cut_kind:cut!==null?'silence':observed===pcm.length?'end-of-audio':'hard-cap'});
  start=end;
}
assert(windows[0].start_sample===0 && windows.at(-1).end_sample===pcm.length);
assert(windows.every((w,i)=>!i||w.start_sample===windows[i-1].end_sample));
writeFileSync(`${directory}/windows.json`,JSON.stringify({version:'silence-cut-replay.v1',windows},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({windows:windows.length,kinds:windows.reduce((o,w)=>(o[w.cut_kind]=(o[w.cut_kind]||0)+1,o),{})}));
