const NAMES = ['asr_http_ms','asr_audio_ms','capture_to_request_ms','storage_write_ms','transcript_write_ms',
  'caption_lag_ms','confirmed_caption_lag_ms','draft_age_ms','ui_commit_ms','ui_frame_ms','server_to_ui_ms'] as const;
export class SttMetrics {
  active = 0;
  errors = { asr: 0, storage: 0 };
  private values = new Map<string, {count:number; samples:number[]}>();
  readonly since = Date.now();
  caption(segment: {completed: boolean; start: number; end: number}, now = Date.now()): void {
    // Preserve the legacy mixed-population series; diagnosis uses the separated series below.
    this.record('caption_lag_ms',now-segment.end*1000);
    if(segment.completed)this.record('confirmed_caption_lag_ms',now-segment.end*1000);
    else this.record('draft_age_ms',now-segment.start*1000);
  }
  record(name: string, ms: number): void {
    if (!(NAMES as readonly string[]).includes(name) || !Number.isFinite(ms) || ms < 0 || ms > 3600000) return;
    const row = this.values.get(name) ?? {count:0,samples:[]};
    row.count++; row.samples.push(ms); if(row.samples.length>256)row.samples.shift();this.values.set(name,row);
  }
  snapshot(): object {
    return { since_ms: this.since, active_asr_requests: this.active, errors: {...this.errors},
      latency: Object.fromEntries([...this.values].map(([name,row])=>{
        const sorted=[...row.samples].sort((a,b)=>a-b);
        return [name,{count:row.count,retained:sorted.length,p50_ms:sorted[Math.ceil(sorted.length*.5)-1],p95_ms:sorted[Math.ceil(sorted.length*.95)-1]}];
      })) };
  }
}
