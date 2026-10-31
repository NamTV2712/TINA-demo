# Speaker registry and identity revisions

The meeting API owns `meeting.data.speaker_registry`. Its meeting-local UUIDs, source bindings,
segment mappings and append-only assignment history survive service restarts. No new DB column is
required. Google Meet capture carries an observed participant ID only when its name maps to exactly
one non-self observed tile. Equal names do not merge people. Missing or ambiguous metadata remains
unknown; legacy transcript labels are candidates, not verified identities or an attendance roster.

The owner reads `GET /transcripts/by-id/{meeting_id}/speakers` and confirms/renames a speaker with
`PATCH /transcripts/by-id/{meeting_id}/speakers/{speaker_id}`:

```json
{"expected_revision": 1, "name": "Nguyễn Minh"}
```

A null name explicitly keeps the identity unknown. Human assignments override later observed labels.
Every assignment records its source, observed participant reference, actor and timestamp. History is
owner-only and bounded to 100 revisions per identity. A stale update returns 409; a different owner
gets 404. Reading a legacy meeting registers its existing segment sources without guessing a person
from a display name. Unknown source streams stay distinct until stronger evidence is available.

The row lock commits registry/history and a `speaker.revised` outbox entry together. The existing
revision dispatcher publishes to the owner's meeting channel and the authorized row channel before
exact-ID acknowledgement. Retries may duplicate an event; consumers deduplicate by speaker UUID and
revision and refetch the exact meeting snapshot. Speaker revisions are independent of text revisions.
The payload contains no names, participant IDs, actors, history, transcript text or credentials.

Terminal and Dashboard expose **Speaker identities** next to transcript review. Both preserve newer
identity revisions against stale live ASR frames, while independently preserving corrected text.
The overlay changes speaker display names; audio and raw ASR text/labels remain in their original
storage. The registry is excluded from ordinary meeting data, list responses, shares and webhooks;
shared transcript readers see only the current public speaker projection.

This is platform metadata plus explicit human confirmation, not voice identification or diarization.
Only participants observed through attributed speech are represented; it does not claim a complete
Meet attendance roster. A repeated name or a reused audio channel is never evidence of one person.
