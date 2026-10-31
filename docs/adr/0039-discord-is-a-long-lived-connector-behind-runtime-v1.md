# ADR 0039 — Discord is a long-lived platform connector behind the runtime.v1 workload surface

**Status:** accepted · 2026-10-27

## Context

TINA joins Google Meet, Zoom, Teams and Jitsi through an ephemeral per-meeting bot container: the
runtime kernel starts a browser worker, which joins the call, streams audio to STT, and dies. That
model assumes the platform can be driven by a browser page and that N meetings = N independent
processes. Discord breaks both assumptions:

- **No browser path.** A Discord voice channel is not a web page a bot can "join" headlessly; the
  bot must speak the Gateway (websocket) and voice (UDP/RTP, Opus) protocols.
- **One Gateway session per token.** Discord allows exactly one live Gateway connection per bot
  token; opening a second evicts the first. Two per-meeting containers sharing a token would
  disconnect each other mid-meeting — the failure lands on the *older* meeting, which is the hardest
  kind to attribute.
- **Voice is end-to-end encrypted.** DAVE has been mandatory since 2026-03-01, so the media path
  needs a library that implements it (`@discordjs/voice` 0.19.2 with `@snazzah/davey`), not a
  capture hack.
- **Per-user audio is the default.** Unlike a browser tab, Discord delivers one Opus stream per
  speaker. That is a *better* fit for TINA's existing channel-per-participant transcript lane than
  the mixed-audio diarization path.

The control plane also has a contract to keep: `POST /bots` must keep spawning, `DELETE
/bots/{platform}/{native}` must keep stopping, and `lifecycle.v1` / `transcript.v1` must keep being
the only observable outputs. A second, Discord-only control path would double the state machine the
gateway, dashboard and reconciler already depend on.

## Decision

1. **Discord is served by one long-lived connector process**, not by a per-meeting container:
   `core/meetings/services/discord`. It holds the single Gateway session for the deployment's bot
   token and runs each meeting as an in-process `DiscordVoiceSession`.
2. **The connector implements the published `runtime.v1` workload surface** — `POST /workloads`,
   `GET /workloads/{id}`, `DELETE /workloads/{id}`, plus `/healthz`. meeting-api does not know it is
   talking to a process instead of Docker: its existing `HttpRuntimeClient` creates a workload with
   `profile: "discord-bot"` and `env.TINA_BOT_CONFIG` (an `invocation.v1` document), exactly as it
   does for a bot container.
3. **Dispatch is a composite, keyed on the workload profile** (`bot_spawn/adapters.py`):
   `discord-bot` → connector, everything else → the container kernel. Stop/get route by the `dc-`
   workload-id prefix. The existing `request_bot`/stop paths are unchanged.
4. **The workload surface keeps the kernel's semantics**, deliberately: create is idempotent by
   `workloadId` and returns 201 with `state: "running"` because the join is asynchronous (a join
   failure is reported on `lifecycle.v1`, like a pod that starts and then fails); delete is
   *confirmed* (only resolves after leave, lane flush and the terminal lifecycle event); an unknown
   id is 404; capacity exhaustion is 429, which meeting-api already maps to quota.
5. **`replicaCount` is pinned to 1** on every surface. Compose puts the connector behind a
   `--profile discord` (an empty token must not restart-loop a stock stack). Helm defaults the
   connector to `enabled: false`, fails the render on `replicaCount != 1`, and forces `strategy:
   Recreate` — RollingUpdate would briefly run two Gateway sessions with one token.
6. **The transcript lane is the existing gmeet lane, unchanged.** Per-user Opus → `opusscript`
   decode → 48 kHz/16 kHz resample → `@tina/gmeet-pipeline` → `transcript.v1` on the same redis
   stream and live pub/sub channel. No diarization, no ONNX, no second transcript shape.
7. **Stop honours the existing act contract.** The connector subscribes to
   `bot_commands:meeting:{id}` and acts on `{"action":"leave"}` (`acts.v1`), so the dashboard's
   "remove bot" works without a Discord-specific endpoint. `DELETE /workloads/{id}` remains the
   reconciler's confirmed path.
8. **Recording is explicitly out of scope for this increment.** An explicit `recording_enabled:
   true` on `POST /bots` is a 422; an inherited calendar/auto-join recording policy is silently
   downgraded to a transcript-only join, because refusing the join would be worse than the missing
   artifact.

## Alternatives considered

- **A per-meeting container holding the bot token.** Rejected: the second meeting evicts the first
  (one Gateway session per token). A per-meeting *token pool* shifts the problem to an operator
  provisioning N bot applications and a scheduler that leases them — a much larger surface for the
  same transcript.
- **Reuse `@tina/join` / Playwright.** Rejected: there is no browser surface to drive; Discord's
  client is not joinable this way, and the media is not on a page.
- **A Discord-specific route in meeting-api (`POST /discord/bots`) and a second control path.**
  Rejected: it duplicates spawn/stop state and forces every consumer (gateway, dashboard,
  reconciler, tests) to learn a second protocol. The runtime surface already has exactly the four
  operations a session needs.
- **One connector replica per bot token, but allowing `replicas > 1` "for availability".** Rejected
  as a foot-gun: replicas of the same token do not add availability, they remove it. Availability
  comes from a fast Recreate and from sessions being resumable by a subsequent spawn.

## Consequences

- **Deployment is opt-in and token-scoped.** Without `DISCORD_BOT_TOKEN` the connector cannot boot;
  without `DISCORD_CONNECTOR_URL` meeting-api disables the Discord branch entirely (typed 422, not a
  502 at an absent host).
- **Privileged intent is a hard prerequisite.** Display names require the **Server Members Intent**;
  the connector fails login rather than labelling speakers with raw snowflakes.
- **Scaling is by bot application, not by pod.** A second Discord surface means a second bot token
  and a second connector; the dispatch key would need a per-token selector at that point.
- **A connector crash drops every live meeting** on that token. Each session's terminal event is
  lost with it, so the reconciler must treat "workload gone" as a failure, not a completion.
- **Consent is an operator obligation.** The bot is visible in the member list; operators must
  inform participants and comply with Discord's terms and applicable recording law. The connector
  ships no covert mode.
- **DAVE and per-user receive are the two least-exercised production paths** in the stack and the
  first suspects if a real meeting produces silence or a truncated transcript.

## References

- Connector: [`core/meetings/services/discord/README.md`](../../core/meetings/services/discord/README.md)
- Dispatch: `core/meetings/services/meeting-api/src/meeting_api/bot_spawn/adapters.py` (`CompositeRuntimeClient`)
- Link parsing: `core/meetings/services/meeting-api/src/meeting_api/collector/meeting_link.py`
- Contract: [`runtime.v1`](../../core/runtime/contracts/runtime.v1), [`invocation.v1`](../../core/meetings/contracts/invocation.v1)
