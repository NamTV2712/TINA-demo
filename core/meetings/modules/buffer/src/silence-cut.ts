/** A conservative acoustic boundary, never a textual estimate of where a word ends. */
export function silenceCut(pcm: Float32Array, sampleRate = 16000, minimumSamples = Math.ceil(.8 * sampleRate)): number | null {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 100) throw new RangeError('Invalid sample rate');
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 0) throw new RangeError('Invalid minimum span');
  const frame = Math.round(sampleRate / 100);
  const from = Math.max(minimumSamples, pcm.length - 4 * sampleRate);
  let runStart = -1, cut: number | null = null;
  for (let start = from; start + frame <= pcm.length; start += frame) {
    let power = 0;
    for (let i = start; i < start + frame; i++) power += pcm[i] * pcm[i];
    // Near-zero only: soft speech must not become a silence cut after a louder speaker.
    if (power / frame <= 1e-8) {
      if (runStart < 0) runStart = start;
      if (start + frame - runStart >= .2 * sampleRate) cut = Math.floor((runStart + start + frame) / 2);
    } else runStart = -1;
  }
  return cut;
}
