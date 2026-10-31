# ASR status v1

Owner: meetings. Read-only `GET /status` reports the loaded checkpoint, actual resolved device,
admission queue, lifetime request/error counts and nearest-rank p50/p95 over the latest 100 requests.
No transcript text, audio, participant identifiers, endpoint URLs, or credentials are permitted.
Counters and samples reset when the service restarts. `null` means unmeasured, not zero.

`audio_ms` is submitted audio duration, not a latency. `capture_ms` is a producer-side estimate
from the last sample of the submitted window to STT submission. It excludes hardware capture
latency and should not be compared across unsynchronized clocks. Queue/inference/service durations
use one service's monotonic clock. Percentiles are individual distributions and must not be added.
The model pipeline includes VAD, Qwen, and segment assembly; it is not Qwen-only GPU timing.

Optional client headers: `X-ASR-Source` (bounded enum), `X-ASR-Capture-Ms` (finite 0–3600000) and
`X-ASR-Request-ID` (UUID). Unknown sources become `unknown`; invalid timing is absent. The server
returns its UUID as `X-ASR-Request-ID` and durations in `Server-Timing` (`asr_queue`,
`asr_inference`, `asr_total`). These headers do not change the transcription response contract.
The Terminal proxies status through its verified admin gate and keeps browser frame timings local.
