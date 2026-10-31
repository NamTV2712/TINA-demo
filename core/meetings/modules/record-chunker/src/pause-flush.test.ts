import assert from 'node:assert/strict';
import { MediaRecorderChunker } from './index.js';

class Recorder extends EventTarget {
  static isTypeSupported() { return true; }
  state = 'inactive'; mimeType = 'audio/webm';
  ondataavailable: any; onstop: any; onstart: any;
  start() { this.state = 'recording'; this.onstart?.(); }
  pause() { this.state = 'paused'; this.dispatchEvent(new Event('pause')); }
  resume() { this.state = 'recording'; this.dispatchEvent(new Event('resume')); }
  emit(byte: number, delay = 0) {
    if (this.state !== 'recording') return;
    this.ondataavailable?.({ data: { size: 1, arrayBuffer: async () => {
      await new Promise(r => setTimeout(r, delay)); return Uint8Array.of(byte).buffer;
    } } });
  }
  stop() { this.emit(3, 20); this.state = 'inactive'; this.onstop?.(); }
}
(globalThis as any).window = { MediaRecorder: Recorder };
(globalThis as any).MediaRecorder = Recorder;
const chunks: number[] = [];
let final = false;
const chunker = new MediaRecorderChunker({ stream: {} as MediaStream, onChunk: async c => {
  if (c.isFinal) { assert.deepEqual(chunks, [1, 2, 3]); final = true; }
  else { assert.equal(final, false); chunks.push(Buffer.from(c.base64, 'base64')[0]); }
  return true;
} });
await chunker.start();
const recorder = chunker.getMediaRecorder() as unknown as Recorder;
recorder.emit(1, 20);
await chunker.pause(); recorder.emit(99);
await chunker.resume(); recorder.emit(2);
await Promise.all([chunker.stop(), chunker.stop()]);
assert.equal(final, true); assert.deepEqual(chunks, [1, 2, 3]);
let automaticFinal = false;
const automatic = new MediaRecorderChunker({ stream: {} as MediaStream, onChunk: async c => {
  if (c.isFinal) { await new Promise(r => setTimeout(r, 20)); automaticFinal = true; }
  return true;
} });
await automatic.start();
automatic.getMediaRecorder()!.stop();
await automatic.stop(); assert.equal(automaticFinal, true, 'stop waits for an already inactive recorder to finish delivering');
const rejected = new MediaRecorderChunker({ stream: {} as MediaStream, onChunk: async c => !c.isFinal });
await rejected.start(); await assert.rejects(rejected.stop(), /final chunk was rejected/);
console.log('PASS recording source pause excludes paused bytes; slow final blob precedes isFinal; concurrent stop waits');
