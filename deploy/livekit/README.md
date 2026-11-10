# Self-hosted LiveKit Agents voice runtime

Default self-hosted voice runtime for new capable Google Meet rooms. One worker process supports up to three concurrent meetings,
with a separate LiveKit room, AgentSession, turn lock and caller contexts for each meeting/session.
Use one replica/process; horizontal scaling requires worker ownership and routing and is not supported.
The existing bot owns Google Meet capture, per-speaker KWS, selected ASR, turn ownership and microphone
playback receipts. Confirmed questions use custom HTTP I/O into Agents; PCM uses custom HTTP output
back to the existing bot microphone. This pilot does not publish raw meeting audio into LiveKit rooms
or add a second ASR/transcript writer.

Agents runs a custom LLM adapter calling TINA's capability-authenticated, policy-checked answer API
and a TTS adapter calling the existing local VieNeu service. LLM choice, retrieval permissions, source verification and actual playback receipts remain in TINA.
Agents executes up to two batches of two SDK function tools, using the selected LLM through TINA's
credential boundary. It does not receive an owner API key or access private workspaces. Per-caller
ChatContext is refreshed from source-valid heard history; history resolves references, never facts. This is an orchestration pilot, not a new model or a quality guarantee.

## Enable and select

Set `LIVEKIT_AGENT_URL=http://livekit-agent:8080` in the Compose environment (encrypt with dotenvx
when using the encrypted deployment). Start it with the local TTS/voice profile using the existing
dotenvx runner:

```sh
make all
```

Enable `TINA_MEETING_VOICE=1` in the selected main environment (new templates already do this).
`make all` decrypts it with its matching root `.env.keys`, loads the separate encrypted TTS token
through `deploy/tts/run.py` when needed and automatically adds the `livekit` and `speech` profiles.
Explicitly supplied valid TTS credentials still work. A missing key fails before application restart;
`make plan` can report missing credentials without creating any file. KWS bootstrap verifies the
existing model cache, or imports the two pinned local ONNX files from `TINA_KWS_MODELS_DIR`.
It creates separate LiveKit API keys with a domain-separated HMAC of the decrypted internal secret;
the original secret is not forwarded to LiveKit. Both services stay on the private Docker network.
There is no new public port, Cloud account or model download.

Start a new Google Meet bot so it has the bridge-capable image and seeded defaults. To change a room override, open **Settings → Voice
assistant → Room answers**, choose the active meeting, set **Voice runtime → LiveKit Agents · local
pilot**, then save. Saving stops the old voice turn. Keep transcript/documents/general/web permissions
as desired: selecting the runtime grants no additional sources. Choose **TINA** and save to switch
back. A deployment without the pilot URL refuses this choice. Old bot images cannot claim pilot
readiness. New capable Google Meet rooms default to Agents with all four answer options on. Existing saved policies and account opt-outs remain unchanged. Up to three active Agents meetings are supported.
The pilot does not change ASR model selection, audio windows or canonical transcript writes.

The bot owns KWS/VAD endpointing, wake/follow-up speaker ownership and explicit interruption commands.
Agents runs the LLM/TTS model adapters and generation/playout task cancellation. The TINA answer API
still owns authorized retrieval, source verification, model selection and played-prefix receipts. HTTP PCM
delivery is not proof that anyone heard it; only existing bot microphone receipts establish that.
Agents handles the native function-tool loop for transcript, shared Wiki/documents and explicit public
web queries. Automatic Agents turn detection/barge-in remains disabled. See
[tools and context](../../docs/tina-livekit-tools-context.md) for the internal protocol and limits.

## Checks

```sh
uv sync --project deploy/livekit --locked
uv run --project deploy/livekit pytest deploy/livekit -q
```

`smoke.py` runs inside the worker with its existing environment. It creates a real self-hosted room,
runs real AgentSession LLM/TTS adapters, uses the real local TTS service, proves Stop replay fencing
and deletes the room. Its meeting API is a synthetic fixture; it does not read real meeting data.
A real Google Meet listening test remains separate. The pilot reserves at most current PCM plus one
lookahead, bounds frame queues/audio length, and reaps inactive/revoked sessions. Rooms close after
90 seconds idle or when the meeting/session policy becomes invalid.

All fixed, prewarmed phrases in the bot's `VOICE_NOTICES` catalog go directly to the shared local TTS endpoint,
so it cannot queue behind the same AgentSession's pending LLM call. Generated answer sentences use
the Agents TTS adapter. Both paths retain the bot's microphone/Stop and played-prefix receipts.

