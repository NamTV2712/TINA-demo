# deploy/compose — the v0.12 control-plane stack (P4)

`docker-compose.yml` brings up the v0.12 control plane: the infra (`postgres:17-alpine`,
`valkey/valkey:8-alpine`, `storage` (versitygw) + `storage-init`) and the long-running services below, each building its own
slim image from `<service>/Dockerfile`:

| service      | build context                          | host port | entrypoint                         |
|--------------|----------------------------------------|-----------|------------------------------------|
| admin-api    | `core/identity/services/admin-api`     | 18057     | `python -m admin_api`              |
| runtime      | `core/runtime`                         | 18090     | `python -m runtime_kernel`         |
| meeting-api  | `core/meetings/services/meeting-api`   | 18080     | `python -m meeting_api`            |
| agent-api    | `core/agent/services/agent-api`        | 18100     | `uvicorn control_plane.api`        |
| gateway      | `core/gateway/services/gateway`        | 18056     | `python -m gateway`                |
| terminal     | `clients/terminal`                     | 13000     | Next.js custom server              |
| mcp          | `core/meetings/services/mcp`           | 18010     | the MCP transport                  |
| flows-api    | repo root, `core/flows/Dockerfile`     | 18200     | `python -m flows_integrations.flows_api` |
| flows-mailbox| repo root, `core/flows/Dockerfile`     | —         | `python -m flows_integrations.mailbox` (profile `mailbox`) |
| discord-connector | repo root, `core/meetings/services/discord/Dockerfile` | 18101 | `node dist/index.js` (profile `discord`) |

### flows, and what it replaces

`flows-api` is the reaction engine's HTTP surface and one of the domains the MCP assembly asks for
a tool manifest (PRD decision 40): `mcp` fetches `/.well-known/mcp-tools.json` from it, so a stack
that runs flows serves flows' tools on the one MCP surface, and one that does not simply serves
fewer. Before this service existed the engine ran as HOST processes beside the stack and `mcp` was
pointed at the docker BRIDGE ADDRESS of that host lane — a host-specific IP written into a
deployment, for a service the deployment did not run. `FLOWS_API_URL` now defaults to
`http://flows-api:8200`; set it to point at a flows elsewhere, or set it EMPTY to run a deployment
that genuinely does not carry the domain.

An existing deployment that reaches flows through such a bridge keeps working: its
`TINA_FLOWS_API_URL` override still wins over the new default, so the host lane and any listener
in front of it retire on the operator's own schedule, after the stack is cut over — not on the day
this merges.

`flows-mailbox` is the inbound mail lane (IMAP poll → `POST /events`), the same image under a
different command and with the same environment. It is behind the `mailbox` COMPOSE PROFILE and
therefore off by default, because mail is an optional intake: a lane started without real IMAP
credentials restart-loops and reads as a broken stack. Turn it on with `--profile mailbox` (or
`COMPOSE_PROFILES=mailbox`) once `TINA_MAIL_ADDR` and `TINA_MAIL_APP_PASSWORD` are set. Do not
scale it — the IMAP cursor is single-writer by design.

Two things flows will refuse, and both are deliberate: it will not start without
`TINA_FLOWS_API_KEY`, `TINA_FLOWS_ADMIN_KEY` and `INTERNAL_API_SECRET` (a weak default makes an
unconfigured deployment look configured), and it will refuse to compose a mailed link when
`TINA_UI_URL` is unset — at the link, not at boot, because a deployment may legitimately have no
terminal. Every key it reads is declared in `core/flows/src/config.v1.json` and checked against
this file by `gate:config-contract`.

`discord-connector` is the Discord voice bot and it is behind the `discord` profile for two
reasons: it refuses to boot without `DISCORD_BOT_TOKEN` (a stock stack would restart-loop), and it
must run as exactly **one** replica — one bot token holds one Discord Gateway session, and a
second process with the same token evicts the first mid-meeting. Enable it with a token and
`docker compose --profile discord up -d --build`; the bot needs the privileged **Server Members
Intent** plus View Channels / Connect / Speak, and `DISCORD_GUILD_ALLOWLIST` is recommended unless
the bot is single-tenant. meeting-api reaches it through `DISCORD_CONNECTOR_URL` (compose defaults
it to the service; an explicitly empty value disables Discord, and a spawn without the profile
fails at the connect with a 502 — enable the profile). See
[`core/meetings/services/discord/README.md`](../../core/meetings/services/discord/README.md).

The Runtime spawns the source-built bot and agent-worker images on demand; they are not
long-running Compose services. Readiness distinguishes healthy services, running workers without
healthchecks, and completed initialization jobs.

## Usage

