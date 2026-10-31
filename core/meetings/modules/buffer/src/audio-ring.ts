/** Fixed PCM storage; sample positions are source-local and never use network arrival time. */
export interface AudioFrame {
  session: string; source: string; samples: Float32Array; captureMs: number; startSample?: number;
}
export interface AudioRange { startSample: number; endSample: number }
export interface AudioTimelineEvent extends AudioRange {
  session: string; source: string;
  kind: 'gap' | 'overflow' | 'duplicate' | 'clock-discontinuity' | 'source-limit';
}
export interface TimedAudio extends AudioFrame {
  startSample: number; endSample: number; sourceCaptureMs: number; clock: 'samples' | 'legacy';
}

export class AudioRing {
  private pcm: Float32Array;
  private present: Uint8Array;
  private first = 0;
  private end = 0;
  private origin?: number;
  constructor(readonly capacity = 16000 * 30, readonly sampleRate = 16000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(sampleRate) || sampleRate < 1) throw new Error('Invalid audio capacity');
    this.pcm = new Float32Array(capacity);
    this.present = new Uint8Array(Math.ceil(capacity / 8));
  }
  private mark(sample:number,value:boolean):void {
    const i=sample%this.capacity, bit=1<<(i%8), byte=i>>3;
    if(value)this.present[byte]|=bit;else this.present[byte]&=~bit;
  }
  private has(sample:number):boolean { const i=sample%this.capacity;return !!(this.present[i>>3] & (1<<(i%8))); }
  get range(): AudioRange { return { startSample: this.first, endSample: this.end }; }
  get bytes(): number { return this.pcm.byteLength + this.present.byteLength; }
  append(frame: AudioFrame): { frame: TimedAudio | null; events: AudioTimelineEvent[] } {
    if (!frame.session || !frame.source || !Number.isFinite(frame.captureMs) || frame.samples.length < 1 ||
        frame.samples.length > this.sampleRate * 90 || frame.samples.some(v => !Number.isFinite(v)) ||
        (frame.startSample !== undefined && (!Number.isSafeInteger(frame.startSample) || frame.startSample < 0))) throw new Error('Invalid audio timeline frame');
    const events: AudioTimelineEvent[] = [];
    const emit = (kind: AudioTimelineEvent['kind'], startSample: number, endSample: number) => events.push({session:frame.session,source:frame.source,kind,startSample,endSample});
    let start = frame.startSample;
    if (start === undefined) {
      const inferred = this.origin === undefined ? 0 : Math.round((frame.captureMs - this.origin) * this.sampleRate / 1000);
      // Legacy senders have no sample counter: tolerate callback jitter, but keep large gaps explicit.
      start = this.origin === undefined || Math.abs(inferred - this.end) <= this.sampleRate / 10 ? this.end : Math.max(this.end, inferred);
    }
    const originalStart = start;
    const stop = start + frame.samples.length;
    if (!Number.isSafeInteger(stop)) throw new Error('Audio sample index exceeds safe range');
    if (this.origin === undefined) {
      this.origin = frame.captureMs - start * 1000 / this.sampleRate;
      this.first = this.end = start;
    }
    const canonicalMs = this.origin + start * 1000 / this.sampleRate;
    if (Math.abs(canonicalMs - frame.captureMs) > 100) emit('clock-discontinuity', start, stop);
    if (start < this.end) {
      emit('duplicate', start, Math.min(stop, this.end));
      start = this.end;
      if (stop <= start) return {frame:null,events};
    }
    if (start > this.end) emit('gap', this.end, start);
    const nextFirst = Math.max(this.first, stop - this.capacity);
    if (nextFirst > this.first) emit('overflow', this.first, nextFirst);
    // Never iterate over a potentially hours-long missing range.
    if (start - this.end >= this.capacity) this.present.fill(0);
    else for (let i = this.end; i < start; i++) this.mark(i, false);
    for (let i = Math.max(start, nextFirst); i < stop; i++) {
      this.pcm[i % this.capacity] = frame.samples[i - originalStart];
      this.mark(i, true);
    }
    this.first = nextFirst; this.end = stop;
    return {frame:{...frame, samples:frame.samples.subarray(start-originalStart),startSample:start,endSample:stop,
      captureMs:this.origin + start * 1000 / this.sampleRate,sourceCaptureMs:frame.captureMs+(start-originalStart)*1000/this.sampleRate,clock:frame.startSample === undefined ? 'legacy' : 'samples'}, events};
  }
  read(start: number, end: number): { samples: Float32Array | null; missing: AudioRange[]; captureMs: number | null } {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end-start > this.capacity) throw new Error('Invalid audio read range');
    const missing: AudioRange[] = [];
    let open: number | null = null;
    for (let i = start; i < end; i++) {
      const absent = i < this.first || i >= this.end || !this.has(i);
      if (absent && open === null) open = i;
      if (!absent && open !== null) { missing.push({startSample:open,endSample:i});open=null; }
    }
    if (open !== null) missing.push({startSample:open,endSample:end});
    if (missing.length) return {samples:null,missing,captureMs:null};
    const samples = new Float32Array(end-start);
    for (let i=start;i<end;i++) samples[i-start]=this.pcm[i%this.capacity];
    return {samples,missing,captureMs:this.origin === undefined ? null : this.origin + start*1000/this.sampleRate};
  }
}

/** One host budget across sessions, not an unbounded map per socket. */
export class AudioTimelinePool {
  private sources = new Map<string, AudioRing>();
  constructor(readonly maxSources=16, readonly capacity=16000*30, readonly sampleRate=16000) {
    if (!Number.isSafeInteger(maxSources) || maxSources<1) throw new Error('Invalid source limit');
  }
  private key(session:string,source:string):string { return JSON.stringify([session,source]); }
  append(frame:AudioFrame): {frame:TimedAudio|null;events:AudioTimelineEvent[]} {
    const key=this.key(frame.session,frame.source);
    let ring=this.sources.get(key);
    if (!ring) {
      if (this.sources.size>=this.maxSources) return {frame:null,events:[{session:frame.session,source:frame.source,kind:'source-limit',startSample:frame.startSample??0,endSample:(frame.startSample??0)+frame.samples.length}]};
      ring=new AudioRing(this.capacity,this.sampleRate);
      const result=ring.append(frame);this.sources.set(key,ring);return result;
    }
    return ring.append(frame);
  }
  read(session:string,source:string,start:number,end:number) { return this.sources.get(this.key(session,source))?.read(start,end) ?? {samples:null,missing:[{startSample:start,endSample:end}],captureMs:null}; }
  release(session:string):void { for (const key of this.sources.keys()) if (JSON.parse(key)[0]===session) this.sources.delete(key); }
  get stats() { return {sources:this.sources.size,maxSources:this.maxSources,capacitySamples:this.capacity,sampleRate:this.sampleRate,bytes:[...this.sources.values()].reduce((n,r)=>n+r.bytes,0)}; }
}
