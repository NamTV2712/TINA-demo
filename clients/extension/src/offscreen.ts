/** Offscreen owns mic/tab sources and one recording stream for a capture session. */
import { createPcmCaptureNode } from '@tina/gmeet-capture';
import { createMixedAudioCapture, type MixedAudioCapture } from '@tina/mixed-capture-core';
import { createRecordingTap, type RecordingTap } from '@tina/record-chunker';
import { encodeRecordingChunk } from '@tina/capture-codec';

const PCM_WORKLET_URL = chrome.runtime.getURL('tina-pcm-worklet.js');
let sessionId: string | null = null;
let paused = false;
let cancelledSession: string | null = null;
let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let tabStream: MediaStream | null = null;
let streamId: string | null = null;
let tabCapture: MixedAudioCapture | null = null;
let recTap: RecordingTap | null = null;
let recordingContext: AudioContext | null = null;
let recordingDestination: MediaStreamAudioDestinationNode | null = null;
let micRecordingSource: MediaStreamAudioSourceNode | null = null;
let tabRecordingSource: MediaStreamAudioSourceNode | null = null;
let commands: Promise<unknown> = Promise.resolve();

function post(message: object, token = sessionId): Promise<any> {
  return chrome.runtime.sendMessage({ ...message, sessionId: token });
}
function recordingMix(): MediaStreamAudioDestinationNode {
  if (!recordingDestination) {
    recordingContext = new AudioContext();
    recordingDestination = recordingContext.createMediaStreamDestination();
  }
  return recordingDestination;
}
async function startMic(): Promise<void> {
  if (stream) return;
  const token = sessionId;
  const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
  if (sessionId !== token || cancelledSession === token) { acquired.getTracks().forEach(t => t.stop()); throw new Error('Capture cancelled'); }
  stream = acquired;
  ctx = new AudioContext({ sampleRate: 16000 });
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const node = await createPcmCaptureNode(ctx, (data, timeline) => {
    if (!paused && sessionId === token) void post({ type: 'audio', index: 1000, pcm: Array.from(data), captureMs: timeline?.captureMs, startSample: timeline?.startSample }, token).catch(() => {});
  }, PCM_WORKLET_URL);
  if (sessionId !== token || cancelledSession === token) { acquired.getTracks().forEach(t => t.stop()); throw new Error('Capture cancelled'); }
  source.connect(node); node.connect(ctx.destination);
  const destination = recordingMix();
  if (recordingContext!.state === 'suspended') await recordingContext!.resume();
  micRecordingSource = recordingContext!.createMediaStreamSource(stream);
  micRecordingSource.connect(destination);
  await post({ type: 'speakers', speakers: { '1000': 'You' } });
}
function stopRemote(): void {
  tabCapture?.stop(); tabCapture = null;
  tabRecordingSource?.disconnect(); tabRecordingSource = null;
  tabStream?.getTracks().forEach(t => t.stop()); tabStream = null; streamId = null;
}
async function startTab(nextStreamId: string, includeMic: boolean): Promise<void> {
  if (includeMic) await startMic();
  if (tabStream && streamId === nextStreamId && tabStream.getAudioTracks().some(t => t.readyState === 'live')) return;
  stopRemote();
  const token = sessionId;
  tabStream = await (navigator.mediaDevices as any).getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: nextStreamId } } });
  if (sessionId !== token || cancelledSession === token) { tabStream?.getTracks().forEach(t => t.stop()); tabStream = null; throw new Error('Capture cancelled'); }
  streamId = nextStreamId;
  tabCapture = await createMixedAudioCapture(tabStream!, (pcm, captureMs, startSample) => {
    if (!paused && sessionId === token) void post({ type: 'audio', index: 999, pcm: Array.from(pcm), captureMs, startSample }, token).catch(() => {});
  }, { sampleRate: 16000, includeSilence: true });
  // Keep the recorder's destination track alive when the tab source is replaced.
  const destination = recordingMix();
  if (recordingContext!.state === 'suspended') await recordingContext!.resume();
  tabRecordingSource = recordingContext!.createMediaStreamSource(tabStream!);
  tabRecordingSource.connect(destination);
  if (!recTap) {
    recTap = createRecordingTap({ stream: destination.stream, onChunk: async chunk => {
      const bytes = Uint8Array.from(atob(chunk.base64), c => c.charCodeAt(0));
      const frame = encodeRecordingChunk(chunk.chunkSeq, chunk.isFinal, /wav/i.test(chunk.mimeType) ? 'wav' : 'webm', bytes);
      return (await post({ type: 'RECORDING_CHUNK', frame: Array.from(new Uint8Array(frame)) }, token))?.ok === true;
    } });
    await recTap.start();
    if (paused) await recTap.pause();
  }
}
async function stop(): Promise<void> {
  try { await recTap?.stop(); }
  finally {
    recTap = null; stopRemote();
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    micRecordingSource?.disconnect(); micRecordingSource = null;
    await Promise.allSettled([ctx?.close(), recordingContext?.close()]);
    ctx = null; recordingContext = null; recordingDestination = null;
    sessionId = null; paused = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_STATUS' && !sender.tab) { sendResponse({ sessionId }); return; }
  if (!['NOTE_CAPTURE_START', 'TAB_CAPTURE_START', 'CAPTURE_STOP', 'CAPTURE_PAUSE', 'CAPTURE_RESUME'].includes(msg.type)
      || sender.tab || typeof msg.sessionId !== 'string') return;
  if (msg.type === 'CAPTURE_STOP' && sessionId === msg.sessionId) cancelledSession = msg.sessionId;
  const operation = async () => {
    if (msg.type.endsWith('_START')) {
      if (sessionId && sessionId !== msg.sessionId) await stop();
      sessionId = msg.sessionId;
      if (cancelledSession === sessionId) return { ok: true };
      paused = !!msg.paused;
      try {
        if (msg.type === 'NOTE_CAPTURE_START') await startMic();
        else await startTab(msg.streamId, !!msg.includeMic);
        await post({ type: 'capture-started', streams: (stream ? 1 : 0) + (tabStream ? 1 : 0) });
      } catch (error) { await stop(); throw error; }
    } else {
      if (sessionId !== msg.sessionId) return { ok: true };
      if (msg.type === 'CAPTURE_STOP') await stop();
      if (msg.type === 'CAPTURE_PAUSE') { paused = true; await recTap?.pause(); }
      if (msg.type === 'CAPTURE_RESUME') { await recTap?.resume(); paused = false; }
    }
    return { ok: true };
  };
  const next = commands.then(operation);
  commands = next.catch(() => {});
  next.then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.name === 'NotAllowedError' ? 'mic-permission' : String(error?.message || error) }));
  return true;
});
