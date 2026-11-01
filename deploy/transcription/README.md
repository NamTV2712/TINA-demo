# deploy/transcription — the STT service, deployed separately

The transcription service ([`core/meetings/services/transcription`](../../core/meetings/services/transcription))
is the **GPU workload, carved out** of the main stack. It is **not** part of `make all`: the main
`deploy/compose` stack runs CPU-only anywhere, and reaches transcription over the network via
`TRANSCRIPTION_SERVICE_URL`. Stand this unit up wherever a GPU lives (the same host or a dedicated
GPU box).

## Why separate

GPU inference is expensive, stateful, and hardware-specific. Forcing it into `make all` would make
the quickstart require an NVIDIA GPU. Keeping it as its own deploy unit lets the core stack run
everywhere, and lets the GPU tier scale (add workers) and relocate independently.

## Run

```bash
# With the committed encrypted env:
dotenvx run --overload -f .env -fk ../../.env.keys -- docker compose up -d
dotenvx run --overload -f .env -fk ../../.env.keys -- docker compose logs -f
# Or make a private, ignored local config from the template:
cp .env.example .env.local    # set MODEL_SIZE, API_TOKEN, TRANSCRIPTION_LB_PORT
docker compose --env-file .env.local up -d
docker compose --env-file .env.local logs -f
# CPU-only variant:
docker compose --env-file .env.local -f docker-compose.cpu.yml up -d

curl http://127.0.0.1:8083/health
```

The checked-in `.env` is Dotenvx-encrypted; `.env.keys` stays private at the repository root. The
host `start.sh` scripts detect encrypted env files and load them through Dotenvx automatically.

The CPU profile publishes its nginx LB on loopback port `8083` (`TRANSCRIPTION_LB_PORT`); TINA
reaches it over the main Compose network, not through the host port. Start the main TINA stack first
and set `TINA_MAIN_NETWORK` in this unit's `.env` to `<main-project>_tina` (the default project is
`tina-v012_tina`). The GPU profile keeps its host port available for remote TINA deployments. The
LB least-conn balances across workers. Ships with one worker — scale out by uncommenting
`transcription-worker-2/3` in `docker-compose.yml` **and** `nginx.conf` (one GPU each).

## Point the main stack at it

In the main stack's `deploy/compose/.env`, set the **base URL** (the bot's whisper client appends
`/v1/audio/transcriptions`):

| Topology | `TRANSCRIPTION_SERVICE_URL` |
|---|---|
| Dedicated GPU host | `http://<gpu-host>:8083` |
| Local CPU profile on the same Docker host, with `TINA_MAIN_NETWORK` set | `http://transcription-api` |

If `API_TOKEN` is set here, set the **same** value as `TRANSCRIPTION_SERVICE_TOKEN` in the main
stack's `.env`. Then bots transcribe end-to-end: bot → this service → segments → meeting-api
`collector` → `transcription_segments` → live fan-out.

To expose this as the selectable **NVIDIA GPU (CUDA)** backend, set `API_TOKEN` and configure the
same URL/token under **Settings → Models → Global transcription backend → NVIDIA GPU**. The endpoint
and credential are admin-owned; users only choose the backend name.

**This unit ignores the request's `model` form part** (OpenAI-compat: the field is required, the
server decides): the model that actually runs is this unit's own `MODEL_SIZE`. So the main stack's
`TRANSCRIPTION_MODEL` has no effect here — it exists for backends that *validate* the model id
(Groq, vLLM, OpenAI-compatible gateways); leave it empty when pointing at this unit and pick the
model with `MODEL_SIZE` instead.

Downloaded model weights live in the `transcription-models` **named volume** (not the working
tree), persisted across restarts. Wipe with `docker volume rm transcription_transcription-models`.

## Apple Silicon option

For a Mac-hosted Apple GPU backend, run the native MLX/Metal service described in
[`apple/README.md`](apple/README.md). It exposes the same `/v1/audio/transcriptions` contract; do not
try to pass MPS through the Linux CUDA container.

For the local Qwen3-ASR-0.6B FunASR backend, follow [`funasr/README.md`](funasr/README.md). It runs
natively on the Mac and stays bound to `127.0.0.1`; Docker Terminal and meeting containers use
`http://host.docker.internal:18000` through Docker Desktop's host gateway.

After the FunASR, Apple and/or NVIDIA endpoints are running, an admin saves their URL and token under
**Settings → Models → Global transcription backend**. Users then choose the configured backend under
**Your transcription backend**. The existing deployment endpoint remains the default.
