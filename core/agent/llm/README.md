# llm — the detached LLM + agent-harness module

Everything tina knows about model providers and coding-agent CLIs lives HERE, behind two
provider-agnostic ports. Product code (the meeting copilot, chat, routines) imports only the
front door (`llm/__init__.py`) and never names a vendor.

## The two ports (two call shapes)

| Port | Call shape | Used by | Selected by |
|---|---|---|---|
| `CompletionPort` | plain prompt→text call — no tools or workspace | meeting card beats, final dictation polish | `TINA_LLM_PROVIDER` |
| `HarnessPort` | a CLI coding agent over the mounted workspace — tool loop, sessions, streamed UnitEvents | post-meeting doc, chat, routines | `TINA_RUNNER` |

Both are `typing.Protocol` (duck-typed, mirroring `core/runtime`'s `Backend` port); adapters are
selected env-driven in `registry.py` and constructor-injected everywhere, so tests use trivial
fakes.

## Adapters

- **Completions**: `openai_compat.py` (DEFAULT — OpenRouter, Ollama, vLLM, LM Studio, OpenAI-compatible
  gateways speaking `POST {base}/chat/completions`) · `openai_responses.py` (OpenAI Responses API,
  including ChatGPT plan access tokens) · `anthropic_api.py` (the Messages dialect —
  api.anthropic.com, Bedrock Messages, LiteLLM proxies, DeepSeek/GLM Anthropic-compatible endpoints) ·
  `claude_cli.py` (beats via the claude CLI on mounted SUBSCRIPTION credentials — no API key;
  slower per beat; for subscription-only deployments).
- **Harnesses**: `claude_code.py` (the `claude` CLI — argv build, stream-json parsing, `.claude/`
  continuity + skills wiring, credential preflight) · `codex.py` (Codex app-server over JSONL with
  per-turn filesystem permissions, managed shell networking and explicit web-search grants) · `antigravity.py` (the `agy` CLI — headless
  stream-json parsing, scoped TINA mount permissions, and governed workspace skills).

HTTP completion adapters use raw `httpx`; CLI harnesses use the provider's supported local process
interface so TINA can keep its existing workspace and event boundary.

## Configuration

| Env var | Meaning | Default |
|---|---|---|
| `TINA_LLM_PROVIDER` | completion adapter: `openai-compat` \| `openai-responses` \| `anthropic` \| `claude-cli` | `openai-compat` |
| `TINA_LLM_BASE_URL` | provider endpoint | anthropic: `https://api.anthropic.com`; openai-compat: **required** (falls back to `ANTHROPIC_BASE_URL`) |
| `TINA_LLM_API_KEY` | credential (optional for local runtimes) | falls back `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` |
| `TINA_LLM_MODEL` | deployment-default model (free string) | empty → fail-loud at completion call |
| `TINA_LLM_MAX_TOKENS` | Messages-API max_tokens | 4096 |
| `TINA_RUNNER` | harness adapter key: `claude-code` \| `codex` \| `antigravity` | `claude-code` |
| `TINA_CODEX_AUTH_MODE` | Codex credentials: `api-key` \| `chatgpt-plan` | `api-key` |
| `TINA_ANTIGRAVITY_AUTH_MODE` | Antigravity CLI credentials: `gemini-api` \| `oauth` | auto from `GEMINI_API_KEY` |
| `TINA_AGENT_EFFORT` | Codex turn reasoning effort | model default |
| `ANTHROPIC_*`, `HOST_CLAUDE_CREDENTIALS` | claude-code adapter | — |
| `OPENAI_API_KEY`, `ACCESS_TOKEN` | Codex/OpenAI provider credentials | — |
| `GEMINI_API_KEY` | Antigravity CLI Gemini API-key authentication | — |

## Rules

- **This module imports NOTHING from product code** (`shared/`, `contracts`, `worker/`,
  `control_plane/`) — it must stay liftable into a standalone brick.
- Vendor names appear only in adapter files (`claude_code.py`, `anthropic_api.py`), never in
  `ports.py`/`registry.py` beyond registry keys.
- UnitEvent shapes (`message-delta` / `tool-call` / `tool-result` / `done{reply,sessionId,ok}` /
  `commit` and the `model-error` / `auth-error` builders in `errors.py`) are FROZEN — the terminal
  reducer and SSE relay consume them field-for-field.
- Session ids are OPAQUE per-harness tokens; an alien/stale id must yield `done.ok=False` (the
  engine's stale-resume retry heals it).

## Adding a provider / runner

1. New adapter file implementing the port (copy the closest existing one).
2. One line in `registry.py`'s table.
3. Unit test with a fake transport (`httpx.MockTransport`) or fake `exec_fn` — see
   `tests/test_llm_openai_compat.py` / `tests/test_llm_claude_code.py`.

## Codex MCP approvals

The Codex adapter receives only MCP servers and tool names selected by the unit's resolved `tool.v1`
grant. Auto grants use Codex's `auto` mode; gate grants use `prompt`, and a mixed-grant server is
prompted for every selected tool to avoid promoting a gated sibling. The app-server's per-call
elicitation is bridged through the owner-scoped chat stream; allow/deny is one-shot and expires
fail-closed. The scoped TINA identity token is passed to selected MCP servers only through their
configured environment/bearer references and is explicitly excluded from Codex shell-tool environments.

## Codex web and command networking

Web-enabled turns request direct Markdown source links. The adapter also normalizes explicit
native web citation metadata into a final Markdown reply and records up to 50 sources per turn in
private `.codex/tina-sources/<thread>/<turn>.json`. The history reader uses the matching turn's
metadata and original opened-page URLs after reload. A missing reference mapping stays unresolved;
it is never guessed from result order. Both clients replace partial streamed text with the final
reply, preserving links. These are recorded sources, not an independent fact-verification verdict.

The adapter pins named online/offline permission profiles for each new or resumed turn. Filesystem
writes are limited to the TINA mounts carrying `write: true`; `.git`, `.codex` and `.agents` remain
read-only to tool processes. Event/transcription/unknown triggers are read-only and offline even if
a caller supplies write/web tools. The platform still commits validated changes after a normal turn.

For message/scheduled turns, `WebSearch` grants cached hosted search; `WebSearch` plus `WebFetch`
grants live search/open. With neither search grant, the hosted tool is disabled. Hosted search is a
provider-side capability, separate from command networking: the command domain allowlist does not
filter search queries/results. Never put private content or credentials in a public research query.
See [OpenAI web search](https://learn.chatgpt.com/docs/web-search) and
[network permissions](https://learn.chatgpt.com/docs/permissions).

Shell networking requires `Bash` and `WebFetch`, a writable trusted turn, and the restrictive
administrator policy installed at `/etc/codex/requirements.toml`. The worker image copies this from
`worker/codex-requirements.toml`; only the operator can change it by rebuilding the image. Its exclusive
allowlist permits the named GitHub API, Git and content hosts. Other domains, private/loopback
addresses, upstream proxies and Unix-socket forwarding are blocked. This is a domain restriction,
not an HTTP-method restriction. Provider and MCP connections have their own existing grants and are
outside this command proxy. GitHub credentials are not granted to shell tools by this change.

The managed policy deliberately leaves `enabled` unset: forcing it globally in Codex 0.149 overrides
offline turns. TINA enables the proxy feature and selects an explicit named offline/online profile;
it never combines these profiles with the legacy `sandboxPolicy`. A missing restrictive policy
keeps shell networking offline; a globally forced proxy is rejected before starting a turn.

The real CLI smoke probes in `tests/codex_network_smoke.py` and `tests/codex_web_smoke.py` verify
network/filesystem isolation and web-tool request construction without a provider account. Their
fixture responses do not establish live search availability, provider quota, or account access.
