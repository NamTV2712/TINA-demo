/**
 * L2 — the Discord PCM conditioning contract.
 *
 * These are the properties the transcript lane depends on, not implementation details:
 * stereo is downmixed, 48 kHz becomes 16 kHz at the right rate, the anti-alias filter actually
 * rejects the band that would fold into speech, and packet boundaries never change the samples.
 *
 * Run: npx tsx src/audio.test.ts
 */
import { Pcm48kStereoTo16kMono, opusPacketDecoder } from './audio.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};
const close = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

/** Interleaved stereo s16 from a per-sample function (amplitude in [-1,1]). */
function stereo(frames: number, f: (i: number) => [number, number]): Int16Array {
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const [l, r] = f(i);
    out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
    out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
  }
  return out;
}

const sine = (hz: number, amp = 0.9) => (i: number): [number, number] => {
  const v = amp * Math.sin((2 * Math.PI * hz * i) / 48_000);
  return [v, v];
};

/** RMS over the settled part of a signal (skip the filter warm-up). */
function rms(samples: Float32Array, skip = 0): number {
  let acc = 0;
  let n = 0;
  for (let i = skip; i < samples.length; i++) { acc += samples[i] * samples[i]; n++; }
  return n ? Math.sqrt(acc / n) : 0;
}

function peak(samples: Float32Array): number {
  let m = 0;
  for (const v of samples) m = Math.max(m, Math.abs(v));
  return m;
}

function convert(signal: Int16Array, chunkFrames = 960): Float32Array {
  const conv = new Pcm48kStereoTo16kMono();
  const out: number[] = [];
  for (let i = 0; i < signal.length; i += chunkFrames * 2) {
    const chunk = signal.subarray(i, Math.min(signal.length, i + chunkFrames * 2));
    out.push(...conv.push(chunk));
  }
  out.push(...conv.flush());
  return Float32Array.from(out);
}

// ── rate: 1 s of 48 kHz in → 1 s of 16 kHz out (within the filter's 6-sample delay) ──
{
  const seconds = 1;
  const out = convert(stereo(48_000 * seconds, sine(1000)), 960);
  check('1 s @ 48k → ~16 000 samples @ 16k', Math.abs(out.length - 16_000) <= 4, String(out.length));
}

// ── 20 ms packet → ~320 samples, and packets do not lose continuity ──
{
  const conv = new Pcm48kStereoTo16kMono();
  const first = conv.push(stereo(960, sine(1000)));
  const second = conv.push(stereo(960, sine(1000)));
  check('first packet emits 315 (15-sample group delay)', first.length === 315, String(first.length));
  check('second packet emits 320 (steady state)', second.length === 320, String(second.length));
  check('outputSamples counts both', conv.outputSamples === 635, String(conv.outputSamples));
}

// ── chunking invariance: same bytes → same samples, however they are framed ──
{
  const signal = stereo(48_000, sine(440));
  const whole = convert(signal, 48_000);
  const packets = convert(signal, 960);
  let same = whole.length === packets.length;
  if (same) for (let i = 0; i < whole.length; i++) if (whole[i] !== packets[i]) { same = false; break; }
  check('one block and 20 ms packets produce identical samples', same, `${whole.length} vs ${packets.length}`);
}

// ── DC gain: a constant must survive at the same level (unity passband) ──
{
  const out = convert(stereo(9600, () => [0.5, 0.5]));
  check('DC 0.5 → 0.5 (no gain error)', close(rms(out, 50), 0.5, 0.001), String(rms(out, 50)));
}

// ── stereo downmix ──
{
  const same = convert(stereo(9600, () => [0.4, 0.4]));
  check('L == R → same level (not doubled)', close(rms(same, 50), 0.4, 0.001), String(rms(same, 50)));
  const outOfPhase = convert(stereo(9600, () => [0.4, -0.4]));
  check('L == -R → silence (true downmix)', peak(outOfPhase) < 1e-3, String(peak(outOfPhase)));
}

// ── passband: speech-band tones keep their level ──
{
  const oneK = convert(stereo(24_000, sine(1000)));
  const expected = 0.9 / Math.SQRT2; // RMS of a 0.9-amplitude sine
  check('1 kHz RMS preserved', close(rms(oneK, 100), expected, 0.02), `${rms(oneK, 100).toFixed(3)} vs ${expected.toFixed(3)}`);
}

// ── stopband: 12 kHz would alias to 4 kHz if decimated naively ──
{
  const high = convert(stereo(24_000, sine(12_000)));
  // Measure RMS after the start-up transient: `peak` would report the filter's own step
  // response to a tone that begins abruptly, not steady-state alias leakage.
  const aliasRms = rms(high, 100);
  check('12 kHz rejected > 30 dB (no 4 kHz alias)', aliasRms < 0.9 * 0.03, String(aliasRms));
}

// ── flush returns the filter tail instead of dropping a turn's last milliseconds ──
{
  const conv = new Pcm48kStereoTo16kMono();
  conv.push(stereo(480, sine(1000))); // 10 ms — shorter than the filter's future context
  const tail = conv.flush();
  check('flush emits the buffered tail', tail.length > 0, String(tail.length));
  check('flush is idempotent on empty state', conv.flush().length === 0);
}

// ── decoder adapter: unaligned Buffer offsets are handled ──
{
  const pcm = Buffer.from([0x00, 0x10, 0x00, 0xf0, 0xff, 0x7f]); // 3 stereo frames
  const padded = Buffer.concat([Buffer.from([0xff]), pcm]);       // byteOffset 1
  const decode = opusPacketDecoder({ decode: () => padded.subarray(1) });
  const out = decode(new Uint8Array([0]));
  check('s16 decoder keeps signed values', out.length === 3 && out[0] === 0x1000 && out[1] === -0x1000 && out[2] === 0x7fff, [...out].join(','));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall audio checks passed');
process.exit(failed ? 1 : 0);
