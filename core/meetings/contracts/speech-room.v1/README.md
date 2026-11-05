# speech-room.v1 — enrolled room arbitration and restart fencing

Meetings owns this coordinator handshake. Playback commands/receipts and `TurnStatus` remain
the frozen [speech.v1](../speech.v1/README.md) shapes. Upgrade coordinator and participant
clients together: the experimental phase 3 client without this handshake cannot reserve turns.

`GET /room` requires the participant's own `X-API-Key`, validated through Gateway `/auth/me`
and the configured enrollment list. It returns `RoomStatus` with `Cache-Control: no-store`:

- `epoch`: random UUID for this process boot. It is not a credential.
- `revision`: nonnegative counter, incremented atomically for each new capture grant.
- `busy`: true from capture grant through confirmed terminal playback. Ambiguous playback
  keeps it true. No participant identity, request ID, question, answer or source is exposed.

All `/turns/{request_id}` operations require `X-Tina-Speech-Epoch` equal to the observed boot
UUID. Mismatch is 409; never automatically bind/replay the old request against the new epoch.
`POST /turns/{request_id}` additionally requires `X-Tina-Speech-Revision` from the snapshot
used for that wake. Missing/malformed revision is 422. Busy/stale revision is 409. The revision
check and grant are atomic, preventing a delayed losing wake from obtaining a new turn after
the winner finishes. Existing owned request IDs return their retained receipt before the
busy/revision check; another identity cannot reuse/read/cancel that ID (404).

Each host polls independently every 250 ms with a one-second timeout. A snapshot older than
one second, failed poll or changed epoch disarms the host until explicit participant restart.
Capture is discarded and Stop is attempted in order after pending HTTP; no audio/Speak retry.
Busy hosts do not feed KWS or retain pre-roll. After idle or a missed revision, reset acoustic
history and require 800 ms continuous quiet before re-arming. A reservation race loser discards
its bounded local capture and waits for fresh idle/quiet; it never uploads that audio.

Capture leases expire after 35 seconds even if the client disappears; room polling releases
expired capture. WAITING/SPEAKING do not expire merely because a host disconnects: only actual
terminal receipt or explicit recovery unlocks an ambiguous playback. There is no pending queue.

Single-process, volatile pilot only: run one coordinator worker per room. Before restarting
after an unknown playback outcome, the operator must stop the old bot and confirm it has left,
then configure an active bot. Epoch fencing rejects stale grants but cannot silence an old bot
or provide durable exactly-once playback. TLS/reverse-proxy hosting is an operator concern;
the CLI binds loopback and disallows plain HTTP participant URLs outside loopback.
