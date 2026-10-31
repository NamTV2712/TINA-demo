# processed-notes.v1 — the per-meeting cleaned-transcript stream + its terminal marker

The **agent→meetings seam** (ADR 0027): the copilot worker (agent domain) XADDs cleaned notes onto
`proc:meeting:{row_id}`; meeting-api's db-writer (meetings domain) drains that stream into the
meeting row's durable `data.processed.views[]`, and agent-api's SSE relays it live. This stream
crossed a process + domain boundary unschema'd — a P4 violation — before this contract pinned it.
For canonical processing, Meeting API is the approved stream's single writer. Legacy workers
remain compatible only while a meeting has not enabled canonical processing.

Canonical notes use `canonical_notes_requests` (Meeting API → Agent API dispatcher) and
`canonical_notes_results` (isolated worker → Meeting API). Requests bind owner, meeting, window,
source fingerprint, exact revision evidence, generation and lease. `proof` is HMAC-SHA256 over
the UTF-8 JSON of every request field except proof, sorted keys, compact separators, unescaped
Unicode; the existing shared internal secret signs/verifies it. Workers never receive that secret.
Results are candidates: only the meeting-row-locked source/lease check may commit and publish them.
At-least-once delivery is idempotent; source changes revoke leases and stale only affected windows.
Pending leases recover after 180s, with at most three attempts per unchanged source. A request after
OFF cannot commit; explicit re-enable retries failed windows. ACK follows dispatch/DB commit and
acknowledged queue payloads are deleted. Artifact deletion also purges queued meeting payloads.

Approved notes carry `source`, exact `evidence`, `stale`, and a monotonically increasing
`publication_revision`. A stale readable note never becomes canonical text. `prompt_version`
joins model/provider provenance. Raw ASR, audio and user canonical revisions are untouched.

## Shapes (`$defs`)
- **`Note`** — one cleaned note, `id == segment_id` (1:1 with the transcript). Re-emitting an id
  **upgrades** the note (baseline at ingest, LLM polish per beat); consumers upsert by id.
- **`Params`** — provenance (`pipeline · version · provider · model`) stamped alongside notes and
  persisted verbatim into the durable view (reproducibility).
- **`ViewEnd`** — the terminal marker: the worker emits it after its final post-`session_end` beat.
  The stream is COMPLETE at this entry — the db-writer flushes the durable view on it, the live SSE
  closes on it. A worker that dies without the marker is covered by the consumer's bounded deadline
  (P22: graceful marker + hard guarantee), never by timing luck.

## Stream-entry encoding
An XADD entry is either a note — fields `note` (JSON `Note`) + optional `params` (JSON `Params`) —
or the marker — fields `type` = `"view_end"` + optional `cursor` (the last raw `tc:meeting:{row_id}`
stream id processed, making completion auditable).

## Keying (P0 — never the native id)
`{row_id}` is the meetings-domain numeric row id, unique per (user, platform, native, run). The
sibling keys `proc:meeting:{row_id}:on` (processing desired-state flag) and `…:cursor` (the worker's
resume position in the raw feed) are agent-internal — deliberately NOT part of this contract.

## Conformance
Goldens in [`golden/`](golden/) named `<Shape>.<case>.json` (drawn from the real run-46 stream);
`validate.mjs` (ajv) validates each against its `$def` (the filename prefix). Run by `gate:schema`.

Approved proc entries may carry `card` (JSON ApprovedCard) or `error` (JSON ModelFailure), alongside note/params and view_end. Changed row IDs ride metadata notifications; final publication atomically appends the complete current view before its marker and caches the closed publication revision. Agent API validates each signed job lease against Meeting API immediately before model dispatch, so queued canceled work is not admitted.
