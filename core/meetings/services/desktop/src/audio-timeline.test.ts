import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startDesktop} from './desktop.js';
import {TranscriptJournal} from './transcript-journal.js';
import {encodeAudioFrame} from '@tina/capture-codec';

{
 const journal=new TranscriptJournal(':memory:');
 journal.capture('desktop/gap','source',1000,1800000000000,new Float32Array(6400).fill(.1),0,1800000000000,'samples');
 journal.capture('desktop/gap','source',1000,1800000000600,new Float32Array(6400).fill(.2),9600,1800000000600,'samples');
 assert.equal(journal.clip('desktop/gap',{speaker_key:'ch-1000:1',start:1800000000,end:1800000001} as any),null,'modern Review/refinement must not replace a missing capture range with silence');
 journal.close();
}
const directory=mkdtempSync(join(tmpdir(),'tina-ring-'));
const directory2=mkdtempSync(join(tmpdir(),'tina-ring-other-'));
let server:Awaited<ReturnType<typeof startDesktop>>|undefined;
const origin=1800000000000;
try {
 server=await startDesktop({ingestPort:0,gatewayPort:0,quiet:true,recordingsDir:directory,txUrl:'',canAccess:subject=>subject!=='blocked'});
 const base=`http://127.0.0.1:${server.gatewayPort}`;
 const socket=new WebSocket(`ws://127.0.0.1:${server.ingestPort}/ingest?platform=desktop&native_meeting_id=ring-test`);
 const [ready]=await once(socket,'message');const session=JSON.parse(ready.toString()).capture_session;
 assert(session);
 const frame=(channel:number,index:number,value:number,ts=origin+index/16)=>encodeAudioFrame(channel,ts,new Float32Array(16000).fill(value),channel===1000?'You':'System audio',index);
 socket.send(frame(1000,0,.1));socket.send(frame(999,0,.7));
 for(let i=1;i<=31;i++)socket.send(frame(1000,i*16000,(i+1)/100));
 // Dropped source audio is a hole, never fabricated as silence. A backwards timestamp cannot shift samples.
 socket.send(frame(1000,33*16000,.4,origin+33*1000+5000));
 const url=`${base}/transcripts/desktop/ring-test/audio-timeline`;
 let status:any;
 for(let i=0;i<100;i++){status=await(await fetch(url)).json();if(status.sources?.some((s:any)=>s.source===1000&&s.end_sample===34*16000))break;await new Promise(r=>setTimeout(r,10));}
 const validate=new Ajv2020({strict:true}).compile(JSON.parse(readFileSync(new URL('../../../contracts/audio-timeline.v1/audio-timeline.schema.json',import.meta.url),'utf8')));
 assert(validate(status),JSON.stringify(validate.errors));
 assert.equal(status.sources.find((s:any)=>s.source===1000).clock_quality,'samples');
 assert.equal(status.memory.sources,2);assert(status.memory.bytes<=16*(16000*30*4+60000));
 assert(status.events.some((e:any)=>e.kind==='gap'&&e.start_sample===32*16000&&e.end_sample===33*16000));
 const get=(source:number,start:number,end:number)=>fetch(`${url}?session=${session}&source=${source}&start_sample=${start}&end_sample=${end}`);
 const recent=await get(1000,33*16000,34*16000);assert.equal(recent.status,200);assert.equal(recent.headers.get('x-tina-audio-source'),'memory');
 const archived=await get(1000,0,16000);assert.equal(archived.status,200);assert.equal(archived.headers.get('x-tina-audio-source'),'archive');
 assert.equal(Buffer.from(await archived.arrayBuffer()).readFloatLE(44),new Float32Array([.1])[0]);
 const system=await get(999,0,16000);assert.equal(Buffer.from(await system.arrayBuffer()).readFloatLE(44),new Float32Array([.7])[0]);
 const missing=await get(1000,32*16000,33*16000);assert.equal(missing.status,409);assert.deepEqual((await missing.json()).missing,[{startSample:32*16000,endSample:33*16000}]);
 assert.equal((await fetch(url,{headers:{'x-api-key':'blocked'}})).status,403);
 assert.equal((await fetch(url,{headers:{origin:'https://foreign.example'}})).status,403);
 const other=new WebSocket(`ws://127.0.0.1:${server.ingestPort}/ingest?platform=desktop&native_meeting_id=other`);
 const [otherReady]=await once(other,'message');const otherSession=JSON.parse(otherReady.toString()).capture_session;
 other.send(frame(1000,0,.9));
 for(let i=0;i<100;i++){const d:any=await(await fetch(`${base}/transcripts/desktop/other/audio-timeline`)).json();if(d.sources?.length)break;await new Promise(r=>setTimeout(r,10));}
 const crossed=await fetch(`${url}?session=${otherSession}&source=1000&start_sample=0&end_sample=16000`);assert.equal(crossed.status,409,'an authorized meeting cannot read another meeting from RAM');
 other.close();await once(other,'close');
 socket.close();await once(socket,'close');await server.close();server=undefined;
 server=await startDesktop({ingestPort:0,gatewayPort:0,quiet:true,recordingsDir:directory,txUrl:''});
 const after=await fetch(`http://127.0.0.1:${server.gatewayPort}/transcripts/desktop/ring-test/audio-timeline?session=${session}&source=1000&start_sample=0&end_sample=16000`);
 assert.equal(after.status,200);assert.equal(after.headers.get('x-tina-audio-source'),'archive');
 assert.equal(Buffer.from(await after.arrayBuffer()).readFloatLE(44),new Float32Array([.1])[0]);
 console.log('PASS runtime ring: source separation, bounded PCM, canonical clock, gap, RAM eviction→archive, origin gate and restart recovery');
} finally {await server?.close();rmSync(directory,{recursive:true,force:true});rmSync(directory2,{recursive:true,force:true});}
