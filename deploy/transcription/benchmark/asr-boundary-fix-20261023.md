# ASR boundary fix — 2026-10-23

## Result

On the unchanged 69.47-second, three-voice synthetic VI–EN fixture, the accepted profile reduced ASR errors from 10/159 to 2/159 tokens. All nine deleted reference tokens were recovered; two substitutions remain (“ghi” → “g”). Raw audio/reference were not edited.

| Metric | Original fixed 8-second replay | Accepted fixed VAD + silence-cut replay |
|---|---:|---:|
| WER | 6.29% | 1.26% |
| CER | 7.10% | 0.63% |
| Deletions | 9 | 0 |
| Substitutions | 1 | 2 |
| Insertions | 0 | 0 |
| Canonical ASR segments | 9 | 15 |

Both original full repetitions gave identical text. The accepted profile gave identical error counts in the accelerated diagnostic and final real-time full-pipeline run. These are descriptive fixture results, not an estimate for real meeting accuracy.

## Implemented changes

- `buffer/silence-cut.ts`: shared PCM-only boundary helper. It requires a sustained 200 ms near-zero gap in the most recent four seconds, respects a caller-supplied minimum span, and partitions samples without omission or duplication. Soft speech is not compared against a louder speaker to declare silence.
- Mixed CSRC provisional rolls: wait for a suitable gap after the minimum provisional duration and last submitted draft. Keep pending captions and the existing 28-second hard cap; close the prefix and reopen the same track at the exact source-sample boundary. Gapped capture spans do not use compacted PCM offsets as source time.
- Mixed EOF: flush the remaining owned audio through the available track/audio edge after a roll. The regression test proves that the 250 ms retained quiet tail plus one second of new speech reach the next request, rather than disappearing on stop.
- FunASR adapter: validate and forward `min_silence_duration_ms` to FSMN `max_end_silence_time`. Default is explicitly pinned at 800 ms (allowed 100–2000). The old adapter ignored this client control; the installed FSMN runtime chooses its dynamic-silence behavior when no explicit end-silence threshold is supplied.
- The A/B planner imports the production boundary helper. It reads PCM only, never reference text, TTS turn times or speaker IDs. Replay waits until the recorded observed-audio edge; it does not claim future lookahead is free. Max replay request is 25 seconds and EOF flushes the rest.

## Rejected experiments and controls

Changing cuts alone was not sufficient: the earlier-cut trial retained 6.29% WER, and the later-cut trial worsened to 19.50%. Those trial artifacts were retained. After explicit VAD endpointing, 300/500/800 ms all gave 1.26% WER / 0.63% CER on the synthetic silence-cut fixture.

The 300 and 500 ms defaults were rejected using a small sensitivity check on two cached FLEURS Vietnamese and two English human clips (114 reference tokens):

| Explicit silence threshold | Word errors | WER on these four clips |
|---|---:|---:|
| 300 ms | 10 | 8.77% |
| 500 ms | 8 | 7.02% |
| 800 ms | 5 | 4.39% |

The explicit 800 ms human result reproduced on recheck. This is a threshold sensitivity control, not a held-out population benchmark or proof that the old implicit dynamic mode has the same human error rate. No model weights, language hint or reference-derived glossary were changed.

## Final real-time latency

| Measurement | Accepted run |
|---|---:|
| Request + durable write p50 (13 requests) | 0.70 s |
| Request + durable write p95 | 1.31 s |
| Speech-bearing request p50 (11 requests) | 0.74 s |
| First finalized caption from replay start | 9.32 s |
| Last caption after audio end | 0.49 s |
| Diarization job | 5.66 s |
| Alignment job | 17.56 s |
| Replay + sequential background-stage sum | 93.30 s |

The original runs observed p50 1.27–3.57 s and p95 3.33–26.04 s. The machine was shared and timings varied substantially across runs, so the latency change is not attributed entirely to this patch. First-caption waiting includes eight seconds of audio observation. There were two no-speech requests in the accepted replay.

## Downstream verification

All final runtime assertions passed: immutable raw ASR/audio hash, exact candidate evidence/revision, owner isolation, actual attributed-word rename, edit/restore and stale-revision rejection, durable PostgreSQL projections and metadata-only outbox. Temporary PostgreSQL and MinIO test artifacts were deleted.

No matched aligned word midpoint falls more than 250 ms outside its reference TTS utterance in this run (the original had one 1154 ms outlier). This does not measure phonetic word-boundary MAE. Alignment still times only 73/159 tokens, and diarization still returns two clusters for three source voices. Extraction remains rule-based candidates and can mislabel negation/current-state phrases.

## Artifacts and limits

- Original: `~/tina-test-rig/meeting-e2e-20261023-02/` and `...-03/`.
- Accepted full pipeline: `~/tina-test-rig/meeting-e2e-boundary-20261023-04/`.
- All cut-only / VAD threshold trials and human controls: `~/tina-test-rig/asr-boundary-diagnostics-20261023/`, plus `meeting-e2e-boundary-20261023-01/` through `...-03/`.
- Audio, JSON snapshots, metrics and cleanup proofs stay outside Git. Use the boundary A/B instructions in the benchmark README with a fresh output directory.
- Pipeline testing uses in-process Meeting API HTTP with real model workers, PostgreSQL and MinIO. It excludes physical microphones, room noise, natural overlapping speech, browser and Google Meet transport.
- Pending cadence is unchanged; continuous speech with no qualifying quiet gap can wait longer for a final, up to the existing hard bound. The two short human controls per language are insufficient to establish general ASR quality.

## Delivery checks

- FunASR adapter: 11 model-free queue/cancellation/request-validation tests pass.
- Buffer suite, full mixed-pipeline suite and Desktop suite pass; Desktop's separate credential/cache-gated live test remains skipped. The synthetic real-worker pipeline above was actually executed.
- Buffer, mixed-pipeline and Desktop builds pass. The final local `tina/tina-bot:dev` image was rebuilt and checked for the compiled silence-cut and bounded EOF-flush implementation; subsequent bot spawns use it.
- The loopback FunASR worker was restarted idle and its live OpenAPI advertises default 800 ms and validated bounds. Existing workers and APIs remain healthy.
- Architecture registry/seal updated; `gate:dataflow`, generated-view freshness and scoped whitespace checks pass.
