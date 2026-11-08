# LiveKit Agents pilot

Opt-in self-hosted room voice runtime. One LiveKit room and one AgentSession are allowed at a time.
The existing bot owns Google Meet capture, per-speaker KWS, selected ASR, turn ownership and microphone
playback receipts. Confirmed questions use custom HTTP I/O into Agents; PCM uses custom HTTP output
back to the existing bot microphone. This pilot does not publish raw meeting audio into LiveKit rooms
or add a second ASR/transcript writer.

Agents runs a custom LLM adapter calling TINA's capability-authenticated, policy-checked answer API
and a TTS adapter calling the existing local VieNeu service. LLM choice, read-only tools, source
verification and played-prefix history remain in TINA. The agent does not receive an owner API key or
access private workspaces. Its own chat context is isolated per request; only TINA's revalidated history
is used as evidence/context. This is an orchestration pilot, not a new model or a quality guarantee.

## Enable and select

Set `LIVEKIT_AGENT_URL=http://livekit-agent:8080` in the Compose environment (encrypt with dotenvx
when using the encrypted deployment). Start it with the local TTS/voice profile using the existing
dotenvx runner:

```sh
TINA_MEETING_VOICE=1 python3 deploy/tts/run.py -- make all
```

The runner supplies the private local TTS token; `make all` decrypts the main Compose environment
with its matching root `.env.keys`. Stack automatically adds the `livekit` and `speech` profiles.
It creates separate LiveKit API keys with a domain-separated HMAC of the decrypted internal secret;
the original secret is not forwarded to LiveKit. Both services stay on the private Docker network.
There is no new public port, Cloud account or model download.

Start a new Google Meet bot so it has the bridge-capable image. In Terminal, open **Settings → Voice
assistant → Room answers**, choose the active meeting, set **Voice runtime → LiveKit Agents · local
pilot**, then save. Saving stops the old voice turn. Keep transcript/documents/general/web permissions
as desired: selecting the runtime grants no additional sources. Choose **TINA** and save to switch
back. A deployment without the pilot URL refuses this choice. Old bot images cannot claim pilot
readiness. Only one active pilot meeting is supported; other meetings retain native TINA by default.
The pilot does not change ASR model selection, audio windows or canonical transcript writes.

The bot owns KWS/VAD endpointing, wake/follow-up speaker ownership and explicit interruption commands.
Agents runs the LLM/TTS model adapters and generation/playout task cancellation. The TINA answer API
still owns retrieval tools, source verification, model selection and played-prefix history. HTTP PCM
delivery is not proof that anyone heard it; only existing bot microphone receipts establish that.
Automatic Agents voice turn detection/barge-in and SDK-native multi-tool planning are not enabled.

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

The fixed, prewarmed “Dạ, em nghe.” acknowledgment goes directly to the shared local TTS endpoint,
so it cannot queue behind the same AgentSession's pending LLM call. Generated answer sentences use
the Agents TTS adapter. Both paths retain the bot's microphone/Stop and played-prefix receipts.

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

Meeting API permission/session failures remain distinct from service outages: 401/403/404 deny
access, 409 invalidates the room session/policy, and other non-200 service responses return 503.
A transient service outage does not make the reaper revoke a busy or recently used room. New requests
still require a successful policy check; retaining a room grants no additional source access. The
existing idle cleanup remains bounded, and a later explicit revocation still closes the session.
