# canonical-transcript.v1

Owner: meetings. Owner-only durable projection.

Authority-owned accepted transcript with independent text and speaker revisions.
Meeting API uses `recording-span` audio references; Desktop also emits the existing
`transcript-document.v1` `capture-span` shape for its local SQLite source timeline.
Consumers must inspect `kind` and resolve audio at the owning authority.

Desktop: `GET /transcripts/{platform}/{native}/canonical`. Anonymous acoustic groups
carry stable meeting-local IDs while their names remain `Unknown speaker` until
confirmed. Local microphone and verified participant metadata retain their identity.
Speaker changes do not increment text revisions or rewrite raw audio/text.

Without current verified forced alignment, `words`/`phrases` are empty and `alignment.status` is
`segment_fallback`; segment timing is not word alignment. Meeting memory evidence
reads this accepted projection and retains the exact quote and speaker identity.

Desktop Align words now supplies word/phrase timing over accepted text. Text edits
or Restore invalidate that timing; speaker changes only reproject attribution.
Canonical word/phrase times are source-absolute milliseconds; worker/job intervals
remain relative to each verified capture clip. OOV words keep null times.
