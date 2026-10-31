# Local Qwen decoder-token streaming PoC

An isolated, **single-source** experiment for the existing Apple Silicon host. It loads the cached
Qwen3-ASR-0.6B checkpoint through the already installed Transformers runtime on MPS/bfloat16.
The model calls `TokenStreamer.put()` as it generates tokens; visible text is emitted from that
callback, before `generate()` returns. No typewriter effect or replay of a finished response is used.

This is **not** TINA's production streaming backend. It does not modify Desktop/extension settings,
restart services, install packages, download weights or use a remote inference endpoint. The
production FunASR HTTP path remains selected. The PoC has no network listener. Audio/transcripts,
logs and reports stay outside Git in a new owner-only output directory.

## Run

Requires the existing `.venv/asr-benchmark` (metrics/fixture preparation) and `.venv/funasr`
(Qwen/Transformers/MPS) environments, the pinned Qwen cache and prepared FLEURS fixture cache:

```sh
python3 -m unittest discover -s deploy/transcription/streaming-poc -p 'test_streaming.py'
.venv/funasr/bin/python -m unittest discover -s deploy/transcription/streaming-poc -p 'test_guard.py'
.venv/asr-benchmark/bin/python deploy/transcription/streaming-poc/run.py \
  ~/tina-test-rig/asr-benchmark/fleurs-20261019 \
  ~/tina-test-rig/qwen-token-poc-NEW
```

Add `--show-events` to watch decoder events as they are produced. Otherwise follow the live
`events.jsonl` file with `tail -f` from another terminal. A completed run produces `report.md`,
`summary.json`, per-case `results.jsonl`, `scored-results.json`, runtime/source fingerprints and
before/after production process checks. Existing result directories are never overwritten.
An interrupted run is not promoted to a complete report and is not spliced into a later run.

The runner requires idle Desktop `:8056` and FunASR `:18000`, plus at least 5 GiB available RAM
before loading the temporary model. During decoding it stops if capture/ASR becomes active,
those processes change or less than 2 GiB remains available. MPS allocation for this process is
capped at 25% of its recommended working set; CPU inference fallback is disabled. These guards
do not reserve system RAM or make concurrent benchmarking appropriate for a live meeting.

## What is measured

The frozen manifest selects the first three FLEURS test clips per language in the existing
selection order whose duration is at most 15 seconds. References, original audio hashes and
accents/digits are preserved. A disjoint reserved clip supplies a three-second warmup.

There are also VI→EN and EN→VI concatenation controls using the first eligible test source in
each language with duration at most `(15 - .3) / 2` seconds, separated by 300 ms silence, and
a two-second zero-PCM control. Concatenations **are not natural code-switching recordings**;
their two orders reuse the same sources and are not independent observations.

Each fixture runs four modes with the same checkpoint/precision and greedy decoding:

| Mode | Audio availability | Visible text |
|---|---|---|
| `batch` | Whole clip supplied at once | After generation completes |
| `tokens` | Same whole clip supplied at once | Actual decoder token callbacks |
| `paced-1s` | Audio released at one-second source-clock intervals | Token callbacks within each decode |
| `paced-2s` | Audio released at two-second source-clock intervals | Token callbacks within each decode |

Full-file mode order alternates by fixture; paced modes follow. Warm-history, OS load and thermal
ordering remain limitations. No FSMN/Silero VAD is used in this experiment, so it is not a direct
score comparison against the current production FunASR+FSMN system.

- First-token time includes model protocol/language tokens; first-visible time excludes them.
- First-visible latency for paced modes includes simulated audio arrival. Full-file modes start
  with all audio available. Neither measures microphone→extension→Desktop→browser latency.
- Finalization tail is paced wall time minus source duration, not the duration of an audio chunk.
- Per-window `generation_s` starts before prompt/feature preparation and ends after MPS sync.
- Peak RSS is sampled in the model worker at 100 ms, including descendants. MPS driver/allocated
  memory is recorded **after** each window, not as a true transient GPU peak. Unified-memory
  accounting overlaps: do not sum RSS and Metal allocations as independent RAM.
- WER/CER use the existing accent-preserving benchmark metrics. Failures are empty hypotheses,
  not excluded cases. Silence nonempty outputs and final language eligibility are reported.
- p50/p95 are descriptive on three clips per language; no full-dataset/production guarantee follows.

## Decoder and event behavior

Audio is bounded at 15 seconds per experimental utterance. Paced modes re-encode the accumulated
audio and reuse a text prefix, rolling back five tokenizer tokens after the first two chunks.
This follows the SDK-style prefix strategy; **no incremental audio encoder or KV-cache reuse
across chunks is claimed**. Long meetings, many simultaneous sources and live VAD remain future
integration work. File end supplies the utterance boundary here.

- `delta`: extends the current visible hypothesis; carries the complete current text too.
- `replace`: revises the provisional hypothesis. Re-decoding a matching shorter prefix is held
  until it diverges or the chunk completes, avoiding a full→fragment→full flash.
- `chunk_done`: decoder timing, token count, source sample edge and memory snapshots.
- `final`: finalized safe VI/EN text at file end, with source sample bounds.
- `language_review`: unsupported language/script withheld from the caption path. Candidate text
  remains in the private experiment results and still counts in raw ASR accuracy scoring.

Incomplete protocol headers and replacement-character Unicode are withheld from visible deltas.
Reaching the token cap without EOS is a failure. Final SDK cleanup/whitespace corrections may
also produce `replace`; replacement counts are UI revision counts, not a semantic-error metric.
There are no word timestamps: token arrival times must never become spoken-word evidence.

Implementation uses the installed `qwen-asr==0.0.6` Transformers processor/generation seam;
its official `init_streaming_state()` remains vLLM-only. The model's standard Transformers
`streamer` hook is the experimental local adaptation being validated here. Before a production
adapter is selected, preserve TINA's per-source isolation, PCM ACK/replay, final-window checkpoint,
canonical edit/Restore protection and language-review behavior.
