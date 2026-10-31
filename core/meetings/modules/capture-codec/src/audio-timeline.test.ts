import assert from 'node:assert/strict';
import {encodeAudioFrame,decodeAudioFrame} from './index.js';
for(const name of [undefined,'You','System audio','Nguyễn Minh']) {
  const pcm=Float32Array.from([.1,-.2,0,.3]);
  const encoded=encodeAudioFrame(1000,1800000000123,pcm,name,9876543210);
  const frame=decodeAudioFrame(encoded)!;
  assert.equal(frame.startSample,9876543210);assert.equal(frame.ts,1800000000123);
  assert.equal(frame.speakerIndex,1000);assert.equal(frame.speakerName,name);
  assert.deepEqual(frame.samples,pcm);
  assert.equal(decodeAudioFrame(encoded.slice(0,15)),null);
}
const old=decodeAudioFrame(encodeAudioFrame(999,123,new Float32Array(2)))!;
assert.equal(old.startSample,undefined);
assert.throws(()=>encodeAudioFrame(1,123,new Float32Array(1),undefined,-1));
const malformed=encodeAudioFrame(1,123,new Float32Array(1),undefined,0);new DataView(malformed).setFloat64(12,Infinity,true);
assert.equal(decodeAudioFrame(malformed),null);
// Byte layout emitted by Rust: named+indexed flags, capture ms, sample index, UTF8 byte count.
const rust=new ArrayBuffer(32),view=new DataView(rust);view.setUint32(0,0xc00003e8,true);view.setFloat64(4,123,true);view.setFloat64(12,32000,true);view.setInt32(20,3,true);new Uint8Array(rust,24,3).set([89,111,117]);view.setFloat32(28,.5,true);
assert.deepEqual(decodeAudioFrame(rust),{speakerIndex:1000,ts:123,startSample:32000,speakerName:'You',samples:Float32Array.from([.5])});
console.log('capture timeline codec: legacy compatibility, indexed frames, Rust layout and invalid headers OK');
