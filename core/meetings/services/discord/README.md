# discord — the Discord voice connector (Node/TS)

## Purpose

Joins a Discord **voice channel** on behalf of TINA, transcribes each participant separately, and
reports the meeting's lifecycle through the same contracts every other platform uses. It is *not* a
per-meeting container and it is not a browser bot: it holds one Discord Gateway session and speaks
the voice protocol (UDP + Opus + DAVE) directly.

The connector exists because of a Discord constraint: **one bot token may hold exactly one Gateway
session.** Two processes with the same token evict each other, so "one container per meeting" would
drop every live meeting the moment a second one started. Instead the process is long-lived and its
per-meeting work is an in-process *workload* — and it exposes the `runtime.v1` workload surface, so
meeting-api spawns and tears down Discord sessions through the very same port it uses for Docker.

```
POST /bots (platform=discord)
  └─ meeting-api bot_spawn ── runtime.v1 WorkloadSpec(profile="discord-bot") ──► connector
                                                                               │
   lifecycle.v1  ◄── HTTP callback ────────────────────────────────────────────┤
   transcript.v1 ◄── redis XADD transcription_segments ────────────────────────┤
   acts.v1       ──► redis PUBLISH bot_commands:meeting:{id} {"action":"leave"}┘
```

## Seams

| Direction | Neighbour | Via | What crosses |
|---|---|---|---|
| consumes | meeting-api (spawner) | `POST /workloads` (`runtime.v1`) | `WorkloadSpec` whose `env.TINA_BOT_CONFIG` is an `invocation.v1` document |
| served-over | meeting-api (reconciler) | `GET /workloads/{id}`, `DELETE /workloads/{id}` | `WorkloadStatus`; delete is confirmed (left + flushed + terminal event emitted) |
| joins | Discord | Gateway (discord.js) + voice UDP | voice channel `<guildId>:<channelId>` |
| consumes | gateway (commands) | redis pub/sub `bot_commands:meeting:{id}` | `acts.v1` — `leave` only in this increment |
| publishes | collector [Py] | redis stream `transcription_segments` | `transcript.v1` durable segments (`meeting_id` numeric, `session_uid` = invocation `connectionId`) |
| publishes | gateway → UI | redis pub/sub `tc:meeting:{id}:mutable` | live `transcript.v1` segments (partial then completed) |
| produces | meeting-api | HTTP POST → `inv.meetingApiCallbackUrl` | `lifecycle.v1` status events, retried, never fatal |

## Contracts

**Owns:** none — a worker that implements published meetings contracts.
**Consumes:** [`invocation.v1`](../../contracts/invocation.v1) (per-session config, `platform:
"discord"`), [`acts.v1`](../../contracts/acts.v1) (inbound `leave`), [`runtime.v1`](../../../runtime/contracts/runtime.v1)
(the workload surface it *serves*).
**Produces:** [`lifecycle.v1`](../../contracts/lifecycle.v1), [`transcript.v1`](../../contracts/transcript.v1).

All four are validated at the seam against the sealed schemas loaded **by path** (the same files
`contracts.seal.json` freezes), so a spec the Docker kernel would have rejected cannot start a
Discord session either.

## Lifecycle mapping

| Situation | Emitted |
|---|---|
| join accepted, bot in channel | `active` |
| stop / `leave` act / `DELETE /workloads` | `completed`, reason `stopped` |
| nobody ever joined (10 min) | `completed`, reason `startup_alone` |
| everyone else left (2 min) | `completed`, reason `left_alone` |
| `maxLifetimeSec` reached | `completed`, reason `max_bot_time_exceeded` |
| join rejected/failed, or voice socket lost mid-meeting | `failed`, `failure_stage: joining` / `active`, reason `join_failure` |
| stop arrived while the join was still in flight | `failed`, `failure_stage: joining`, reason `stopped` |

Terminal is emitted **exactly once**. `joining → completed` is not a legal edge in `lifecycle.v1`,
so a stop during join reports `failed/stopped` rather than counting a meeting that was never served.

## Transcript lane

Discord's topology is the friendliest TINA has: **one Opus stream per user**. That is exactly the
gmeet lane's premise — a channel per participant with the name bound at capture — so the connector
reuses `@tina/gmeet-pipeline` (and `@tina/transcribe-whisper` for STT) unchanged. There is no
diarization, no mixed-lane namer, and no ONNX model in this image.

- **Decode:** each user's Opus packets → `opusscript` (pure JS) → 48 kHz stereo → 16 kHz mono PCM.
- **Timestamps:** a synthetic monotonic per-user cursor advances by decoded duration and re-anchors
  to `Date.now()` after a ≥1 s packet gap, so a wall-clock clock jump cannot reorder a transcript.
