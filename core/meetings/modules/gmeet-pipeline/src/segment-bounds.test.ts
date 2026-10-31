import assert from 'node:assert/strict';
import { SpeakerStreamManager } from './speaker-streams.js';
import { GmeetCompatibleBuffer } from '@tina/transcribe-buffer';
import { setLogger } from './log.js';
import { createGmeetPipeline, type TranscriptSegment } from './gmeet-pipeline.js';

setLogger(() => {});
const SR = 100, START = 1_800_000_000_000, SID = 'bounded-turn';
const factories = [
  ['gmeet', () => new SpeakerStreamManager({ sampleRate: SR })],
  ['gmeet-stamped', () => new SpeakerStreamManager({ sampleRate: SR, callbackStampedFrames: true })],
  ['shared', () => new GmeetCompatibleBuffer({ sampleRate: SR, scheduleSubmissions: false, isHallucination: t => t === 'bad prefix' })],
] as const;
let failures = 0;
for (const [name, create] of factories) {
  async function check(label: string, run: (m: ReturnType<typeof create>) => Promise<void>) {
    const m = create(); m.addSpeaker(SID, 'Speaker');
    try { await run(m); console.log(`PASS ${name}: ${label}`); }
    catch (e) { failures++; console.error(`FAIL ${name}: ${label}: ${e}`); }
    finally { m.removeAll(); }
  }
  await check('an audio-less draft is withdrawn, never finalized with a zero span', async m => {
    const finals: number[] = [], drafts = new Map<number, string>();
    m.onSegmentConfirmed = (_i, _n, _t, a, b) => finals.push(b - a);
    m.onSegmentPending = (_i, _n, t, a) => { if (t) drafts.set(a, t); else drafts.delete(a); };
    m.handleTranscriptionResult(SID, 'unbacked draft');
    await m.flushSpeaker(SID, true);
    assert.deepEqual(finals, []);
    assert.equal(drafts.size, 0);
  });
  await check('advancing past a rejected prefix retracts the old pending ID', async m => {
    const drafts = new Map<number, string>();
    m.onSegmentReady = () => {};
    m.onSegmentConfirmed = () => {};
    m.onSegmentPending = (_i, _n, t, a) => { if (t) drafts.set(a, t); else drafts.delete(a); };
    m.feedAudio(SID, new Float32Array(SR * 4).fill(.1), START);
    const prefix = name.startsWith('gmeet') ? '理智。' : 'bad prefix';
    m.handleTranscriptionResult(SID, `${prefix} other words`, 3, [{text:prefix,start:0,end:1},{text:'other words',start:1,end:3}]);
    m.handleTranscriptionResult(SID, `${prefix} other words grow`, 4, [{text:prefix,start:0,end:1},{text:'other words grow',start:1,end:4}]);
    assert.equal(drafts.has(START), false, 'the filtered prefix must not leave a zero-duration durable draft');
  });
  await check('long close and delayed ASR preserve every sample exactly once in bounded finals', async m => {
    const requests: Float32Array[] = [], finals: Array<{text:string;start:number;end:number}> = [];
    m.onSegmentReady = (_i, _n, a) => requests.push(a);
    m.onSegmentConfirmed = (_i, _n, text, start, end) => finals.push({text,start,end});
    let frame = 0;
    const feed = (count: number) => { for (let i=0;i<count;i++,frame++) m.feedAudio(SID, new Float32Array(25).fill((frame+1)/1000), START+frame*250); };
    feed(260); // 65 seconds before the close; a timer/request may be late.
    await m.flushSpeaker(SID, true);
    feed(32); // 8 seconds arriving while the first bounded request is in flight.
    let answered = 0;
    while (requests.length) {
      assert.ok(++answered < 10, 'the close must drain its tail');
      const a = requests.shift()!;
      assert.ok(a.length <= SR*30, `ASR request exceeded 30 s: ${a.length/SR}`);
      const words = Array.from({length:a.length/25},(_,i)=>String(Math.round(a[i*25]*1000))).join(' ');
      m.handleTranscriptionResult(SID, words, a.length/SR, [{text:words,start:0,end:a.length/SR}]);
      await Promise.resolve();
    }
    assert.deepEqual(finals.flatMap(s=>s.text.split(' ').map(Number)), Array.from({length:292},(_,i)=>i+1));
    assert.ok(finals.every(s=>s.end>s.start && s.end-s.start<=30000));
    assert.ok(finals.every((s,i)=>s.start===(i?finals[i-1].end:START)), 'no timeline holes or overlap');
    assert.equal(finals.at(-1)?.end, START+73000);
  });
  await check('bad ASR offsets fall back to the actual audio window', async m => {
    const finals: Array<{start:number;end:number}> = [];
    m.onSegmentReady = () => {};
    m.onSegmentConfirmed = (_i,_n,_t,start,end) => finals.push({start,end});
    m.feedAudio(SID, new Float32Array(SR*4).fill(.1), START);
    const parts = [{text:'stable head',start:0,end:0},{text:'forming tail',start:0,end:4}];
    m.handleTranscriptionResult(SID, 'stable head forming tail', 0, parts);
    m.handleTranscriptionResult(SID, 'stable head forming tail grows', NaN, [parts[0],{...parts[1],text:'forming tail grows'}]);
    await m.flushSpeaker(SID, true);
    assert.deepEqual(finals, [{start:START,end:START+4000}]);
  });
  await check('the cap chooses a quiet frame and retains its boundary audio', async m => {
    const requests: Float32Array[] = [];
    m.onSegmentReady = (_i,_n,a) => requests.push(a);
    for(let i=0;i<128;i++) m.feedAudio(SID,new Float32Array(25).fill(i===112?.001:.1),START+i*250);
    await m.flushSpeaker(SID,true);
    assert.equal(requests[0].length,SR*28);
    m.handleTranscriptionResult(SID,'first bounded sentence',28);
    assert.equal(requests[1].length,SR*4);
    assert.equal(requests[1][0],Math.fround(.001),'quiet boundary belongs to exactly the next window');
    m.handleTranscriptionResult(SID,'remaining sentence',4);
  });
  await check('genuine repeated words in disjoint capped windows are retained', async m => {
    const requests: Float32Array[] = [], text: string[] = [];
    m.onSegmentReady = (_i,_n,a) => requests.push(a);
    m.onSegmentConfirmed = (_i,_n,t) => text.push(t);
    m.feedAudio(SID,new Float32Array(SR*60).fill(.1),START);
    await m.flushSpeaker(SID,true);
    while(requests.length) { const a=requests.shift()!; m.handleTranscriptionResult(SID,'yes confirmed',a.length/SR); await Promise.resolve(); }
    assert.deepEqual(text,['yes confirmed','yes confirmed']);
  });
  await check('a silent capped prefix cannot block later speech', async m => {
    const requests: Float32Array[] = [];
    m.onSegmentReady = (_i,_n,a) => requests.push(a);
    m.feedAudio(SID,new Float32Array(SR*31),START);
    m.feedAudio(SID,new Float32Array(SR*2).fill(.1),START+31000);
    await m.flushSpeaker(SID,true);
    assert.equal(requests.length,1);
    assert.equal(requests[0].length,SR*3);
    m.handleTranscriptionResult(SID,'speech after silence',3);
  });
  await check('a stable response never consumes audio received after its request', async m => {
    const requests: Float32Array[] = [], finals: Array<{text:string;start:number;end:number}> = [];
    m.onSegmentReady = (_i,_n,a) => requests.push(a);
    m.onSegmentConfirmed = (_i,_n,text,start,end) => finals.push({text,start,end});
    const submit=()=>(m as unknown as {trySubmit(id:string):Promise<void>}).trySubmit(SID);
    m.feedAudio(SID,new Float32Array(SR*4).fill(.1),START);
    await submit(); m.handleTranscriptionResult(SID,'stable head',4);
    await submit(); m.feedAudio(SID,new Float32Array(SR*2).fill(.1),START+4000);
    m.handleTranscriptionResult(SID,'stable head',4);
    await m.flushSpeaker(SID,true); m.handleTranscriptionResult(SID,'later tail',2);
    assert.deepEqual(finals,[{text:'stable head',start:START,end:START+4000},{text:'later tail',start:START+4000,end:START+6000}]);
  });
}
assert.equal(failures, 0, `${failures} segment bound regressions`);

