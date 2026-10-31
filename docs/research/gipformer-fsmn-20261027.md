# Optional Gipformer + FSMN backend — 2026-10-27

Implemented under `deploy/transcription/gipformer` and running locally through
launchd `local.tina.gipformer`, authenticated at loopback port 18002. The existing
platform default remains FunASR / Qwen3-ASR-0.6B / FSMN-VAD at port 18000. No real
user preference or historical meeting/audio/canonical row was changed.

## Implementation boundary

This worker composes two independent runtimes: FunASR 1.4.15 loads FSMN-VAD on CPU;
Sherpa-ONNX 1.13.8 loads Gipformer 1.5 INT8 with OfflineRecognizer. It does not
claim native Gipformer support in FunASR AutoModel. The model assets and model card
are pinned to Hugging Face revision `dd9227dcd8705c13f33bdbe59728d546ab94480f`
with SHA-256 verification. Upstream inference code was inspected at revision
`0cac5b183d2e1a9e3429ff69080e09cc62ebdf9b`; no upstream Python model code is executed.
FSMN assets are independently hash-pinned. Weights stay in ignored runtime cache.
The new Python environment is `.venv/gipformer-fsmn`; existing ASR environments
were not modified.

The existing `/v1/audio/transcriptions` multipart boundary, verbose segments and
`asr-status.v1` diagnostics are reused. Authentication precedes multipart parsing;
upload bytes (including chunked bodies), decoded audio and queue sizes are bounded.
One native inference runs at a time, with three waiters and a 10-second queue wait.
Cancellation retains the lock until native inference exits. Logs/metrics contain
allowlisted request metadata and timings, not recognized text/audio/credentials.

Speech intervals retain their offsets on the original source timeline. Silence
is not removed by compressing the clock. The backend supports HTTP windows, not
token streaming, language detection, prompt conditioning, diarization or word
alignment. The compatibility model aliases `custom` and `whisper-1` resolve to
the same pinned Gipformer checkpoint. Explicit English requests fail rather than
pretending this is an English model; auto mode returns `language: unknown`.

## Settings and local deployment

Use Terminal **Settings → Models → Transcription → Custom endpoint** with
`http://host.docker.internal:18002` and the token stored privately at
`~/.config/tina/gipformer.env` (mode 0600). This reuses the existing settings path,
not a new named backend enum. The Desktop resolver already translates Docker's
host name to `127.0.0.1`. Sessions pin settings at admission; saving applies to the
next session. Choose Vietnamese or automatic language. **Follow platform default**
returns to Qwen. The current platform default was read back and confirmed unchanged.

The token is not embedded in source, commands, diagnostics or this report. The
launch agent reads its private file. Settings selection was not changed on the
user's behalf. To stop only the optional service:

```sh
launchctl bootout "gui/$(id -u)/local.tina.gipformer"
```

Reload it with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.tina.gipformer.plist"`.
The Qwen and existing diarization/alignment services are unaffected.

## Evidence

- Ten model-free tests passed: original clock/slices, request-local VAD cache,
  short-input padding, empty silence, resampling/channel limits, invalid VAD,
  authentication, multipart body limit, protocol and content-free diagnostics,
  queue saturation, failure propagation, cancellation locking and wait expiry.
- The live worker loaded hash-verified model assets and passed health checks.
- Actual `/status` conforms to the existing sealed `asr-status.v1` JSON schema.
- Docker Meeting API reached the authenticated host worker; an empty POST failed
  with 422 as expected, proving the URL route without changing model preferences.
- The actual shared Terminal Settings transcription probe passed against this
  worker with HTTP 200 and the private token, without saving a preference change.
- Real Gipformer smoke passed through Bot's per-channel engine and through
  capture.v1 → ephemeral Desktop → final transcript → canonical/memory, with one
  final segment on each host and zero observed engine faults. Participant/source
  identity and omission of worker credentials from SQLite were checked. This did
  not join a real browser meeting, persist real Redis/PostgreSQL rows or exercise
  physical microphone/system capture.
- Eight existing identity/admin settings tests passed (nine existing deprecation warnings).
- Existing Desktop settings resolution and shared STT-client tests passed,
  including pinned selection, fail-closed resolution, model alias transport,
  verbose JSON negotiation, typed HTTP failures and language-review behavior.
- Schema gate passed (32 validated contracts), contract seal gate passed (39
  schema contracts), and CALM dataflow passed (120 nodes, 95 edges, 11 carriers).
  CALM registers the new worker directory under the existing transcription service.

## Bounded replay, not a Qwen comparison

Before inference, a manifest selected the first five Vietnamese and five English
test entries in the existing frozen FLEURS manifest, the first three Vietnamese
domain entries in the frozen G-Group pilot manifest, and all three digital-silence
controls. Audio checksums were revalidated. No samples were replaced or omitted
after inference. All 16 requests completed successfully; total input was 156.804 s.
No new A/B run against Qwen was performed.

| Group | Clips | Ref words | S / D / I | WER | CER | API P50 / P95 |
|---|---:|---:|---|---:|---:|---|
| FLEURS Vietnamese | 5 | 188 | 11 / 1 / 0 | 6.38% | 4.31% | 0.719 / 1.230 s |
| Vietnamese domain | 3 | 38 | 8 / 0 / 4 | 31.58% | 18.90% | 0.241 / 0.259 s |
| FLEURS English, auto input | 5 | 120 | 42 / 55 / 1 | 81.67% | 66.27% | 0.424 / 0.904 s |
| Digital silence 2/5/10 seconds | 3 | — | zero nonempty outputs | — | — | 0.004 / 0.006 s |

Scoring reused the existing accent-preserving NFC/casefold/punctuation normalization,
whitespace Vietnamese token WER and whitespace-free CER. API timing includes HTTP,
VAD and recognition; it is not capture-to-caption latency. The sample is too small
for a representative percentile, comparison with earlier Qwen results, a product
quality gate or proof of real-meeting quality. English was intentionally submitted
with no forced language as a capability check; it is clearly unsuitable on this
sample. Vietnamese domain errors also caution against generalizing the FLEURS score.

Raw per-request local evidence and frozen manifest:
`/Users/jky/tina-test-rig/asr-benchmark/gipformer-fsmn-integration-20261027-182711`.
FLEURS metadata/licenses and G-Group pilot metadata are retained in their existing
source manifests; this run only performs local inference, not redistribution.

## Limits

Keep Qwen as the bilingual default. Gipformer is optional for Vietnamese sessions,
with code-switched terms and full English speech still needing representative
evaluation. The worker has no independent language detector to route English
automatically. VAD intervals are not word-level timestamps; MFA remains a separate
revision-safe background function. Continuous speech above 30 seconds is decoded
in bounded windows; validated overlap decoding is a later task. No streaming
session protocol, auto routing, new Settings backend enum or real-meeting browser
acceptance was added.