- **Channel pool:** a fixed pool of 16 indices (the lane's `AudioTimelinePool` budget). A speaker
  takes a free slot, or evicts the least-recently-heard one. A slot is a *lane*, never an identity:
  the display name + user id ride every frame, so a takeover is a turn rotation and can never
  relabel one person's words as another's.
- **Names:** from the Guild member roster (display name, falling back to the user name). This is why
  the **Server Members Intent is privileged and required** — without it the connector refuses to
  log in rather than label every speaker with a raw snowflake.

## DAVE (voice end-to-end encryption)

Discord has required DAVE (the DAVE protocol, via `@snazzah/davey`) for voice since 2026-03-01.
`@discordjs/voice` 0.19.2 carries it transitively; the connector passes `daveEncryption: true`
explicitly and uses `selfDeaf: false` (a deafened client receives no audio). A build that somehow
lacks `davey` fails the join and reports `join_failure` — it does not silently record silence.

## Configuration

### Per session (`invocation.v1`, shipped by meeting-api as `TINA_BOT_CONFIG`)

The connector reads only published fields: `platform` (`discord`), `meetingUrl` /
`nativeMeetingId` (`<guildId>:<channelId>`), `meetingId`, `connectionId`, `meetingApiCallbackUrl`,
`redisUrl`, `transcribeEnabled`, `transcriptionServiceUrl` / `transcriptionServiceToken` /
`transcriptionModel`, `language`, and the bot's display name. The two spellings of the address must
agree: a `meetingUrl` that parses to a different guild/channel than `nativeMeetingId` is a contract
error, refused before any Gateway traffic.

### Connector-level (process env, read once at boot)

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — (required) | bot token; the connector refuses to boot without it |
| `DISCORD_GUILD_ALLOWLIST` | empty | comma-separated guild snowflakes allowed to receive the bot. **Empty means every guild the bot is in** — fine single-tenant, wrong for a shared bot |
| `DISCORD_CONNECTOR_HOST` | `0.0.0.0` | bind address of the runtime.v1 surface |
| `DISCORD_CONNECTOR_PORT` | `8091` | bind port |
| `DISCORD_MAX_SESSIONS` | `4` | concurrent voice sessions; beyond it `POST /workloads` returns 429 (kernel quota) |
| `DISCORD_MAX_CHANNELS` | `16` | speaker lanes per session (LRU beyond it) |
| `DISCORD_WORKLOAD_RETENTION_MS` | `600000` | how long a stopped workload stays queryable by id |
| `DISCORD_DISCONNECT_GRACE_MS` | `30000` | how long a lost voice socket is retried before `failed/join_failure` |
| `DISCORD_LANE_STOP_TIMEOUT_MS` | `20000` | bound on flushing the lane during teardown |

There is no connector-level redis or meeting-api URL: both arrive **per session** in the invocation,
so one connector can serve several deployments' meetings without sharing their credentials.

## Running it

Compose (opt-in profile — a stock stack must not restart-loop on an empty token):

```sh
# deploy/compose/.env
DISCORD_BOT_TOKEN=…            # https://discord.com/developers/applications → Bot
DISCORD_GUILD_ALLOWLIST=…      # recommended
docker compose --profile discord up -d --build
```

Helm: `discordConnector.enabled=true` plus `botToken` (or `existingSecret`). The template **fails
the render** on `replicaCount != 1`, and uses `strategy: Recreate` — a RollingUpdate would run two
Gateway sessions with one token and evict the live one.

Operator checklist before the first join:

1. Bot → **Privileged Gateway Intents → Server Members Intent** = ON (display names).
2. Installation → Guild Install, scopes `bot`; permissions **View Channels**, **Connect**, **Speak**.
3. Invite it to each server whose voice channels it may join (and list those guilds in
   `DISCORD_GUILD_ALLOWLIST` if the bot is shared).
4. `DISCORD_CONNECTOR_URL` on meeting-api must point at the connector. Compose defaults it to the
   service URL; Helm renders an explicitly empty value when the connector is off, which *disables*
   the Discord branch (a spawn is then a typed 422, not a 502 at an absent host).

## Consent and terms

Joining is **visible**: every member of the voice channel sees the bot in the member list, and the
connector posts no messages. Transcribing a voice channel is still processing people's speech —
operators are responsible for telling participants what the bot does and for having a lawful basis,
and for complying with Discord's Developer Terms/Policy and any recording-consent law that applies
(all-party consent jurisdictions included). There is no covert mode and none will be added.

## Status

- ✅ delivered — runtime.v1 workload surface (`POST`/`GET`/`DELETE /workloads`, `/healthz`), idempotent create, confirmed delete, 429 quota
- ✅ delivered — join/leave lifecycle with alone timers, stop-during-join, voice-loss handling, lifetime cap
- ✅ delivered — per-user Opus decode → gmeet lane → `transcript.v1` durable + live feeds
- ✅ delivered — `acts.v1` `leave` (dashboard "remove bot" works unchanged)
- ✅ delivered — Compose profile + Helm chart surface, single-replica guard, guild allowlist
- ✅ verified — offline suites, `tsc`, the image build, sealed-schema load by path in the final
  image, DAVE native addon load in the final image, and the meeting-api/terminal contract tests
- ⚠️ not yet verified against a live Discord server — the Gateway login, a real voice join, and
  DAVE re-keying have not been exercised here (needs a bot token and a guild)
- ⛔ deferred — recording (no audio archive/upload): an explicit `recording_enabled: true` on `POST /bots` is a 422, and an inherited calendar/auto-join recording policy is downgraded to transcript-only
- ⛔ deferred — speaking/TTS, chat, screen share, avatar (`acts.v1` verbs beyond `leave`)
- ⛔ deferred — OAuth channel picker and Discord-specific docs pages

## Tests

`pnpm test` — offline `tsx` suites, no Gateway and no Whisper server: config/contract validation,
the session state machine (join, alone timers, voice loss, stop races, exactly-once terminal), the
runtime.v1 HTTP surface (status codes, idempotency, retention, 429), the transcript egress mapping,
the per-user audio cursor/resampler, `acts.v1` ingress, and the session registry. `pnpm build` is
`tsc`; `npx tsc --noEmit` is clean.

## Known production risks

- **DAVE transition packets.** `@discordjs/voice` handles the epoch transitions, but this is the
  least-exercised path in the stack; a mid-call re-key is the first thing to watch in a real meeting.
- **Undocumented receive behaviour.** Per-user receive is supported by the library but is not a
  documented Discord API guarantee; a protocol change can break it without notice.
- **Single replica by construction.** One token = one Gateway session. Horizontal scale means a
  second bot application and a second connector, not `--replicas 2`.
- **Recording is not implemented**, so a Discord meeting has a transcript but no audio artifact.
