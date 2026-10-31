# Vietnamese–English language review policy — 2026-10-23

## Delivered

- Extension choices: `vi` (Tiếng Việt) and opt-in `vi-en` (Việt–Anh). Existing saved choices and Auto remain unchanged.
- Shared ASR client: `vi-en` makes an automatic first pass. Non-Latin letters or an explicit detected language outside Vietnamese/English hold the whole result. Empty results do not trigger a retry.
- One suggestion pass uses Vietnamese when recent context contains Vietnamese diacritics, otherwise English. It omits the continuity prompt. A readable suggestion remains pending; forcing a language is not evidence that its text matches the audio.
- Desktop SQLite preserves original/retry text and Float32 request audio in `asr_language_reviews`, separately from confirmed segments, FTS and canonical projections. Input is finite and limited to 90 seconds; review audio is capped at 256 MiB per meeting and deduplicated by meeting/session/PCM hash.
- Authorized, origin-checked `/transcripts/{platform}/{native}/asr-reviews` and `.../{id}/audio` feed Transcript review. A live health notification opens that page from the extension. Pending suggestions are not automatically promoted into canonical text or extraction evidence.
- FunASR normalizes `vi`/`en` to canonical Qwen names. No VAD or energy threshold changes.

## Checks

- Shared transcription client suite passed, including language policy: bilingual acceptance; unexpected language/script; preservation of original/suggestion; failed suggestion; no continuity prompt on suggestion; unchanged Auto; empty audio result.
- Desktop suite passed, including SQLite restart/deduplication, WAV source bytes, denied owner/origin reads, and capture WebSocket → mocked Chinese ASR → held review with no confirmed text. Existing manual correction/restore and canonical tests also passed. Credential-dependent `desktop-e2e.live` skipped by its existing gate.
- FunASR model-free suite: 11/11 passed.
- Extension typecheck/build and shared client/Desktop builds passed. Architecture sealed; dataflow gate passed (114 nodes, 81 edges, 11 carriers).

## Real-model replay

Artifacts: `~/tina-test-rig/language-policy-20261023/{replay.mjs,results.json,summary.json}`.
Fixture: existing synthetic three-voice meeting, 15 independently decoded utterance WAVs, Vietnamese and English.
Meeting SHA256: `2f5063b33eb766735f985de0eede943d46c3382acc908226edea039cffd39216`.
Both passes used the same production `TranscriptionClient`, Qwen3-ASR-0.6B on MPS, and FSMN endpoint silence 800 ms.

| Metric | Auto | vi-en |
| --- | ---: | ---: |
| Utterances | 15 | 15 |
| Held | 0 | 0 |
| WER | 1.89% | 1.89% |
| CER | 0.79% | 0.79% |
| HTTP latency p50 | 343 ms | 337 ms |
| HTTP latency p95 | 1,202 ms | 453 ms |

All 15 outputs matched exactly between policies. Auto ran first; warmup/cache/load differ, so the latency difference is not a policy speedup. These are per-utterance HTTP times, not end-to-end caption delay. This segmentation differs from the earlier continuous-window meeting benchmark, so the error rates are not a before/after comparison with that report.

## Limits

The screenshot's exact audio was not found in the current journal by its visible Chinese phrases, so its failure is not reproduced or measured. The frozen replay contains no Chinese false positive; held-result behavior is demonstrated with a scripted ASR response, not an estimate of real-world recovery accuracy. Language/script checks cannot reliably distinguish Vietnamese from other Latin-script languages when the backend reports an unknown language. Entire suspect windows are held, including any valid words they contain; source audio remains available. Pending suggestions require listening/review and have no automatic approval path. No new diarization/alignment benchmark, live browser capture or model upgrade was performed.
