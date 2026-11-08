import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VoiceInterruption} from './voice-interruption.js';

const frame={channel:2,participant:'p',speakerKey:'s',startMs:2000,endMs:2500,text:'Khoan, ý tôi là tuần sau.',final:true};
test('only a fresh explicit same-caller command interrupts; backchannels and quoted playback do not',()=>{
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  for(const patch of [{channel:3},{participant:'other'},{participant:undefined},{text:'ừ'},{text:'đúng rồi'},
    {text:'mọi người dừng lại kiểm tra nhé'},{startMs:1000,endMs:1400},{endMs:NaN}]){
    assert.equal(guard.feed({...frame,...patch},'Lan phụ trách demo.'),null);
  }
  assert.equal(guard.feed({...frame,text:'Khoan một chút.'},'Khoan một chút.'),null);
  const before=structuredClone(frame),command=guard.feed(frame,'Lan phụ trách demo.');
  assert.equal(command?.question,'ý tôi là tuần sau.');assert(command?.resume);
  assert.deepEqual(frame,before);
});
test('draft commands need agreement, and old ASR windows require valid fresh segment spans',()=>{
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  assert.equal(guard.feed({...frame,final:false},''),null);
  assert(guard.feed({...frame,final:false},'')?.resume);
  const next=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  const old={text:'Câu hỏi cũ.',startMs:100,endMs:1000},fresh={text:'Dừng lại.',startMs:2000,endMs:2500};
  const value={...frame,startMs:0,text:old.text+' '+fresh.text,segments:[old,fresh]};
  assert.equal(next.feed({...value,segments:undefined},''),null);
  assert.equal(next.feed({...value,segments:[old,{...fresh,text:'khác'}]},''),null);
  assert.equal(next.feed(value,'')?.resume,false);
});
test('corrections preserve their intent, too-short and stale commands cannot stop speech',()=>{
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  assert.equal(guard.feed({...frame,endMs:2050},''),null);
  assert.equal(guard.feed({...frame,text:'Ý tôi là bản production.'},'')?.question,'Ý tôi là bản production.');
});
test('a genuine short stop is accepted even when playback mentions the stop command',()=>{
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  assert.equal(guard.feed({...frame,text:'Dừng lại.'},'Bạn có thể nói dừng lại để ngắt TINA.')?.resume,false);
});
