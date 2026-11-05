# meeting-translation.v2

Owner-authorized English phrase overlay. Replaces the per-ASR-fragment v1 response
at GET/POST `/api/meeting-translations/{meeting_id}` (gateway `/agent/meeting-translations/{meeting_id}`).
Terminal and extension must be upgraded together; older viewers retain Vietnamese when the
response version is unsupported. The frozen v1 schema remains for historical reference.

`groups` contains core-owned phrase boundaries, exact `members` (source segment IDs/text),
combined `source_text`, English text or null, speaker identity and source start/end times.
`total` and `completed` count groups. Clients never infer phrase boundaries or distribute an
English sentence among source fragments. They reject a group's English if any visible member
has changed, and retain new/draft Vietnamese while waiting for the next snapshot.

Consecutive finalized segments of the same speaker join until a sentence ending (at least
six words), speaker change, a three-second source pause, or a size/time bound (40 words,
360 characters or 12 seconds). Oversized individual ASR segments remain intact. A live tail
waits five seconds without a newly observed finalized tail; stable capture timestamps alone
do not bypass this wait because ASR delivery may be delayed. Completed/stopped/failed
meetings flush their tail immediately. Empty/draft segments never enter translation.

GET authorizes the canonical transcript and meeting status, observes tail stability, and reads
cached results without inference. POST `{"retry": false, "segment_ids": []}` advances
at most one ready group. Optional source IDs (max 128) prioritize the currently rendered
live turns before historical backfill; callers cannot supply transcript bytes. `retry: true`
bypasses provider backoff, never an active lease or the live grouping wait.

The existing tool-less CompletionPort uses the owner's saved Meeting model and credentials.
Results persist in `phrase_translations` within the existing private SQLite cache on the agent
workspace volume, outside workspace Git trees. Cache keys include every member ID and exact
source text. Old v1 fragment results are retained on disk but never reused for phrase inference.
Atomic 120-second leases deduplicate web/extension calls across processes. Failures back off
15/60/300 seconds. Reasoning blocks never enter the visible English output. Capture and raw/
canonical transcripts stay independent. Inference advances only while a translated view is open.
