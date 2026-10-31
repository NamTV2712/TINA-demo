# syntax=docker/dockerfile:1.7
# ==============================================================================
# @tina/discord-connector — the Discord platform connector.
#
# ONE long-lived process holds the bot's single Gateway session and joins voice
# channels on demand (runtime.v1 `profile="discord-bot"` workloads). It has no
# browser: voices arrive as Opus over UDP and are decoded in-process
# (opusscript). No chromiums, no X11, no PulseAudio.
#
# Build context: the v0.12 repo root (pnpm-workspace.yaml lives there).
#   docker build -t tina/v012-discord-connector:dev \
#     -f core/meetings/services/discord/Dockerfile .
#
# Two stages on the SAME node base so the pnpm symlink farm built in `builder`
# stays valid in `runtime` (no install at run time).
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: builder — install only the connector's workspace slice + build it.
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1

# pnpm pinned to the workspace's packageManager via corepack.
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate && pnpm --version

WORKDIR /build

# Workspace manifests first (best layer cache for the install step).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./
# The source the connector needs: its @tina/* deps (gmeet-pipeline, transcribe-whisper) all
# live under core/meetings. The other workspace globs are green-on-empty and are not copied.
COPY core ./core

# `--filter "@tina/discord-connector..."` installs the connector AND its workspace deps only —
# deliberately NOT the browser bot's Playwright/ONNX tree, which this image never loads.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --filter "@tina/discord-connector..." --frozen-lockfile

# Build the connector and its workspace deps in topological order (each build = tsc → dist/).
RUN pnpm --filter "@tina/discord-connector..." run build

# Sanity: the entry the runtime execs must exist after the build.
RUN test -f /build/core/meetings/services/discord/dist/index.js \
    && echo "[builder] @tina/discord-connector dist/index.js present"

# NOTE: `pnpm prune --prod` is deliberately NOT used — in a workspace it prunes against the ROOT
# package (which depends on nothing), deleting the connector's own runtime deps from the store.
# The dev toolchain stays in the image; correctness of the runtime tree beats ~100 MB.

# ------------------------------------------------------------------------------
# Stage 2: runtime — same node base, only the slice the connector loads.
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# --prod was installed in the builder; nothing is installed here.
ENV NODE_ENV=production

WORKDIR /app

# Carry the pnpm node_modules tree (the `.pnpm` store + the links into it) plus ONLY the paths
# the connector resolves at run time. The workspace layout is preserved so pnpm's relative
# symlinks (package → ../../modules/*, → ../../../../../node_modules/.pnpm/*) stay valid.
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/core/meetings/modules /app/core/meetings/modules
COPY --from=builder /build/core/meetings/services/discord /app/core/meetings/services/discord
# The sealed contracts are read BY PATH from the package (no copies, no generated constants).
COPY --from=builder /build/core/meetings/contracts /app/core/meetings/contracts
COPY --from=builder /build/core/runtime/contracts /app/core/runtime/contracts

# Run from the package dir so the schema paths resolve exactly as they do in development:
# dist/ → ../../../contracts/invocation.v1 and ../../../../runtime/contracts/runtime.v1.
WORKDIR /app/core/meetings/services/discord

EXPOSE 8091

# node handles SIGTERM directly; compose's `init: true` (and k8s' tini-less TERM) forwards it,
# and main() drains voice sessions before exiting (25s watchdog).
CMD ["node", "dist/index.js"]
