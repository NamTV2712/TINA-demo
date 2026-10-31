# Desktop speaker mapping — 2026-10-27

Implemented and installed on the local TINA deployment. HTTP Window ASR and the
existing FSMN-VAD policy remain the defaults. The native build retains default
Speex AEC and residual suppression; this change adds no capture-side denoise,
AGC, VAD, 120 ms transport batching or 30-second delayed writes.

## Behavior

- Channel 1000 has one stable local microphone identity per meeting, including
  reconnects. Channel 1002 remains the raw AEC archive and never produces speaker
  identities or canonical/memory evidence.
- Verified Google Meet participant IDs bind identities across channel changes.
  Identical display names do not merge people. Saved channel names without a
  verified participant ID remain review hints, including recovered ASR.
- Channel 999 starts as unknown. Owner-triggered post-meeting analysis reuses the
  existing authenticated local diarization worker. It produces anonymous acoustic
  groups, with separate Apply. Overlap or insufficient exclusive speech stays
  unknown; this is not real-name recognition or calibrated confidence.
- Rename and segment assignment persist independent speaker revisions and
  history. Named identities remain selectable after all their segments are
  reassigned. Manual names, manual unknown and participant bindings take priority.
- Apply checks the job ID, registry revision, each source text revision and
  original segment bounds, plus regenerated WAV SHA-256 and sample-range mapping.
  Worker hash/model/duration/turn validation, cancellation and restart interruption
  never mutate accepted assignments. Speaker changes and metadata-only outbox
  insertion share one SQLite transaction.
- Canonical transcript and conservative VI/EN memory candidates read the same
  speaker projection. Evidence retains exact accepted text, text revision, timing
  and speaker identity. Drafts and raw mic sidecars are excluded. Naming the
  speaker does not infer an action assignee. Desktop word alignment remains
  `segment_fallback`, with empty word/phrase arrays.
- Review supports Analyze, Apply, confirm/clear name and per-segment assignment.
  Revision events refresh captions and memory. Extension final-only ticks merge
  by segment ID, preserving unrelated confirmed sentences, drafts and DOM anchors.
  Native captions distinguish simultaneous sources by stable segment ID instead
  of overwriting rows that share a timestamp.

## Verification

| Check | Result |
|---|---|
| Desktop package test suite and TypeScript build | PASS, including SIGKILL during live/recovery HTTP |
| Speaker mapping integration | PASS, five isolated HTTP worker calls; stale revisions, provenance, manual unknown, restart, outbox rollback, ACL and schema checks |
| Meeting API speaker/diarization/memory/canonical/foundation tests | 31 passed; one existing Starlette/httpx deprecation warning |
| Extension suite, typecheck and build | PASS; speaker events, partial final ticks, draft retention and DOM stability covered |
| Native UI tests | 18 passed |
| Native overlapping-source speaker repaint regression | PASS |
| Native release app build and code signature verification | PASS; local ad-hoc signing, no notarization |
| Browser review using isolated fixture | Rename, Analyze, Apply and assign unknown updated transcript/evidence; no JavaScript exceptions; existing favicon requests return 404 |
| Dataflow gate | PASS: 120 nodes, 94 edges, 11 carriers |
| Contract/architecture seals | Regenerated |
| Whole-repo schema gate | BLOCKED by existing Gateway OpenAPI title `Vexa API Gateway`; gate expects `TINA API Gateway` |

The worker response in the integration/browser tests is a controlled fixture.
The installed real worker reports healthy and Desktop reports it configured, but
these checks do not establish speaker accuracy, WER/CER or a 60-minute acceptance
result. No A/B test was run.

## Local deployment and integrity

Backup: `/Users/jky/Library/Application Support/TINA/app-backups/20261027-171015-speaker-mapping`.
This contains the previous native app, an SQLite backup, launcher copy and
before/after integrity reports. Desktop was restarted and the rebuilt
`/Applications/TINA Capture.app` installed/reopened while no capture was active.
Extension output was built at `clients/extension/dist`; loaded-browser reload
state was not independently verified.

Before and after counts match: **75 meetings, 295 transcript records and 248,651
PCM chunks**. SHA-256 of raw transcript/revision rows and all stored PCM bytes
matches before/after. SQLite `quick_check` returns `ok`. The running local
`speakers`, `diarization`, `canonical` and `memory` routes return successfully.
No diarization proposal was applied to the user's real historical meetings.

Current limits: at most 30 minutes including range padding, 256 continuous
verified source ranges and 2,000 segments per diarization job. Sessions beyond
that require future windowing with explicit cross-window speaker reconciliation.
Desktop and Meeting API remain separate authorities; background replication and
forced alignment are not added by this change. Ad-hoc native replacement can
require macOS recording permission to be granted again.