// Rotation must drain the old turn's bounded requests before freeing that speaker.
{
  const finals: TranscriptSegment[] = [];
  const pipe = createGmeetPipeline({
    config:{sampleRate:SR,maxRetainedDuration:90}, // batch replay deliberately feeds 65s before allowing any inference
    transcribe: async audio => {
      await Promise.resolve();
      const text=Array.from({length:audio.length/25},(_,i)=>String(Math.round(audio[i*25]*1000))).join(' ');
      return {text,language:'en',duration:audio.length/SR,segments:[{text,start:0,end:audio.length/SR}]};
    },
    sink:{segment:s=>finals.push(s),draft:()=>{},finalize:()=>{}},
  });
  for(let i=0;i<260;i++) pipe.feedAudio(0,'Alice',new Float32Array(25).fill((i+1)/1000),START+i*250);
  pipe.feedAudio(0,'Bob',new Float32Array(SR).fill(.5),START+65000);
  await pipe.dispose();
  assert.deepEqual(finals.filter(s=>s.speaker==='Alice').flatMap(s=>s.text.split(' ').map(Number)),Array.from({length:260},(_,i)=>i+1));
  assert.ok(finals.every(s=>s.end>s.start && s.end-s.start<=30));
  assert.equal(new Set(finals.map(s=>s.segment_id)).size,finals.length);
  console.log('PASS pipeline: rotation drains the old turn without losing or duplicating its words');
}
