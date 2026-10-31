/**
 * Pin the energy floor without treating quiet speech as silence, in both parity-locked buffers.
 * Run: npx tsx src/silence-gate.test.ts  (or via `npm test`, chained).
 */
import { SpeakerStreamManager, rms } from "./speaker-streams.js";
import { GmeetCompatibleBuffer } from '@tina/transcribe-buffer';

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failed++;
};

const SR = 16000;
const silent = new Float32Array(SR * 2); // 2s digital silence → RMS 0
const speech = new Float32Array(SR * 2).fill(0.1); // 2s well above the 0.0025 threshold
const quietSpeech = Float32Array.from({ length: SR * 2 }, (_, i) => 0.0012 * Math.sin(2 * Math.PI * 220 * i / SR));
const quantizationNoise = Float32Array.from({ length: SR * 2 }, (_, i) => (i % 2 ? 1 : -1) / 32768);

// The rms() oracle.
check("rms(silence) === 0", rms(silent) === 0);
check("rms(speech) ≈ 0.1 (>> threshold)", Math.abs(rms(speech) - 0.1) < 1e-6);
check("rms(empty) === 0", rms(new Float32Array(0)) === 0);

// The gate: drive one unconfirmed window through the real submit path (flushSpeaker → submitBuffer)
// and count how many times it reaches Whisper (onSegmentReady).
type Manager = Pick<SpeakerStreamManager, 'onSegmentReady' | 'addSpeaker' | 'feedAudio' | 'flushSpeaker' | 'removeAll'>;
type Factory = (threshold?: number) => Manager;
async function submitsFor(audio: Float32Array, factory: Factory, threshold?: number): Promise<number> {
  const mgr = factory(threshold);
  let submits = 0;
  mgr.onSegmentReady = () => { submits++; };
  mgr.addSpeaker("s1", "Alice");
  mgr.feedAudio("s1", audio);
  await mgr.flushSpeaker("s1", true);
  mgr.removeAll();
  return submits;
}

for (const [name, factory] of [
  ['gmeet', (threshold?: number) => new SpeakerStreamManager({ silenceRmsThreshold: threshold })],
  ['shared', (threshold?: number) => new GmeetCompatibleBuffer({ silenceRmsThreshold: threshold, scheduleSubmissions: false })],
] satisfies Array<[string, Factory]>) {
  check(`${name}: digital silence is not submitted`, (await submitsFor(silent, factory)) === 0);
  check(`${name}: PCM16 quantization noise is not submitted`, (await submitsFor(quantizationNoise, factory)) === 0);
  check(`${name}: normal speech is submitted`, (await submitsFor(speech, factory)) === 1);
  check(`${name}: quiet voice below the old 0.0025 gate is submitted`, (await submitsFor(quietSpeech, factory)) === 1);
  check(`${name}: an explicit legacy threshold is preserved`, (await submitsFor(quietSpeech, factory, 0.0025)) === 0);
  check(`${name}: an explicit zero threshold still disables the gate`, (await submitsFor(silent, factory, 0)) === 1);
}

if (failed) { console.error(`\n❌ silence-gate: ${failed} checks FAILED.`); process.exit(1); }
console.log(`\n✅ silence-gate: near-zero skipped, quiet speech retained, explicit thresholds preserved.`);