Whole-meeting recap computation remains in TINA's existing background pool. AgentSession waits for
the verified final answer in the same exclusive room turn: core HTTP timeout 150 seconds, SDK LLM
timeout 160 seconds and overall answer wait 165 seconds. Busy sessions are not idle-reaped. Stop,
disconnect and source-policy/session changes still cancel the turn; no late result starts a new reply.

Speech completion also requires every VieNeu synthesis stream for the current request to reach a
validated end; SDK SpeechHandle completion alone is insufficient. A synthesis/transport failure
aborts the chunked PCM response, so the existing bot reports playback failure and cannot mark the
unspoken remainder as heard. Header size checks use pure ASGI middleware to preserve these streamed
failures on the actual HTTP connection. Tests include a real local TCP client receiving incomplete
chunked transfer, plus recovery on the next speech request.

Room cleanup rechecks registry ownership and idle/busy state while holding the same lock used to
replace sessions. Each runtime generation has a distinct room name, so a delayed remote room-delete
request cannot delete its replacement. A deterministic concurrency test holds the old policy check
while a replacement runtime opens and verifies that the old runtime closes only once.
A failed synthesis retires its SDK session before the next request, including after repeated failures
that exhaust the SDK's error budget. Source history remains in TINA and is revalidated as before.

The internal Meeting API endpoint is `http://meeting-api:8080` (the same address used by the gateway).
The Agents readiness probe checks both LiveKit server and Meeting API connectivity, so a wrong port
or unavailable TINA API cannot be reported ready. Tests assert Compose endpoint consistency and
verify readiness fails on connection refusal or a non-200 Meeting API response.

`/ready` additionally authenticates to shared TTS and validates PCM16/mono24kHz readiness without
synthesizing or calling a paid LLM. Compose health checks and Meeting API voice preflight use it.
`/health` retains dependency liveness and capacity/session counts; a full worker stays healthy and
refuses a fourth meeting with 503. PCM requests also validate the exact live Redis turn through the
capability-authenticated Meeting API before starting, periodically while streaming and at completion.
This check survives SDK runtime recreation; local in-memory Stop markers are not the authority.

Run `python production_smoke.py` inside the prepared worker for automated qualification. It opens
three actual local LiveKit rooms/AgentSessions, executes SDK tools, checks different room contexts,
streams fifteen uncached local VieNeu replies over TCP, rejects a fourth room, checks Stop isolation,
quota-error recovery and refusal of old audio after runtime recreation, then deletes its own rooms.
Meeting API, LLM and playback receipts are explicit synthetic fixtures; no actual meeting data or
Google Meet audio is accessed. It reports measured first-PCM latency, not a production speech SLO.
See [production qualification](../../docs/tina-livekit-production.md) before releasing broadly.

Meeting API permission/session failures remain distinct from service outages: 401/403/404 deny
access, 409 invalidates the room session/policy, and other non-200 service responses return 503.
A transient service outage does not make the reaper revoke a busy or recently used room. New requests
still require a successful policy check; retaining a room grants no additional source access. The
existing idle cleanup remains bounded, and a later explicit revocation still closes the session.

Planner/tool/final generation failures release the core turn and retire the SDK runtime before the
next request, so repeated LLM outages cannot leave a closed Agents session permanently unusable.
Heard history stays in TINA and is restored only after successful policy/source validation.

A second bounded plan can change search terms or read surrounding original text when the first
lookup does not answer every part of the question. The core caps the retrieval phase at 30 seconds
and four attempted tools. Context reads require a per-turn handle returned by an earlier tool.
A deadline skip keeps the successful earlier results for final generation; Stop and changed
permissions reject every late operation. No new tool result is retained as heard chat history.

Supplemental service failures also keep successful prior queries available for verified final
generation. SDK calls are bound to the exact turn object/call ID, preventing a late callback from
attaching itself to a later question. No source or permission check is bypassed by this fallback.

The shared bot controller treats the optional acknowledgment as best effort and re-prepares a failed unplayed lookahead once when its playback turn arrives, including a LiveKit stream that fails before any PCM is ready. It rechecks generation/policy before replacement and playback; Stop and actual played-prefix receipts remain authoritative. No already-started audio is retried.

Shared bot recovery also handles buffered-but-unplayed stream failures, with at most one retry and no retry after playback starts. Acknowledgment TTS has its own three-second deadline. Core admission reclaims only provably retired session reservations using CAS, including stale playback ownership, while current session and late-result fences remain enforced.

PCM admission credits follow the entire ASGI response lifetime. A client disconnect before headers
or before the body iterator starts closes the iterator and returns the reserved slot, so cancelled
requests cannot exhaust the two per-room speech/lookahead slots. The regression test injects a
header-send disconnect and checks both credit and lock cleanup.
