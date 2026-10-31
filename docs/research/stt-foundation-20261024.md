# STT and Canonical Transcript foundation — 2026-10-24

## Implemented behavior

The existing capture/ring/archive/FSMN/Qwen windowed HTTP/caption/canonical modules remain in use.
No AI feature or token-streaming switch was added. Desktop keeps SQLite; Bot keeps PostgreSQL.

| Task | Delivered and verified | Remaining qualification |
|---|---|---|
| T1.1 Unified IDs | `stt-foundation.v1` adds global meeting/source/segment IDs, persistent authority and snapshot sequence. Owner GET/PUT replicas use CAS and idempotent retry. The same 1080-segment SQLite snapshot round-trips through actual PostgreSQL. | Explicit post-capture synchronization; local numeric IDs stay local. No automatic merge or authority transfer. |
| T1.2 Audio Timeline | Half-open sample ranges and microsecond source clocks preserve contiguous spans and gaps. Byte-exact source playback tested at the beginning/middle/end of the one-hour fixture. IDs and source links survive restart. | Bot encoded audio references the normalized 16 kHz decode grid, not encoded bytes. Legacy clocks remain unknown; replica playback requires its source archive. |
| T1.3 Revision Safety | Existing user CAS plus expected prior job ID at admission. Old jobs cannot replace a newer job; stale alignment becomes `stale` under the row lock. Edited PostgreSQL rows reject delayed raw upsert. Desktop edited text/source timestamps/channel survive delayed ASR. | Read-only replicas are edited at their authority. No automatic semantic edits or cross-authority merge. |
| T1.4 Recovery | Real SQLite FULL-synchronous ACK, SIGKILL after receipt, duplicate replay, revision preservation, archive equality; actual WS/process recovery suite passed separately. | Hour-long source clock is accelerated and deterministic text is used; this is not one-hour wall-clock microphone/model validation. |
| T1.5 Observability | `stt-metrics.v1` separates capture-to-request, ASR HTTP, PCM/transcript persistence, caption and foreground UI timings. Worker `/status` retains queue/inference metrics. Collector storage logs separate Redis age from persistence and configured mutable-tail delay. | Rolling process-local latest-256 samples; UI timings are client-reported. Two animation frames give a paint opportunity, not proof of pixel presentation. Cross-host wall clocks require synchronization. |

## One-hour source-clock integrity

Three continuous sources, 16 kHz Float32, 3600 source seconds, 1080 final segment IDs.
The second isolated run processed 691,200,000 PCM bytes in 8.70s wall time.
A child was SIGKILLed after a durable PCM receipt and before the associated transcript commit. Restart
replayed 542 already accepted frames; final PCM rows and segment IDs stayed duplicate-free.
All source bytes were compared, and beginning/middle/end playback was byte-exact for every source.
A user edit survived replay; Restore advanced to revision two and retained stable IDs. The writer's
sampled high-water RSS was 90.0 MiB (process only, not whole-system RAM).

The first soak completed its data work but stopped at a test assumption that the first sorted segment
was the edited one. The validator was corrected to select by stable segment ID and the complete soak
rerun in a fresh directory. Both attempts remain; no partial result was spliced into the final run.

## Real ASR and browser measurements

**Measurement correction from T1.7:** the historical `caption_lag_ms` series below pooled draft and
final events. Gmeet drafts use end=start, so those draft entries measure window age. The recorded
3802/6712 ms percentiles must not be treated as confirmed-caption latency. They are preserved as
historical observations. New diagnosis separates `confirmed_caption_lag_ms` and `draft_age_ms`.


A separate 9.71-second synthetic VI/EN capture replay used actual indexed ingest WebSocket, SQLite
and the existing real Qwen/FSMN MPS HTTP service. All 196 source frames were acknowledged, two speakers
produced final segments and ASR/storage error counters were zero. No heavy builds/gates ran concurrently
with this measurement. These six request samples describe this replay only.

| Stage | p50 ms | p95 ms |
|---|---:|---:|
| storage_write_ms | 0.53 | 1.29 |
| transcript_write_ms | 0.19 | 0.40 |
| asr_http_ms | 479.83 | 1022.21 |
| capture_to_request_ms | 0.00 | 2904.00 |
| caption_lag_ms | 3802.00 | 6712.00 |

ASR HTTP includes retries/transport/processing; it is not inference-only latency. Caption lag starts
at the source segment end, so it includes stable-text confirmation, buffering and finalization.
Source clocks are synchronized on this local test. Missing metrics are not zero-filled.

