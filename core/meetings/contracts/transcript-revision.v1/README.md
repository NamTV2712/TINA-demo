# Transcript revision v1

Owner: meetings. The canonical snapshot is existing `transcript-document.v1`: raw ASR/audio remain
unchanged, `text` is the latest accepted revision, and revision zero means the current ASR text.
Ordinary transcript reads also expose the accepted text and per-segment revision.

Manual edits, explicit refinement Apply, Restore and optional word-alignment completion append this notification to a durable outbox
inside the same transaction as history and the current-text search projection. Events contain only
routing identity and revision metadata. They never include raw text, history, actors, endpoint keys
or model credentials. They are private operational state, omitted from meeting/list/webhook data.

PostgreSQL pending events are in `meeting.data.transcript_outbox`. The dispatcher publishes to the
owner's existing `u:{user}:meetings` channel and the authorized per-meeting mutable channel, then
acknowledges exact event IDs under a meeting row lock. A failed publish/ack retries the same event;
duplicates and order changes are expected. SQLite stores events in `transcript_outbox` and emits
them to authorized local subscribers before acknowledgement. No separate broker is introduced.

The event `revision` is a monotonic per-segment invalidation sequence. Alignment can advance this
sequence without advancing the accepted-text revision count. Delivery to Redis/WebSocket is not a
browser acknowledgement. Offline clients converge by reading the exact meeting snapshot on
reconnect; a notification is an invalidation, not text to overwrite state with. Consumers ignore
older/duplicate sequences and discard older snapshot text. Live raw
ASR frames remain transcript.v1 and must not replace an accepted revision.

PostgreSQL searches `COALESCE(canonical_text,text)` through a dedicated GIN index with the existing
FTS configuration. SQLite uses FTS5 with Unicode token matching and accents preserved. Search
returns only authorized current text; old text remains available through owner revision history.
The two engines retain their own query/stemming semantics.

`kind: alignment` invalidates the separate `transcript-alignment.v1` owner view; it does not change
the canonical text or transcript-document.v1. The event contains no aligned words or audio.
