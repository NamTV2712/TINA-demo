import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {TranscriptionClient} from '../../../core/meetings/modules/whisper/dist/index.js';
import {encodedPcm,locatePcm,wavPcm} from './quality_ab.mjs';

test('wire attribution uses the production Float32 → PCM16 conversion',async()=>{
 const samples=new Float32Array([-.9,-.2,-.001,0,.001,.2,.9]);
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);
  const form=await new Request('http://127.0.0.1/',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();
  const pcm=wavPcm(Buffer.from(await form.get('file').arrayBuffer()));assert.deepEqual(pcm,encodedPcm(samples));
  assert.deepEqual(locatePcm(pcm,pcm.subarray(4,10)),{source_start_sample:2,match_kind:'unique'});
  res.end(JSON.stringify({text:'test',segments:[],duration:samples.length/16000}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await new TranscriptionClient({serviceUrl:`http://127.0.0.1:${server.address().port}`,maxRetries:0}).transcribe(samples);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 assert.equal(locatePcm(Buffer.alloc(20),Buffer.alloc(4)).match_kind,'ambiguous');
 assert.equal(locatePcm(Buffer.from([1,2,3,4]),Buffer.from([5,6])).match_kind,'not-contiguous');
 assert.throws(()=>wavPcm(Buffer.from('invalid')));
});