Isolated Chrome with the actual panel source passed Save/Restore, canonical WS revision refresh,
missed-event catch-up, selection after regrouping and scroll preservation. A synthetic receive into
the real panel render handler exercised DOM commit/two frames and the actual owner metrics POST.
Chrome runtime APIs were stubbed; the personal browser profile and microphone were not driven.
The metric payload contains only durations, not transcript text. See the private run artifacts under `~/tina-test-rig/stt-foundation-20261024/`.

## SQLite/PostgreSQL interoperability

`foundation_postgres.py` drove production handlers/SQLAlchemy against a fresh `tina_stt_verify_*` DB:
1080 source segments, three source IDs, exact snapshot equality, owner denial, idempotence, concurrent
CAS with exactly one winner, stale snapshot rejection, unchanged Bot canonical source, edited-row
raw/session/timestamp protection and stale alignment/job checks all passed. A first attempt exposed
a wrong use of the store's internal tuple helper; native exports were fixed to build the durable
source document directly under the transaction. The complete test then passed and was rerun against
the exact built/deployed image code. Temporary DBs were dropped in finally blocks.
The standalone sync CLI also passed separate owner-key/CAS/no-redirect checks.

Fingerprints provide integrity, not signatures. The gateway resolves the destination user, strips
spoofed identity headers and requires `tx` scope; Meeting API authorizes the owning row. The receiving
owner explicitly chooses a source snapshot. Replicas never write into native Bot transcriptions or
AI extraction. Artifact deletion removes their private payloads.

## Checks and local deployment

- Meeting API: 1488 tests passed, three skipped. The existing browser-session test's stale issue-number
  assertion was updated to assert the actual provisioning refusal. The transaction-scope gate exposed
  the old thread await under the meeting lock; bounded pure memory projection now executes synchronously
  there rather than yielding with a transaction held.
- Desktop dependency build, full package suite, sample-clock/gap tests, real WebSocket PCM reconnect,
  SIGKILL/recovery, canonical edit/Restore and delayed ASR protection passed. The legacy live fixture
  test skipped its unavailable pool; the separate real-ASR capture above supplies bounded live coverage.
- Extension lifecycle/panel/replay suite and typecheck passed. No UI redesign or new dependency was introduced.
  A later pnpm invocation auto-attempted workspace dependency reconciliation and refused the unrelated
  `@discordjs/opus` build; checks then used the already installed local tool binaries without approving
  that build. Other workspace lockfile changes were preserved.
- Gateway source routes, manifest parity, user-header stripping, receiver scope and invalid ID checks:
  24 tests passed. Prior stale route counts were updated to the current 85 scoped routes.
- Contract version: 39 sealed contracts; isolation and library exports passed. Architecture seal/views
  were regenerated and dataflow initially passed (118 nodes, 83 edges, 11 carriers).
- Final whole-repo dataflow is blocked by `core/meetings/services/discord`, which now exists but is
  unregistered. That module was not changed. Whole-repo diff whitespace also reports an unrelated
  terminal globals.css trailing blank line; STT scope is checked separately.

Local API/gateway overlays were built from the exact previous runtime images and only the scoped
source/schema/manifest additions. Runtime dependency versions and service environment were preserved.
Rollback tags: `tina/v012-meeting-api:before-stt-foundation-20261024` and
`tina/v012-gateway:before-stt-foundation-20261024`. Effective image selection is in
`compose-foundation.json`; the dev tags were not overwritten. Desktop was rebuilt and restarted via
its existing launch agent while idle. Extension built as 0.1024.1746.47.
ASR HTTP remained the platform-selected backend; no live capture was interrupted.

Desktop :8056, ingest :9099, ASR :18000, Meeting API :28080 and gateway :28056 are healthy. The deployed
OpenAPI tables include foundation/replica routes, and unauthenticated source requests return 401.

Production data after deployment: all 216 prior SQLite transcript records, 103,125 PCM chunks and 41 meetings remain; each prior raw/history/audio row was compared exactly. PostgreSQL transcription row fingerprint is unchanged. No user source replica was uploaded by this task.

## Limits before the real-meeting acceptance claim

This slice establishes the bounded software foundation, not a validated one-hour physical meeting.
A real 60-minute mic/Meet/Zoom/Teams run with natural overlap, echo and language switches remains
unmeasured. The earlier known acoustic diarization/English alignment/extraction-quality failures are
unchanged and outside this STT foundation slice. Synchronization is explicit after capture and metadata
only; no offline audio replica, bidirectional edits, automatic import into meeting memory or authority
transfer is claimed. Keep a source archive reachable to play audio referenced by a replica.
