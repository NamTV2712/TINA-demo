# Transcript alignment v1

Owner: meetings. This is an optional owner-only annotation over the immutable raw ASR transcript
and a verified saved recording span. It is served separately from the closed
`transcript-document.v1`; it does not replace its text or timestamp meanings.

`GET /transcripts/by-id/{meeting_id}/alignment` returns job status, model/audio/text provenance,
one token record for every whitespace token in raw ASR, and consecutive speaker phrases. A token
without a trustworthy acoustic alignment has `aligned: false` and null timestamps. Speaker IDs are
included only when one exclusive diarization cluster covers the word, or a confirmed participant
assignment covers its source segment. Overlap and uncertainty remain unknown.

`POST .../alignment/start` starts the serialized local MFA job; `POST .../alignment/cancel` stops
after the current worker request. Completion writes metadata-only `transcript.revised` events with
`kind: alignment` to the existing transactional outbox. Terminal and Dashboard refetch this view on
the event. Neither the aligned view nor its events contain full transcript text or audio bytes; the owner-only aligned view retains the source tokens.

The job is stored in the existing owner-scoped `meeting.data.transcript_alignment` JSONB carrier.
Artifact deletion removes this data with recordings and speaker analysis. MFA Vietnamese model
version and source hashes stay attached to each aligned segment.

Desktop serves the same envelope at `/transcripts/{platform}/{native}/alignment`.
Its jobs declare `text_kind: accepted`: exact whitespace tokens come from accepted
verbatim text at `expected_revision`, while immutable ASR stays separately available.
Items use `capture` with session/channel, sample offsets and source-absolute bounds
instead of the Bot `recording_id`/recording bounds. Legacy Bot items remain valid.
Desktop cancellation discards pending results; a shared worker may finish its
current request. Published timing survives restart independently from job status,
and stale text/source references never enter canonical or playable word audio.
