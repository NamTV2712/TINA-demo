import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

const snapshot=JSON.parse(readFileSync(new URL('../../../core/meetings/contracts/stt-foundation.v1/golden/desktop.json',import.meta.url)));
let saved=null,expected=[],requests=0,redirect=false;
const server=createServer(async(req,res)=>{
  requests++;
  if(req.url==='/transcripts/google_meet/source/foundation'){
    assert.equal(req.headers['x-api-key'],'source-private');
    if(redirect){res.writeHead(302,{Location:'/leak'});return res.end();}
    res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(snapshot));
  }
  assert.equal(req.url,`/transcripts/by-id/1/replicas/${snapshot.meeting_uid}`);
  assert.equal(req.headers['x-api-key'],'destination-private');
  if(req.method==='PUT'){
    let body='';for await(const chunk of req)body+=chunk;
    const value=JSON.parse(body);assert.deepEqual(value.snapshot,snapshot);
    expected.push(value.expected_revision);saved=value.snapshot;
  }
  res.writeHead(saved?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(saved));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
async function sync(){
  const child=spawn(process.execPath,[new URL('../bin/sync-transcript.mjs',import.meta.url).pathname,
    base+'/transcripts/google_meet/source',base+'/transcripts/by-id/1'],{env:{...process.env,TINA_API_KEY:'destination-private',TINA_DESKTOP_API_KEY:'source-private'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const [code]=await once(child,'exit');return {code,stdout,stderr};
}
try{
  for(let i=0;i<2;i++){
    const result=await sync();assert.equal(result.code,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).meeting_uid,snapshot.meeting_uid);
    assert(!result.stdout.includes(snapshot.segments[0].text));assert(!result.stdout.includes('private'));
  }
  assert.deepEqual(expected,[0,snapshot.sequence]);
  redirect=true;const before=requests,result=await sync();assert.notEqual(result.code,0);assert.equal(requests,before+1,'No credential-bearing redirected request');
  console.log('PASS sync CLI: exact snapshot, receiver CAS, separate owner keys, content-free receipt and redirects refused');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
