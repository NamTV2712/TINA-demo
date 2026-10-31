import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { encodeRecordingChunk, decodeRecordingChunk, decodeAudioFrame, AUDIO_ACK_MODE } from '../../../core/meetings/modules/capture-codec/dist/index.js';

const turn = () => new Promise(r => setImmediate(r));
const codec = new URL('../../../core/meetings/modules/capture-codec/src/index.ts', import.meta.url).pathname;
async function bundle(file, extra = '', plugins = []) {
  const result = await build({ stdin: { contents: readFileSync(new URL(file, import.meta.url), 'utf8') + extra, resolveDir: new URL('.', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser', alias: { '@tina/capture-codec': codec }, plugins });
  return result.outputFiles[0].text;
}
let listener, flushing, storedTranscriptSource;
const sockets = [], controls = [], requests = [], timers = [];
let clockOffset = 0;
class Clock extends Date { static now() { return Date.now() + clockOffset; } }
const event = () => ({ addListener() {} });
class Socket {
  static OPEN = 1;
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 1; this.bufferedAmount = 0; this.frames = []; sockets.push(this); }
  send(frame) {
    this.frames.push(frame);
    const chunk = decodeRecordingChunk(frame);
    const pcm = !chunk && decodeAudioFrame(frame);
    if (pcm && !this.dropAudioAck) queueMicrotask(() => this.onmessage({data: JSON.stringify({type:'audio-ack',capture_session:'durable-session',source:pcm.speakerIndex,start_sample:pcm.startSample,end_sample:pcm.startSample+pcm.samples.length})}));
    if (chunk && !this.dropRecordingAck) queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'recording-ack', seq: chunk.seq, isFinal: chunk.isFinal }) }));
  }
  close() { this.readyState = 3; }
}
const chrome = {
  runtime: { getURL: p => 'chrome-extension://review/' + p, onMessage: { addListener: fn => listener = fn },
    sendMessage: async message => { controls.push(message); if (message.type === 'CAPTURE_STOP' && flushing) await flushing; return { ok: true }; } },
  storage: { local: { get: async () => ({ apiKey: 'synthetic-key', language: 'vi-en', deployment: 'desktop', transcriptSource: storedTranscriptSource }) } },
  offscreen: { hasDocument: async () => true, Reason: {} },
  tabs: { query: async () => [], onUpdated: event(), onRemoved: event(), sendMessage: async (id, msg) => {
    controls.push(msg);
    queueMicrotask(() => listener({ type: 'capture-control-result', sessionId: msg.sessionId, requestId: msg.requestId, ok: true }, { tab: { id }, frameId: 0 }, () => {}));
    return { ok: true };
  } }, scripting: { executeScript: async () => {} }, sidePanel: { setPanelBehavior: async () => {} }, action: { onClicked: event() },
};
const context = { chrome, WebSocket: Socket, URL, URLSearchParams, TextEncoder, TextDecoder, AbortSignal, crypto: webcrypto, Date: Clock, console, atob, btoa,
  setInterval: () => 0, setTimeout: (fn, ms) => { if (ms <= 20) return setTimeout(() => { clockOffset += 1000; fn(); }, 1); const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: () => {},
  fetch: async url => { requests.push(String(url)); return new Response('{}'); } };
vm.createContext(context);
vm.runInContext(await bundle('./background.ts', '\nglobalThis.probe={state,pcmReplay,startCaptureForTab,maybeAutoStart,stopCapture,setPaused,setStream(id,tab){tabStreamId=id;tabStreamTabId=tab}};'), context);
const { probe } = context;
const sender = id => ({ tab: { id }, frameId: 0 });
const offscreen = { url: chrome.runtime.getURL('offscreen.html') };
const message = (body, from) => { let result; listener(body, from, value => result = value); return result; };
const ready = (socket, resume = false) => socket.onmessage({ data: JSON.stringify({ type: 'ready', meeting_id: 1, recording_ack: true, recording_resume: resume, audio_ack: AUDIO_ACK_MODE, capture_session:'durable-session' }) });

storedTranscriptSource = 'bot';
await probe.startCaptureForTab(1, 'https://meet.google.com/abc-defg-hij');
await probe.maybeAutoStart(1, 'https://meet.google.com/abc-defg-hij');
assert.equal(sockets.length, 0, 'Bot viewer blocks manual and automatic local capture');
assert.ok(!controls.some(control => /START|BEGIN_CAPTURE/.test(control.type)), 'Bot viewer does not start a recorder');
storedTranscriptSource = 'capture';

await Promise.all([probe.startCaptureForTab(1, 'https://meet.google.com/abc-defg-hij'), probe.startCaptureForTab(2, 'https://meet.google.com/xyz-abcd-efg')]);
assert.equal(sockets.length, 1, 'concurrent starts reserve only one capture');
assert.equal(new URL(sockets[0].url).searchParams.has('api_key'), false, 'Desktop API key is not exposed in the WebSocket URL');
assert.deepEqual(Array.from(sockets[0].protocols), ['tina-extension.v1', `tina-api-key.${Buffer.from('synthetic-key').toString('base64url')}`]);
const oldToken = probe.state.sessionId; ready(sockets[0]); await turn();
assert.equal(message({ type: 'audio', sessionId: oldToken, index: 0, pcm: [.1], captureMs:1800000000000, startSample:0 }, sender(99)).ok, false);
assert.equal(message({ type: 'audio', sessionId: 'old', index: 0, pcm: [.1], captureMs:1800000000000, startSample:0 }, sender(1)).ok, false);
assert.equal(message({ type: 'audio', sessionId: oldToken, index: 0, pcm: [.1], captureMs:1800000000000, startSample:0 }, sender(1)).ok, true);
assert.equal(sockets[0].frames.length, 1);
await probe.setPaused(true); assert.equal(probe.state.paused, true);
assert.ok(controls.some(c => c.type === 'CAPTURE_PAUSE'));
message({ type: 'audio', sessionId: oldToken, index: 0, pcm: [.1], captureMs:1800000000000, startSample:0 }, sender(1));
message({ type: 'chat-message', sessionId: oldToken, text: 'paused' }, sender(1));
assert.equal(sockets[0].frames.length, 1);
await probe.setPaused(false); await probe.stopCapture();
await probe.startCaptureForTab(2, 'https://meet.google.com/xyz-abcd-efg'); ready(sockets[1]); await turn();
sockets[0].onclose(); assert.equal(probe.state.status, 'starting'); assert.notEqual(probe.state.sessionId, oldToken);
assert.equal(message({ type: 'audio', sessionId: oldToken, index: 0, pcm: [.1], captureMs:1800000000000, startSample:0 }, sender(2)).ok, false);
await probe.stopCapture();

await probe.startCaptureForTab(3, 'https://us02web.zoom.us/j/123456789');
probe.setStream('tab-id',3);
ready(sockets[2]); await turn(); await turn();
assert.ok(controls.some(c => c.type === 'TAB_CAPTURE_START' && c.includeMic), JSON.stringify({state:probe.state,controls:controls.map(c=>c.type)}));
let release; flushing = new Promise(r => release = r);
const stopping = probe.stopCapture(); await turn();
assert.equal(sockets[2].readyState, 1, 'Stop keeps socket open while recorder flushes');
const ends = requests.filter(p => p.includes('/sessions/end')).length;
assert.equal(message({ type: 'RECORDING_CHUNK', sessionId: probe.state.sessionId, frame: Array.from(new Uint8Array(encodeRecordingChunk(2, true, 'webm', new Uint8Array()))) }, offscreen).ok, true);
release(); await stopping; flushing = null;
assert.equal(sockets[2].readyState, 3);
assert.equal(requests.filter(p => p.includes('/sessions/end')).length, ends + 1);

await probe.startCaptureForTab(4, 'https://meet.google.com/abc-defg-hij'); ready(sockets[3]); await turn();
const token = probe.state.sessionId; sockets[3].dropRecordingAck = true;
message({ type: 'RECORDING_CHUNK', sessionId: token, frame: Array.from(new Uint8Array(encodeRecordingChunk(0, false, 'webm', Uint8Array.of(99)))) }, offscreen);
sockets[3].onclose(); assert.equal(probe.state.status, 'connecting');
message({ type: 'RECORDING_CHUNK', sessionId: token, frame: Array.from(new Uint8Array(encodeRecordingChunk(1, false, 'webm', Uint8Array.of(100)))) }, offscreen);
timers.findLast(t => t.ms === 1000).fn(); const resumed = sockets.at(-1); ready(resumed, true); await turn();
assert.equal(resumed.frames.length, 2); assert.equal(probe.state.sessionId, token);
await probe.stopCapture();
// Lost ACK and audio produced while offline must replay verbatim, only after ready.
await probe.startCaptureForTab(5, 'https://meet.google.com/abc-defg-hij');
let first = sockets.at(-1); ready(first); await turn();
const audioToken = probe.state.sessionId;
const audio = (index, sample) => message({type:'audio',sessionId:audioToken,index,pcm:[.2],captureMs:1800000000000+sample/16,startSample:sample},sender(5));
first.dropAudioAck = true; audio(0, 0);
const sent = first.frames[0]; assert.equal(probe.pcmReplay.size,1);
first.readyState = 3; first.onclose(); audio(0, 2); audio(1, 0);
assert.equal(probe.pcmReplay.size,3);
timers.findLast(t => t.ms === 1000).fn(); let successor = sockets.at(-1);
assert.equal(successor.frames.length,0,'PCM waits for capability negotiation');
successor.dropAudioAck = true; ready(successor,true); await turn();
assert.equal(successor.frames[0],sent,'replay retains immutable wire bytes');
assert.equal(successor.frames.length,3);
successor.onmessage({data:JSON.stringify({type:'audio-ack',capture_session:'foreign',source:0,start_sample:0,end_sample:1})});
assert.equal(probe.pcmReplay.size,3,'foreign capture ACK cannot erase queued audio');
successor.onmessage({data:JSON.stringify({type:'audio-ack',capture_session:'durable-session',source:0,start_sample:0,end_sample:3})});
assert.equal(probe.pcmReplay.size,3,'cumulative ACK cannot erase intentional sample gaps');
await probe.stopCapture(); assert.equal(probe.state.status,'error');
assert.equal(probe.state.sessionId,audioToken); assert.equal(probe.pcmReplay.size,3);
const socketCount=sockets.length;
await probe.startCaptureForTab(6,'https://meet.google.com/xyz-abcd-efg');
assert.equal(sockets.length,socketCount,'new session blocked until PCM drains');
assert.equal(message({type:'RELOAD_NOW'},{url:chrome.runtime.getURL('sidepanel.html')}).ok,false);
const sourceStarts=controls.filter(c=>c.type==='BEGIN_CAPTURE').length;
const retried=new Promise(resolve=>listener({type:'RETRY_AUDIO'},{url:chrome.runtime.getURL('sidepanel.html')},resolve));
await turn(); ready(sockets.at(-1),true); await retried;
assert.equal(probe.pcmReplay.size,0); assert.equal(probe.state.sessionId,null);
assert.equal(probe.state.status,'idle');
assert.equal(controls.filter(c=>c.type==='BEGIN_CAPTURE').length,sourceStarts,'delivery retry never restarts sources');
console.log('PASS background: concurrent start, tab/token isolation, pause, flush, stale socket, mixed mic and reconnect');

let receive, mediaCalls = 0, stopped = 0, pauses = 0, resumes = 0;
const emitted = [], pcmCallbacks = [], mixedCallbacks = [];
const plugin = { name: 'audio-adapters', setup(b) {
  b.onResolve({ filter: /^@tina\/(gmeet-capture|mixed-capture-core|record-chunker)$/ }, args => ({ path: args.path, namespace: 'fake' }));
  b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: args.path.endsWith('gmeet-capture') ? 'export const createPcmCaptureNode=async(ctx,cb)=>{globalThis.pcmCallbacks.push(cb);return {connect(){}}}' : args.path.endsWith('mixed-capture-core') ? 'export const createMixedAudioCapture=async(stream,cb)=>{globalThis.mixedCallbacks.push(cb);return {stop(){}}}' : 'export const createRecordingTap=opts=>globalThis.newRecorder(opts)', loader: 'js' }));
} };
class AudioContext {
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createMediaStreamDestination() { return { stream: { stable: true } }; }
  async close() {}
}
const off = { AudioContext, console, atob, pcmCallbacks, mixedCallbacks,
  newRecorder: opts => ({ start: async () => {}, pause: async () => { pauses++; }, resume: async () => { resumes++; }, stop: async () => { stopped++; await opts.onChunk({ base64: '', chunkSeq: 0, isFinal: true, mimeType: 'audio/webm' }); } }),
  navigator: { mediaDevices: { getUserMedia: async () => { mediaCalls++; const track = { readyState: 'live', stop() { this.readyState = 'ended'; } }; return { getTracks: () => [track], getAudioTracks: () => [track] }; } } },
  chrome: { runtime: { getURL: p => p, onMessage: { addListener: fn => receive = fn }, sendMessage: async m => { emitted.push(m); return { ok: true }; } } } };
