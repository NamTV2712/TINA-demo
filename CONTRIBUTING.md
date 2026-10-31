# Contributing to TINA

TINA is currently maintained as a local self-hosted project. Its Git repository has no remote,
issue tracker, or public contribution channel configured yet.

## Before making a change

- Read [`AGENTS.md`](AGENTS.md) and inspect the current working tree.
- Keep changes narrow and update affected callers, configuration, fixtures, and documentation.
- Preserve Apache-2.0 and third-party attribution files.
- Do not push or publish images; no TINA destination is configured.

## Local development

- Node.js `>=22.13`, `pnpm@11.7.0`; Python services use their local `pyproject.toml`/`uv.lock`.
- `make all` builds the self-hosted Compose stack from this checkout.
- `make lite` builds the TINA Lite image locally.
- Configure model credentials and a private OpenAI-compatible STT endpoint in `.env`.

## Contribution rights

Contributors must have permission to submit their changes under Apache-2.0. See
[`CONTRIBUTOR_RIGHTS.md`](CONTRIBUTOR_RIGHTS.md) for the local rights paths. This checkout has no
remote or DCO app configured; do not push or publish until the owner sets them up. Never add
sign-offs on another person's behalf or rewrite shared Git history.
