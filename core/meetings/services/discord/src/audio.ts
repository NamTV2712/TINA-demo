/**
 * Discord voice PCM conditioning.
 *
 * Discord sends each speaker as Opus packets carrying **48 kHz stereo s16le** (a voice packet
 * is 20 ms = 960 frames). TINA's per-channel lane consumes **16 kHz mono Float32** (see
 * `@tina/gmeet-pipeline`: `SpeakerStreamManagerConfig.sampleRate` defaults to 16000).
 *
 * The gap is not a formatting detail:
 *   • decimating 48k → 16k by dropping two of every three samples folds everything above
 *     8 kHz back into the speech band (aliasing). A 12 kHz component would land at 4 kHz —
 *     inside the range Whisper transcribes — so the conversion needs an anti-alias filter,
 *     not `pcm[i*3]`.
 *   • stereo must be downmixed BEFORE filtering, or the filter runs twice for no benefit.
 *
 * This module is the whole conversion, as a streaming transform with no I/O and no Discord
 * dependency: `push()` may be called with any frame size, and the output is bit-identical
 * whether a stream arrives as one block or as 20 ms packets (see audio.test.ts).
 */

/** FIR taps. A 31-tap Hamming window puts the transition band around 5 kHz, so the 7 kHz
 *  cutoff still rejects the 8–16 kHz band that would alias into speech (a 13-tap filter
 *  passes 12 kHz at −14 dB — audible as a 4 kHz whistle in the transcript). The group delay
 *  is 15 input samples (0.31 ms); 31 MACs per output sample is ~0.5 MFLOP/s per speaker. */
const TAPS = 31;
/** Anti-alias cutoff. 16 kHz output has an 8 kHz Nyquist; 7 kHz keeps the transition band
 *  below it, so the 6–8 kHz aliasing skirt never reaches the STT band. */
const CUTOFF_HZ = 7_000;
const INPUT_RATE = 48_000;
const OUTPUT_RATE = 16_000;
/** 48k → 16k is exactly 3:1, so the resampler needs no fractional phase. */
const DECIMATION = INPUT_RATE / OUTPUT_RATE;
const HALF = (TAPS - 1) / 2;

/** Hamming-windowed sinc, normalized to unity DC gain. */
function buildLowpass(taps: number, cutoffHz: number, sampleRate: number): Float32Array {
  const h = new Float32Array(taps);
  const fc = cutoffHz / sampleRate; // cycles per input sample
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const m = k - (taps - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1));
    h[k] = sinc * window;
    sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] /= sum;
  return h;
}

const LOWPASS = buildLowpass(TAPS, CUTOFF_HZ, INPUT_RATE);

/** s16le → Float32 in [-1, 1]. The asymmetric divisor is deliberate: -32768 has no positive
 *  counterpart, and dividing both by 32768 would clip +1.0 for loud speakers. */
function s16ToFloat(v: number): number {
  return v < 0 ? v / 32768 : v / 32767;
}

/**
 * Streaming 48 kHz stereo s16le → 16 kHz mono Float32.
 *
 * One instance per speaker stream. `push` is synchronous and allocation-light: the adapter
 * calls it once per decoded Opus packet (~50/s/speaker).
 */
export class Pcm48kStereoTo16kMono {
  /** Mono samples not yet consumed by an emitted output sample, indexed absolutely. */
  private buffer: Float32Array = new Float32Array(4096);
  private length = 0;
  /** Absolute input index of `buffer[0]`. Starts negative: the filter's left context for the
   *  very first output sample is silence, not a read before the array (which would be NaN). */
  private base = -HALF;
  /** Absolute input index of the next output sample's centre. */
  private nextOut = 0;
  private emitted = 0;

  constructor(private readonly lowpass: Float32Array = LOWPASS) {
    // Pre-roll: HALF zeros of history so centre 0 has a complete window.
    this.length = HALF;
  }

