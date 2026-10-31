#!/usr/bin/env node
// Explicit owner operation; never uploads PCM or writes back to the source authority.
import assert from 'node:assert/strict';
const [source, destination]=process.argv.slice(2);
assert(source&&destination,'Usage: sync-transcript.mjs DESKTOP/transcripts/PLATFORM/NATIVE GATEWAY/transcripts/by-id/ROW');
for(const value of [source,destination]){
  const u=new URL(value);
  assert(!u.username&&!u.password&&!u.search&&!u.hash,'Credentials and query parameters are not allowed in URLs');
  assert(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)),'Use HTTPS or loopback HTTP');
}
assert(/\/transcripts\/[^/]+\/[^/]+$/.test(new URL(source).pathname),'Source must address one Desktop meeting');
assert(/\/transcripts\/by-id\/\d+$/.test(new URL(destination).pathname),'Destination must address an owned Meeting API row');
assert(process.env.TINA_API_KEY,'Set TINA_API_KEY for the destination gateway');
const headers={'X-API-Key':process.env.TINA_API_KEY};
async function request(url, options={}){
  const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000),...options});
  if(!r.ok&&r.status!==404)throw Error(`Synchronization refused (HTTP ${r.status})`);
  if(r.status===404)return null;
  const reader=r.body.getReader(), chunks=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;assert(bytes<=4*1024*1024,'Snapshot exceeds 4 MiB');chunks.push(value);}}
  finally{await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const snapshot=await request(source+'/foundation',{headers:{'X-API-Key':process.env.TINA_DESKTOP_API_KEY||''}});
assert(snapshot?.version==='stt-foundation.v1'&&/^[a-f0-9]{64}$/.test(snapshot.meeting_uid)&&Number.isSafeInteger(snapshot.sequence),'Invalid source snapshot');
const target=destination+'/replicas/'+snapshot.meeting_uid;
const previous=await request(target,{headers});
const receipt=await request(target,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({snapshot,expected_revision:previous?.sequence??0})});
assert(receipt?.fingerprint===snapshot.fingerprint&&receipt.sequence===snapshot.sequence,'Source receipt mismatch');
console.log(JSON.stringify({meeting_uid:receipt.meeting_uid,sequence:receipt.sequence,segments:receipt.segments.length,authority:receipt.authority.system}));