The same operations are available as `tina` CLI/TUI after `make cli-install` from the repo root.
See [CLI commands, output and safety semantics](bin/README.md#local-tina-cli--tui).
New local users can run `tina setup` for prerequisite/conflict checks, a private fresh configuration,
source build/start and optional ASR configuration. See [first installation](bin/README.md#first-installation-cli-040).
Existing installations keep using `plan`/`deploy`; setup never replaces their env files or data.

Prerequisites: Python 3, make, Docker engine >=26 and Docker Compose with `up --wait` support.
When the selected env file is Dotenvx-encrypted, `make`/the TINA CLI also require the Dotenvx CLI and
the matching private key in `.env.keys` (kept outside Git). Stack commands decrypt into a mode-0600
temporary env file for Compose; generated credentials in a tracked env file are written encrypted.
Plain private `ENV_FILE`s remain supported.

To create a new local instance without the repository's private Dotenvx key, use the first-install
CLI with a private config path outside this checkout. This avoids using the tracked encrypted `.env`
or accidentally targeting an existing Compose project:

```bash
mkdir -p "$HOME/.config/tina"
make cli-install
export PATH="$HOME/.local/bin:$PATH"
export ENV_FILE="$HOME/.config/tina/.env"
tina setup --dry-run
tina setup
```

```bash
make plan        # read-only: selected project, files, services, volumes and image references
make all         # seed secrets, build bot/services/worker, pull infra, start, wait, provision access
make doctor      # read-only: required images and readiness of every selected service
make ps
make logs
make down        # same selected project; preserve volumes
```

`make all`/`build`/`bot` default to source image tag `dev`; `IMAGE_TAG=...` in the shell or Make
command line overrides it. Direct Compose commands and read-only status commands retain the `.env`
image tag. Every required service/worker image must finish before activation. `up --no-build
--pull never --wait` then waits up to `WAIT_TIMEOUT` seconds (default 180), and key provisioning
must succeed before the entrypoint reports success. Provisioning creates a new scoped key on each
successful invocation. This verifies control-plane readiness, not ASR accuracy or meeting acceptance.

Project selection follows explicit `PROJECT` (or legacy `COMPOSE_PROJECT`), then Compose's normal
`COMPOSE_PROJECT_NAME` environment/dotenv precedence. The resolved name is also used for Runtime's
network and Agent's workspace volume. A custom env file selects both interpolation and service
`env_file` values; paths passed through Make are relative to `deploy/compose` unless absolute:

```bash
make plan ENV_FILE=/absolute/path/to/instance.env
make plan PROJECT=another-instance
```

Docker context is pinned for each run, together with the built-in Buildx builder for that context.
Optionally persist DOCKER_CONTEXT in the env file to bind the deployment to its data daemon; an
explicit shell DOCKER_CONTEXT/DOCKER_HOST wins. The global Docker context is never switched.
A different BUILDX_BUILDER is refused for local source builds so images cannot be exported to another daemon.

Persist optional profiles and override paths in that env file, or pass them in the environment:

```dotenv
COMPOSE_PROFILES=dashboard
COMPOSE_FILE=docker-compose.yml:/absolute/path/to/machine-override.yml
```

Compose's `COMPOSE_PATH_SEPARATOR` is supported. Preserve the deployment's actual chain/order of
files. Changes to that chain or omission of an already-running profile service stop before build or
container changes; `ALLOW_CONFIG_CHANGE=1` allows an intentional change. `make all` builds source into
the selected image references, so do not include a snapshot/release-image overlay when you intend
to preserve those images. Use a source-build configuration explicitly for a source upgrade.

A fresh `.env` receives a random admin/signing token and internal secrets with owner-only file
permissions. Existing non-empty valid values are preserved. Published admin placeholders are
refused without rotating them: changing an existing signing secret requires a deliberate migration.
`make -n all` only prints recipes; `make plan` resolves the configuration without mutation or secrets.

Desktop/Capture, the extension and host ASR/alignment/diarization workers remain separate. Use the
[Desktop launcher](bin/README.md), [native Capture instructions](../../clients/desktop-native/README.md)
and the chosen backend under `deploy/transcription`. Saving a backend in Settings does not start
its server. The entrypoint does not infer missing user credentials from an empty deployment `.env`;
verify user/global STT and model/subscription choices in Settings → Models.

`make -C deploy/compose down` removes containers and keeps data volumes. To deliberately delete
the database, recordings, Redis data and agent workspaces, use
`make -C deploy/compose destroy DESTROY=yes`. `make -C deploy/compose help` lists both commands.

Storage readiness checks the same endpoint as meeting-api (`S3_ENDPOINT`, else `MINIO_ENDPOINT`
with `MINIO_SECURE`), creates the bucket if absent, and verifies a PUT/GET/DELETE probe outside
`recordings/`. Any failure prevents meeting-api from starting. After a MinIO upgrade, old
recordings stay in the old volume and do not play back from the new storage until copied with
`make -C deploy/compose migrate-storage`. Update `.env`'s old endpoint to `storage:9000` as shown
in the [upgrade guide](../../docs/docs/upgrade-from-minio.mdx).

`.env.example` documents every variable (faithful to the 0.11 `deploy/compose` names: `DB_*`,
`REDIS_URL`, `ADMIN_TOKEN`, `INTERNAL_API_SECRET`, `MINIO_*`, `BROWSER_IMAGE`/`AGENT_IMAGE`,
`DOCKER_GID`, `*_HOST_PORT`).

## Smoke probe — "is this install actually working?"

### Existing OrbStack production instance

The migrated local instance selects `DOCKER_CONTEXT=orbstack`, project `tina-production`, and
`docker-compose.orbstack.yml` in its private `.env`. Its five imported data volumes are external;
keep them when rebuilding or stopping the stack. The overlay requires those volumes to exist and
is not a fresh-install preset. It preserves the source assembly with Flows/MCP off unless profile
`automation` is selected. [Migration evidence and operational limits](../../docs/research/orbstack-cutover-20261030.md).

`make doctor` checks this selected instance. Desktop/Capture and native ASR workers remain on macOS.

```bash
make probe                       # from the repo root (compose is the default surface)
```

Drives the ONE full journey through the gateway front door — spawn → schedule → boot → join →
transcribe → live-view → stop — then sweeps every component's logs once. Each stage prints
Expected / Actual / Verdict; a red stage names where the journey broke and fails the command.
With the mock bot as `BROWSER_IMAGE` (`mock-bot:dev`) the journey is a deterministic green,
transcript included; with the real bot it drives a dead synthetic meeting to a truthful named
`join_failure`. See `deploy/compose/probe.sh` (a wrapper over `scripts/probe/journey.sh`).
