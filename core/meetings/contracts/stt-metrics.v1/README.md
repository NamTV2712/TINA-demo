# stt-metrics.v1

Desktop owner-only `GET /transcripts/{platform}/{native}/metrics` exposes bounded, content-free
stage measurements and durable SQLite row/PCM counters. Latency p50/p95 use the latest 256 samples
per stage, not a full-history histogram; `count` is lifetime count for this process/cache entry.
`since_ms` makes process restart/cache eviction visible. Up to 64 meeting metric entries are retained.

- `asr_http_ms`: client call, including HTTP, retries and retry sleeps; **not inference-only time**.
- `asr_audio_ms`: submitted window duration; `capture_to_request_ms`: age of the newest submitted
  audio at request start (endpointing, buffer and scheduling delay, synchronized source clock required).
- `storage_write_ms`: PCM receipt/archive write; `transcript_write_ms`: journal commit.
- `confirmed_caption_lag_ms`: finalized segment's source end to Desktop broadcast. Confirmed-only samples.
- `draft_age_ms`: draft window's source start to Desktop broadcast. It measures window age, not time
  since speech ended. A draft has no independently verified final speech endpoint.
- `caption_lag_ms`: legacy combined draft/final population retained for historical comparisons.
  Earlier Gmeet drafts used end=start, so those entries measured window age. Do not interpret its
  mixed percentile as confirmed-caption latency or subtract an ASR percentile from it.
- `ui_commit_ms`: extension receive handler through DOM update; `ui_frame_ms`: through two subsequent
  animation frames (a paint opportunity, not proof pixels were painted). Foreground samples only.
- `server_to_ui_ms`: server send timestamp to the foreground UI callback. Client-reported wall-clock
  value; do not compare clocks on different hosts without synchronization.

Extension submits only the three UI fields via the same owner-scoped POST endpoint, at most once
per five seconds. Invalid/unrecognized/text fields are refused. No transcript, PCM or credentials are
metric payloads. Server metrics and client-reported values remain named separately.

ASR `/status` supplies the existing worker queue wait/inference/request distributions; inspect it
alongside Desktop metrics to distinguish model queueing from capture buffering and storage/UI delay.
Meeting API emits content-free `transcript_storage` logevent.v1 records with persistence time,
Redis queue age and configured immutability threshold. Queue age includes intentional mutable-tail
retention; it is not an ASR inference duration. Terminal already retains local render/frame telemetry.
Missing samples/stages remain absent rather than reported as zero latency.