  /** Number of 16 kHz output samples produced so far (one per 320 samples at steady state). */
  get outputSamples(): number {
    return this.emitted;
  }

  /**
   * Feed interleaved stereo s16 samples. Returns the newly available mono 16 kHz samples.
   * The return may be empty for a very short push (the filter needs future context), never
   * for a normal 960-frame voice packet after warm-up.
   */
  push(interleaved: Int16Array): Float32Array {
    if (interleaved.length < 2) return new Float32Array(0);
    const frames = interleaved.length >> 1;
    this.ensure(this.length + frames);
    for (let i = 0; i < frames; i++) {
      const l = interleaved[2 * i];
      const r = interleaved[2 * i + 1];
      // Downmix first: one filter pass over the signal we actually keep.
      this.buffer[this.length++] = (s16ToFloat(l) + s16ToFloat(r)) / 2;
    }

    const out: number[] = [];
    // Emit only centres whose full filter window is available (causal buffering: the
    // newest HALF samples are future context for the next call).
    while (this.nextOut + HALF < this.base + this.length) {
      const start = this.nextOut - HALF - this.base;
      let acc = 0;
      for (let k = 0; k < this.lowpass.length; k++) acc += this.lowpass[k] * this.buffer[start + k];
      out.push(acc);
      this.nextOut += DECIMATION;
      this.emitted++;
    }

    // Retain the left context of the next centre (not the samples already emitted past it).
    const keepFrom = Math.max(this.base, this.nextOut - HALF);
    const drop = keepFrom - this.base;
    if (drop > 0) {
      this.buffer.copyWithin(0, drop, this.length);
      this.length -= drop;
      this.base = keepFrom;
    }
    return out.length ? Float32Array.from(out) : new Float32Array(0);
  }

  /** Flush the filter's remaining tail. Call once when the speaker's stream ends, so the last
   *  few milliseconds are not lost; pads with silence rather than truncating a turn. */
  flush(): Float32Array {
    if (this.length === 0) return new Float32Array(0);
    // Pad HALF zeros so the next centre's window is complete, then emit what fits.
    this.ensure(this.length + HALF + 1);
    for (let i = 0; i < HALF; i++) this.buffer[this.length++] = 0;
    const out: number[] = [];
    while (this.nextOut + HALF < this.base + this.length) {
      const start = this.nextOut - HALF - this.base;
      let acc = 0;
      for (let k = 0; k < this.lowpass.length; k++) acc += this.lowpass[k] * this.buffer[start + k];
      out.push(acc);
      this.nextOut += DECIMATION;
      this.emitted++;
    }
    this.length = 0;
    this.base = this.nextOut;
    return out.length ? Float32Array.from(out) : new Float32Array(0);
  }

  private ensure(n: number): void {
    if (n <= this.buffer.length) return;
    let cap = this.buffer.length;
    while (cap < n) cap *= 2;
    const grown = new Float32Array(cap);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
}

/** Decode one Opus packet to interleaved stereo s16le. The decoder is injected so the
 *  conversion above stays free of the native/JS Opus dependency (and so tests can hand in
 *  pre-recorded PCM). */
export type OpusPacketDecoder = (packet: Uint8Array) => Int16Array;

/** The minimal surface of `opusscript` this service uses. */
export interface OpusDecoderLike {
  decode(packet: Uint8Array): Uint8Array | Buffer;
}

/** Adapt an opusscript-style decoder to `OpusPacketDecoder` (48 kHz stereo). */
export function opusPacketDecoder(decoder: OpusDecoderLike): OpusPacketDecoder {
  return (packet) => {
    const pcm = decoder.decode(packet);
    // Copy into an aligned Int16Array: Buffer slices are frequently offset by one byte and
    // `new Int16Array(buf.buffer, buf.byteOffset, n)` throws on misalignment.
    const out = new Int16Array(pcm.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = (pcm[2 * i] | (pcm[2 * i + 1] << 8)) << 16 >> 16;
    return out;
  };
}
