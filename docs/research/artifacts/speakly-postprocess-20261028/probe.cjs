const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const root = path.join(__dirname, 'first-party/dist/src');
let clock = 100000;
const writes = [];
const log = {info(){},warn(){},error(){},debug(){}};
function load(relative, overrides = {}) {
  const module = {exports:{}};
  const context = {
    module, exports:module.exports,
    require(name) {
      if (name === 'events') return {EventEmitter};
      if (name.includes('LoggerInit')) return {getLogger:()=>log};
      if (name.includes('RecordingStorage')) return {recordingStorage:{appendTranscriptSegment:(session,row)=>writes.push({session,...row})}};
      if (name.includes('MeetingTimeline')) return {audioTrackForTrackId:id=>id===0?'mic':'system'};
      if (name.includes('EnvProvider')) return {envProvider:{testConfig:{}}};
      if (name === './types') return {TranscriptionEvent:{Final:'final',Update:'update',Delta:'delta'}};
      if (['ErrorCode','AuthService','copilotSessionConfigBuilder','errorKeyForKind','MultiplexClient','TranscriptSession','participants'].some(id=>name.endsWith('/'+id))) return {};
      throw new Error('Unstubbed dependency: '+name);
    },
    Date:class extends Date {static now(){return clock;}},
    setInterval:()=>1, clearInterval(){}, setTimeout:()=>1, clearTimeout(){},
    ...overrides,
  };
  // Only selected module definitions run; native, network, timers and storage are stubbed.
  vm.runInNewContext(fs.readFileSync(path.join(root,relative),'utf8'),context,{filename:relative,timeout:1000});
  return module.exports;
}
const {TranscriptionSessionFlow:Flow}=load('services/flow/transcript/TranscriptionSessionFlow.js');
const flow=new Flow({sessionId:'synthetic',audioCodec:'pcm'});
let emitted=0; flow.on('final',()=>emitted++);
flow.onRecvTranscriptFinal('raw ASR','s1','draft translation',0,1000);
assert.equal(emitted,1); assert.equal(writes.length,0);
flow.handleIncomingMessage({type:'transcript_update',data:{segment_id:'s1',text:'changed ASR',translation:'final translation',is_final:true}});
assert.equal(writes.length,1); assert.equal(writes[0].text,'raw ASR'); assert.equal(writes[0].translation,'final translation');
flow.onRecvTranscriptUpdate('s1','late translation',true);
assert.equal(writes.length,1); assert.equal(writes[0].translation,'final translation');
const fifo=new Flow({sessionId:'fifo',audioCodec:'pcm'});
fifo.onRecvTranscriptFinal('A','a',undefined,0,0);fifo.onRecvTranscriptFinal('B','b',undefined,1,10);
fifo.onRecvTranscriptUpdate('b','B translated',true);assert.equal(writes.length,1);
clock+=30001;fifo._flushSidecarQueue(false);assert.equal(writes.length,3);
assert.equal(writes[1].text,'A');assert.equal(writes[2].text,'B');
fifo.onRecvTranscriptFinal('A','a',undefined,0,0);clock+=30001;fifo._flushSidecarQueue(false);
assert.equal(writes.length,4); // Duplicate suppression applies while queued, not after a flush.
const text=load('utils/transcriptText.js');
assert.equal(text.resolveSegmentSpeaker('speaker0',0,{'__index__0':'Anna',speaker0:'Ben'}),'Anna');
const exported=text.buildTranscriptTxt([{text:'hello',speaker:'speaker0',start:2500,end:5120},{text:'discarded',speaker:'Hallucination',start:0,end:1}],{},true,true);
assert.equal(exported,'[00:00:03] speaker0: hello');
assert.equal(text.buildTranscriptSrt([{text:'hello',speaker:'speaker0',start:2500,end:5120}],{},false),'1\n00:00:02,500 --> 00:00:05,120\nhello');
const {LocalSttWorkerCore:Core}=load('worker/localSttWorkerCore.js');
const core=new Core({reply(){},loadSherpa(){throw Error('No native engine');},pathJoin:(...a)=>a.join('/')});
core._engine='qwen3Asr';assert.equal(core._cleanText('language English<asr_text> hello'),'hello');
assert.equal(core._cleanText('<s>hello</s>'),'<s>hello</s>');
assert.equal(core._buildEngineConfig('senseVoice','models',{model:'model'},'auto').senseVoice.useInverseTextNormalization,1);
assert.equal(core._buildEngineConfig('qwen3Asr','models',{},'auto').useInverseTextNormalization,undefined);
console.log(JSON.stringify({scope:'Controlled replay of selected installed JavaScript modules; fake clock/dependencies; no app/native/cloud execution',checks:{final_emitted_before_local_sidecar_write:true,terminal_translation_update_flushes_early:true,update_ignores_ASR_text:true,late_translation_does_not_rewrite_sidecar:true,FIFO_head_blocks_younger_settled_row:true,duplicate_final_after_flush_can_append_again:true,speaker_alias_precedence:true,TXT_half_up_and_SRT_milliseconds:true,hallucination_label_skipped_in_export:true,Qwen_strips_asr_marker_only:true,ITN_flag_is_SenseVoice_specific:true}}));
