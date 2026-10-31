# Transcript refinement v1

Owner: meetings. Desktop exposes second-pass ASR proposals separately from live transcript.v1 and accepted transcript-document.v1 revisions. No LLM rewriting, translation, new speaker labels or word alignment.

Base: `/transcripts/{platform}/{native}/refinement` on the local Desktop gateway.

- GET base → latest job, or null before the first job.
- POST `/start` → 202 job. Requires a terminal meeting, complete archive, configured ASR, no active capture and no other running refinement. The current account/platform ASR selection is resolved and pinned once. Credentials and endpoint URLs are not persisted or returned.
- POST `/cancel` → job. Cancellation takes effect after the bounded in-flight ASR request returns; no automatic revision is applied.
- POST `/apply` with `{job_id,segment_id,expected_revision}` → transcript-document.v1. Only a ready suggestion from the latest settled job can be applied. Source audio hash and revision must still match; conflicts return 409. Text is taken from the saved proposal, never from this request. Revision and applied marker commit atomically. Restore uses the existing correction endpoint with text=null.

Every endpoint consults canAccess (GET read, POST write) and rejects unrelated browser origins. Unknown/unowned meetings follow the existing Desktop policy. The default local adapter is single-user; this is not multi-tenant authorization.

One worker re-decodes whole saved utterances sequentially, retaining source channel/gaps. Only unambiguous clips up to 30 seconds are eligible; other segments are skipped with a reason. The worker does not force a language or pass transcript text as a prompt. A second decode may be identical or worse: preview and audio comparison are required before Apply. No accuracy improvement is promised.

Live capture pauses refinement at utterance boundaries. The HTTP client waits at most 30 seconds per request, but an inference already running on the backend may continue holding the model lock after a timeout/cancel. This is cooperative scheduling, not inference preemption; do not assume zero effect on a new live capture. No automatic retry loop or automatic job start on meeting completion.

Jobs/proposals survive restart in SQLite. In-flight jobs recover as interrupted; ready proposals remain inspectable, unfinished items require starting a new job. All jobs are retained; GET returns the latest. Bot mixed recordings are not mapped to segments yet, so Meeting API/Terminal/Dashboard bot refinement is not exposed by this contract.

## Bot recordings and vocabulary hints

The authenticated gateway also serves `/transcripts/by-id/{id}/refinement` for Terminal/Dashboard owners.
GET, POST `/start`, `/cancel`, `/apply` follow the same job/proposal flow. Start accepts optional
`{"glossary":["TINA","FunASR"]}` (40 terms, 80 characters each, 700 combined). This is recognition
context, not text replacement or a guaranteed correction. No language is forced. The default remains
empty. Model, vocabulary and audio hash remain attached to the proposal/revision provenance.

Bots now upload the MediaRecorder start epoch as `audio_start_ms` and retain the transcript producer's
session UID. Review maps epoch segment times into that recording. Unclocked legacy recordings,
ambiguous sessions, clips over 30s, incomplete audio and masters over 256 MiB are skipped explicitly.
The owner can listen at GET `/transcripts/by-id/{id}/segments/{segment_id}/audio` (bounded WAV clip).
Recordings are read through internal object storage, never through a client-supplied playback URL.

One background worker per Meeting API process; durable progress/proposals live in meeting JSONB.
It pauses between clips while a bot is live. The in-flight ASR request is not preemptible; Desktop
capture in a separate process is not visible to this bot worker. Deployment currently uses one API
process. Multi-process refinement needs a distributed job lease before scaling this worker out.
Restart makes an unfinished job `interrupted`; retry is explicit. Apply rechecks source hash and
revision, then atomically appends correction provenance and marks the suggestion applied. Raw ASR
and recording bytes are never overwritten. Ordinary shared/list/webhook responses omit job data.

The review clients highlight added/deleted whitespace tokens, offer a changed-only filter, and put
source playback next to each proposal. For very long legacy text, diff falls back to whole-text
replacement to bound browser memory. These are textual differences, not word-aligned audio marks.
