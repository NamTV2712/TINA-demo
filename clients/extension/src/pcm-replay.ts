export interface BufferedPcm {
  source: number; startSample: number; endSample: number; wire: ArrayBuffer;
}

/** Keeps only unacknowledged frames; a transport reset never changes their sample identity. */
export class PcmReplayBuffer {
  private frames = new Map<string, BufferedPcm & { sent: boolean }>();
  private samples = new Map<number, number>();
  bytes = 0;
  readonly maxBytes = 8 * 1024 * 1024;
  readonly maxSamplesPerSource = 16000 * 30;
  readonly maxFrames = 2048;
  get size(): number { return this.frames.size; }
  private key(source: number, start: number, end: number): string { return `${source}:${start}:${end}`; }
  enqueue(frame: BufferedPcm): boolean {
    const { source, startSample: start, endSample: end, wire } = frame;
    if (![source, start, end].every(Number.isSafeInteger) || source < 0 || source >= 0x40000000 || start < 0 || end <= start
        || wire.byteLength < (end - start) * 4) throw new Error('Invalid PCM replay frame');
    const key = this.key(source, start, end), previous = this.frames.get(key);
    if (previous) {
      const a = new Uint8Array(previous.wire), b = new Uint8Array(wire);
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) throw new Error('PCM range changed before acknowledgement');
      return false;
    }
    const samples = (this.samples.get(source) ?? 0) + end - start;
    if (this.bytes + wire.byteLength > this.maxBytes || samples > this.maxSamplesPerSource || this.size >= this.maxFrames)
      throw new Error(`PCM buffer full; source ${source} range ${start}..${end} could not be retained`);
    this.frames.set(key, { ...frame, sent: false }); this.samples.set(source, samples); this.bytes += wire.byteLength;
    return true;
  }
  acknowledge(source: number, start: number, end: number): boolean {
    if (![source, start, end].every(Number.isSafeInteger)) return false;
    const key = this.key(source, start, end), frame = this.frames.get(key);
    if (!frame || !frame.sent) return false;
    this.frames.delete(key); this.bytes -= frame.wire.byteLength;
    const remaining = this.samples.get(source)! - (end - start);
    if (remaining) this.samples.set(source, remaining); else this.samples.delete(source);
    return true;
  }
  replay(): void { for (const frame of this.frames.values()) frame.sent = false; }
  flush(send: (wire: ArrayBuffer) => void, canSend: () => boolean): void {
    for (const frame of this.frames.values()) {
      if (frame.sent) continue;
      if (!canSend()) break;
      send(frame.wire); frame.sent = true;
    }
  }
}