vm.createContext(off); vm.runInContext(await bundle('./offscreen.ts', '', [plugin]), off);
const command = (type, extra = {}) => new Promise(resolve => receive({ type, sessionId: 'session', ...extra }, {}, resolve));
assert.equal((await command('TAB_CAPTURE_START', { streamId: 'first', includeMic: true })).ok, true);
assert.equal(mediaCalls, 2);
await command('CAPTURE_PAUSE'); assert.equal(pauses, 1);
const before = emitted.length; pcmCallbacks[0](new Float32Array([.1])); mixedCallbacks[0](new Float32Array([.1]), 1, 0);
assert.equal(emitted.length, before);
await command('CAPTURE_RESUME'); assert.equal(resumes, 1);
await command('TAB_CAPTURE_START', { streamId: 'replacement', includeMic: true });
assert.equal(mediaCalls, 3); assert.equal(stopped, 0);
await command('CAPTURE_STOP'); assert.equal(stopped, 1);
assert.ok(emitted.some(m => m.type === 'RECORDING_CHUNK' && m.sessionId === 'session'));
console.log('PASS offscreen: mic, pause/resume at source, stream replacement preserves recorder, final-chunk delivery');

// A queued callback from a retired inpage source must not acquire the next session's token.
const pageMessages = [], pageListeners = [], gmeetCallbacks = [];
const pagePlugin = { name: 'page-adapters', setup(b) {
  b.onResolve({ filter: /^@tina\/(gmeet-capture|zoom-capture|teams-capture|record-chunker)$/ }, args => ({ path: args.path, namespace: 'page-fake' }));
  b.onLoad({ filter: /.*/, namespace: 'page-fake' }, args => ({ contents: args.path.endsWith('gmeet-capture') ? `
    export const createGmeetSpeakers=()=>({destroy(){},getState(){return {tiles:[]}}});
    export class GmeetChannelBinder {setSelfName(){} recordGlow(){} nameForChannel(){}}
    export const createPcmCaptureNode=async()=>({connect(){}});
    export const createGmeetCapture=opts=>{globalThis.gmeetCallbacks.push(opts.onAudio);return {start:async()=>{},stop(){},streamCount(){return 1}}};`
    : args.path.endsWith('record-chunker') ? 'export const createRecordingTap=()=>({start:async()=>{},stop:async()=>{},pause:async()=>{},resume:async()=>{}});'
    : 'export const createZoomSpeakers=()=>({destroy(){}}),createZoomChat=()=>({destroy(){}}),createTeamsSpeakers=()=>({destroy(){}}),createTeamsChat=()=>({destroy(){}});', loader: 'js' }));
} };
const page = { console, crypto: webcrypto, gmeetCallbacks, AudioContext,
  document: { querySelector: () => null, querySelectorAll: () => [] },
  location: { hostname: 'meet.google.com', pathname: '/abc-defg-hij' },
  navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
  addEventListener: (_type, fn) => pageListeners.push(fn),
  postMessage: message => pageMessages.push(message),
};
page.window = page; page.top = page; page.pageListeners = pageListeners;
vm.createContext(page); vm.runInContext(await bundle('./inpage.ts', '', [pagePlugin]), page);
const pageControl = async (command, sessionId) => {
  page.controlData = { __tinaControl: true, command, sessionId, requestId: command };
  vm.runInContext('for (const callback of pageListeners) callback({source: window, data: controlData})', page);
  await turn(); await turn();
};
await pageControl('tina-start', 'first');
assert.equal(gmeetCallbacks.length, 1);
await pageControl('tina-stop', 'first');
await pageControl('tina-start', 'second');
assert.equal(gmeetCallbacks.length, 2);
const audioBefore = pageMessages.filter(m => m.type === 'audio').length;
gmeetCallbacks[0](0, new Float32Array([.1]));
assert.equal(pageMessages.filter(m => m.type === 'audio').length, audioBefore);
gmeetCallbacks[1](0, new Float32Array([.1]));
assert.equal(pageMessages.at(-1).sessionId, 'second');
assert.equal(pageMessages.at(-1).type, 'audio');
await pageControl('tina-stop', 'second');
console.log('PASS inpage: delayed old-source callbacks cannot be relabelled with the next capture token');
