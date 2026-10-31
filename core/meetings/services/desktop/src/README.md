# desktop/src

`alignment-model.ts` owns alignment types, provenance validation, hashes and pure
word/speaker projection. Both `alignment.ts` (the background worker) and
`transcript-journal.ts` use this model; the journal never imports the worker.
Revision conflicts and SQLite transactions remain owned by the journal.

[`desktop.ts`](desktop.ts) — the host: `startDesktop()` wires the ingest WS (decode `capture.v1`
→ `gmeet-pipeline` → real STT) to a SQLite journal + the gateway. Gateway routes:
`POST /extension/sessions` (mint), `POST /extension/sessions/end` (finalize a session NOW — dispose
the pipeline, flush the recording, mark completed; the extension's Stop contract), `POST /telemetry`
(accept the extension's JSON diagnostics into a ring buffer — never 404s) + `GET /telemetry` (read it
back), `GET /transcripts/{p}/{n}`, `GET /bots`, `GET /recordings/{p}/{n}` (the assembled master) +
`GET /recordings/{p}/{n}/player` (a dependency-free HTML5 `<audio>` page for it), `/ws`.

[`recording-sink.ts`](recording-sink.ts) — the **recording.v1 receiver PORT** (P5; see ADR-0005). A
pure assembly core (no WS, no disk): accumulates recording.v1 chunks per session and on `is_final`
assembles the master via `@tina/recording` `buildRecordingMaster`, handing the bytes to an injected
`onMaster`. `desktop.ts` fills `onMaster` with the disk-write + gateway-serve adapter.

Tests (`gate:node` runs all three): [`recording-sink.test.ts`](recording-sink.test.ts) is the **L2**
unit (synthetic chunks via an in-memory fake → assert the assembled master); [`recording-e2e.test.ts`](recording-e2e.test.ts)
is the **L3** integration (synthetic recording.v1 over the real ingest WS → decode → sink → a REAL file
on disk → served by the gateway; no live meeting); [`desktop-e2e.live.test.ts`](desktop-e2e.live.test.ts)
is the end-to-end transcript gate against real STT (skips without `TINA_TX_KEY` + `EVAL_CACHE`).

[`transcription-settings.ts`](transcription-settings.ts) resolves the identity-owned ASR selection at capture admission. `GET /transcription/config` previews safe next-session metadata; each session pins its config until stop. [`transcription-settings.test.ts`](transcription-settings.test.ts) covers authenticated/global selection, fail-closed lookup and two different mock STT endpoints through real capture frames.

## Reliable transcript storage

`transcript-journal.ts` owns `transcripts.sqlite` in `recordingsDir`: meeting recovery, immutable original ASR, manual/restore history, and original Float32 audio chunks with capture timestamp, source channel and session UUID. SQLite WAL uses FULL synchronization; the journal and sidecars are owner-readable only. New sessions archive delivered PCM once, not each overlapping ASR request. Audio has a 2 GiB per-capture-session cap; write/cap failures surface an archive health fault and `archive_error`, while ASR continues. This is about 230 MB of PCM per hour per continuously delivered 16 kHz source, plus SQLite/index overhead. No audio before this deployment can be recovered retroactively.

The startup snapshot is only a bootstrap: existing durable rows win. A process-interrupted active session recovers with status `interrupted`. Tests inject `statePath: ':memory:'` for isolation; persistence tests use temporary SQLite files. Node >=22.13 supplies node:sqlite without a new dependency.

- `GET /` lists saved transcripts.
- `GET /transcripts/{p}/{n}/review` opens the local review editor.
- `GET /transcripts/{p}/{n}/document` returns transcript-document.v1, raw/normalized/current text and history.
- `PATCH /transcripts/{p}/{n}/segments/{id}` accepts `{expected_revision,text}`; null restores raw. Active captures cannot be edited, stale writes return 409.
- `GET /transcripts/{p}/{n}/audio/{chunk_id}` serves one source frame; `/segments/{id}/audio` reconstructs a bounded segment clip on its source channel and retains capture gaps. This is not word alignment.

Every document/audio/editor read and correction passes the same canAccess port. New local routes reject cross-origin browser requests; the default single-user loopback adapter still allows the local owner. Live transcript.v1 stays original ASR; ordinary REST reads apply corrections. `transcript-journal.test.ts` and `transcript-review.test.ts` cover original preservation, channel separation/gaps, restart, HTTP/audio, revision conflict, restore and read/write denial.

Segment playback refuses ambiguous overlapping capture sessions instead of guessing which audio belongs to a segment. The individual retained source frames remain addressable by chunk ID.

## Post-meeting second pass

`refinement.ts` reuses TranscriptionClient and the immutable journal clips. POST `/transcripts/{p}/{n}/refinement/start` starts one sequential background job using the current owner/platform ASR config. GET `/refinement` returns the latest persisted job; POST `/cancel` requests cooperative cancellation. The review page polls progress, displays per-segment suggestions and sends `{job_id,segment_id,expected_revision}` to POST `/apply` only after user approval. Apply atomically appends a revision with model/audio-hash provenance; original text and live events stay unchanged. New captures pause the worker between requests; a backend decode already running can still compete even after the client's 30-second timeout. Jobs in flight at restart recover as interrupted.

Only unambiguous source utterances up to 30 seconds are decoded, without language forcing or a transcript prompt. Missing/long/ambiguous source clips are skipped with reasons. No audio means no refinement; no attempt to guess bot recording offsets. Tests in `refinement.test.ts` cover preview-only behavior, Apply/Restore, stale writes, failures, pause/cancel and source limits; HTTP coverage is in `transcript-review.test.ts`. Public shape: `transcript-refinement.v1`.

Review refinement now offers whitespace-token additions/deletions, a changed-only filter and source
clip playback beside the proposal. Optional comma-separated vocabulary hints apply only to that
second-pass job (40 terms / 700 total characters); no live ASR defaults are changed. Empty vocabulary
keeps the previous behavior. Long legacy text falls back to whole-text diff to bound browser memory.

Canonical revisions: each correction updates history, FTS5 current text and the SQLite outbox in
one transaction; refinement Apply also saves its applied state atomically. GET /transcripts/search
queries only authorized current text (plain Unicode token AND matching). Restart rebuilds the text
index from existing records and retries metadata-only revision notifications. The local Review page
refreshes on notifications/reconnect, preserving unsaved manual edits.

`foundation.ts` and `TranscriptJournal.foundation()` export `stt-foundation.v1` with a persistent
journal instance, monotonic snapshot sequence, stable source identities and explicit contiguous
sample references. `foundation.test.ts` checks gaps, revisions and restart; `foundation-soak.ts`
checks an accelerated hour of real SQLite PCM and SIGKILL/replay. Existing edited segment clocks
and channel bindings remain authoritative even if a delayed raw result arrives.
`stt-metrics.ts` bounds latency samples; `stt-metrics.test.ts` verifies its schema and owner/origin
boundary. No transcript text or source audio is submitted as a metric.
Draft source-start age and finalized source-end publication lag have separate series; the legacy
combined `caption_lag_ms` must not be used as a finalized-caption latency distribution.
`mixed-transcript.ts` namespaces mixed segment IDs by connection and channel, retaining the same
ID for draft/final updates but preventing microphone/tab/reconnect turn-counter collisions.

Capture teardown only plans recovery for uncovered ranges; it never marks every received sample
as processed. `asr-checkpoint.test.ts` checks a voiced hole, quiet tails, missing PCM, retries,
idempotent commit and unchanged user revisions. Historical checkpoints are left intact.

## Local speaker-aware projection

`/speakers` persists a meeting-local registry in SQLite, with independent CAS
revisions and a metadata-only outbox. Mic 1000 retains one identity across capture
sessions; raw 1002 stays archive-only. System mix 999 never proves a participant
name. Trusted Meet participant IDs bind voices without merging same-name people.
Owner review supports confirming/clearing names and explicit per-segment assignment.

`/diarization` sends only verified saved system audio to the existing authenticated
loopback worker. Analysis and Apply are separate; Apply rejects stale audio/text/
speaker state, protects manual unknown and preserves raw text/PCM/timestamps.
The current worker supports 30 minutes and 256 continuous ranges. Anonymous groups
are not real-name recognition; ambiguous or overlapping whole segments stay unknown.

`/canonical` and `/memory` share the accepted speaker projection. Canonical words
use segment fallback until forced alignment exists. Memory uses the existing
conservative VI/EN cue rules, exact quotes, text revisions and speaker IDs; extracted
actions remain candidates with no inferred assignee. Speaker and text events refresh
review/extension clients; caption replay omits pending so drafts survive name changes.

## Word timing

`alignment.ts` adapts the existing loopback MFA `/align-batch` worker to the accepted
Desktop text at an expected revision. `TranscriptJournal` resolves one continuous
verified capture source, encodes PCM16, and publishes timing plus a metadata-only
outbox event in a transaction. Edits/Restore remove accepted timing immediately.
`transcript_sequences` is independent of text revision length, so alignment events
cannot hide a later owner edit. Raw text, PCM and segment clocks are unchanged.

Canonical projects current word speakers and source-absolute timing; OOV words stay
unaligned. Word playback checks the exact job, text revision and source WAV hash.
`alignment.test.ts` covers delayed workers, invalid responses, ambiguous sources,
cancel, restart, owner boundaries, speaker repaint and revision ordering. The
Review page supports Align words, progress/cancel and verified word audio.
