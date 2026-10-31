# stt-foundation.v1

Owner: meetings. Desktop SQLite and Meeting API PostgreSQL keep their existing storage and local IDs.
This portable snapshot is an additional source reference, not a replacement for `transcript.v1` or
`canonical-transcript.v1`. It includes accepted revisions, immutable raw text and explicit audio references.

- `meeting_uid` = SHA-256 of UTF-8 compact JSON `["tina:stt:v1","meeting",instance_id,platform,native_meeting_id,local_meeting_id]`.
- `source_id` uses the same prefix with `["source",meeting_uid,session_id,channel]`.
- `segment_uid` uses `["segment",meeting_uid,segment_id]`. A text edit/Restore does not change this ID.
- Object fingerprints use recursively sorted keys and compact UTF-8 JSON; all numbers are safe integers.
  Times are integer microseconds. Source sample ranges are half-open. Fingerprints detect corruption;
  they are not signatures. Gateway authentication and destination owner checks authorize synchronization.
- Desktop `instance_id` persists in SQLite. API source instance IDs persist in the owning meeting's JSONB.
  Restore a journal backup with its metadata to retain identity; cloned journals must not become two writers.
- `authority.system` identifies the writer for this captured meeting/session. A Desktop source remains
  authoritative after copying it to a Bot meeting row. The Bot's native transcript remains a different
  authoritative capture. Native meeting links alone never merge runs or acoustic sources.

## Audio and revisions

Desktop source counters map to the saved source anchor at 16 kHz. Each reference covers one contiguous
archived range; missing samples split references and are never filled in by synchronization. Legacy
unverified clocks use null sample bounds and `unknown`. Encoded Bot recordings expose the **normalized
16 kHz decoded grid**, marked `decoded`; these are not encoded file byte offsets or inferred word times.
Original playback remains at the authority using the existing timeline/recording routes. Snapshots do not
copy PCM, fetch arbitrary URLs or guarantee playback when the authority/archive is unavailable.

`revision` is the accepted text revision; `history` is contiguous and its last text equals current text.
`sequence` is a separately persisted snapshot revision, advanced whenever source content changes. Receiver
PUT requires `expected_revision` equal to the receiver's previous sequence (zero for a first copy). Exact
retries are idempotent. Older sequences, rewritten raw text/history, changed authority, removed finalized
segments and concurrent stale writes return 409. Deleting meeting artifacts also deletes replicas.

Desktop snapshots may include optional `speaker_id` and `speaker_revision` per
segment. These meeting-local identities change independently of text `revision`;
the snapshot sequence/fingerprint also changes on accepted speaker mapping edits.

## Endpoints

- Desktop: owner `GET /transcripts/{platform}/{native}/foundation`.
- Meeting API: owner `GET /transcripts/by-id/{id}/foundation` (native Bot source).
- Owner `GET|PUT /transcripts/by-id/{id}/replicas/{meeting_uid}`.
- PUT body: `{ "expected_revision": 0, "snapshot": { ... } }`, up to 4 MiB.

Exports require capture to have stopped/finalized. Up to 2000 segments, 256 sources and 16 independent
source replicas per destination meeting are supported. Imports are read-only source snapshots in
`meeting.data.stt_replicas`; they never feed the raw Bot collector, AI extraction or native edits. Read a
replica explicitly; edits/Restore must be sent to its authority. Authority transfer, bidirectional edit
merging and automatic/live replication are outside this contract.

Explicit owner copy (API key in environment, never arguments):

```sh
node deploy/compose/bin/sync-transcript.mjs \
  http://127.0.0.1:8056/transcripts/google_meet/NATIVE \
  https://YOUR_GATEWAY/transcripts/by-id/ROW_ID
```

Set `TINA_API_KEY` for the destination gateway; optionally `TINA_DESKTOP_API_KEY` for Desktop.
No user transcript/audio is uploaded merely by enabling these endpoints.
