import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readCaptureAudio} from './audio-archive.js';
import {makeTelemetryTap} from './capture-bridge.js';
const dir=mkdtempSync(join(tmpdir(),'tina-source-'));const frames:any[]=[],obs:any[]=[];
const tee=makeTelemetryTap('gmeet',{captureFrame:f=>frames.push(f),captureObservation:o=>obs.push(o)} as any);
try {
 tee(1000,Float32Array.from([1,2]),123,'You',undefined,0);
 tee(999,Float32Array.from([9,8]),123,'System',undefined,0);
 tee(1000,Float32Array.from([5,6]),456,'You',undefined,4);
 const tape=join(dir,'capture.jsonl'),observations=join(dir,'observations.jsonl');
 writeFileSync(tape,frames.map(x=>JSON.stringify(x)).join('\n'));writeFileSync(observations,obs.map(x=>JSON.stringify(x)).join('\n'));
 assert.deepEqual([...(await readCaptureAudio(tape,observations,999,0,2)).samples!],[9,8]);
 assert.deepEqual([...(await readCaptureAudio(tape,observations,1000,4,6)).samples!],[5,6]);
 assert.deepEqual((await readCaptureAudio(tape,observations,1000,0,6)).missing,[{startSample:2,endSample:4}]);
 console.log('PASS bot source recovery: source-clock sidecar, isolated PCM and explicit missing ranges');
} finally {rmSync(dir,{recursive:true,force:true});}
