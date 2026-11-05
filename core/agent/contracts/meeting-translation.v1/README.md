# meeting-translation.v1

Historical per-fragment response. The current endpoint returns the grouped
[meeting-translation.v2](../meeting-translation.v2/README.md) response; Terminal and
extension must be upgraded together. This schema stays frozen for reference.
The description below documents the original v1 behavior and cache.

Agent-owned English overlay for an authorized canonical meeting transcript.
`GET /api/meeting-translations/{meeting_id}` reads cached results without inference.
`POST` with `{"retry": false}` advances at most one missing finalized segment;
`retry: true` explicitly bypasses the provider backoff. The gateway exposes these
under `/agent/meeting-translations/{meeting_id}`. Every request rechecks meeting access.
An optional `segment_ids` list (at most 128 IDs) prioritizes currently rendered live
turns before historical backfill; source text always comes from the canonical API.

States are pending, running, paused and complete; complete refers to the current
snapshot, so a live meeting may gain more pending segments. retry_after is seconds.
Source text is included so renderers reject stale translations after text edits.
Original/processed ASR and canonical contracts remain unchanged; drafts are never translated.

Translations and short-lived job leases persist in `.meeting-translations/translations.sqlite3`
beneath the existing private agent workspace volume, outside workspace Git trees.
Rows are keyed by authenticated owner, meeting and segment, with a source-text hash.
Atomic leases deduplicate web/extension requests across API processes. A stale
lease expires after 120 seconds. A failed completion backs off 15s, 60s, then 300s;
reading the original transcript never depends on this store or on a model API.

Inference runs only while a client opens English/bilingual and advances the queue.
Closing all translated views pauses new inference; reopening resumes missing work.
The existing tool-less CompletionPort uses the owner's effective Meeting model.
Provider credentials stay server-side. Clients send meeting IDs, never arbitrary source text.
