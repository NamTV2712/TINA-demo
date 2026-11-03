# llm — the detached LLM + agent-harness module

Everything tina knows about model providers and coding-agent CLIs lives HERE, behind two
provider-agnostic ports. Product code (the meeting copilot, chat, routines) imports only the
front door (`llm/__init__.py`) and never names a vendor.

## The two ports (two call shapes)

| Port | Call shape | Used by | Selected by |
|---|---|---|---|
| `CompletionPort` | plain prompt→text call — no tools or workspace | meeting card beats, summaries/Q&A, final dictation polish | `TINA_LLM_PROVIDER` |
| `HarnessPort` | a CLI coding agent over the mounted workspace — tool loop, sessions, streamed UnitEvents | chat, workspace actions, routines | `TINA_RUNNER` |

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
  a workspace-write, network-disabled sandbox; OpenAI or Groq Responses endpoints) · `antigravity.py` (the `agy` CLI — headless
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
| `TINA_CODEX_AUTH_MODE` | Codex credentials: `api-key` \| `chatgpt-plan` \| `groq` | `api-key` |
| `TINA_ANTIGRAVITY_AUTH_MODE` | Antigravity CLI credentials: `gemini-api` \| `oauth` | auto from `GEMINI_API_KEY` |
| `TINA_AGENT_EFFORT` | Codex turn reasoning effort | model default |
| `ANTHROPIC_*`, `HOST_CLAUDE_CREDENTIALS` | claude-code adapter | — |
| `OPENAI_API_KEY`, `ACCESS_TOKEN` | Codex/OpenAI provider credentials | — |
| `GEMINI_API_KEY` | Antigravity CLI Gemini API-key authentication | — |

## Provider model settings

Settings use the existing masked per-user/platform model credential field, independently
of TINA transcript API tokens. A selected provider uses that provider's key and fixed
endpoints for both chat and meeting processing; switching providers must suppress the
previous provider's credentials. Live account keys and available models are required to
verify inference beyond local protocol tests.

### Groq

**Settings → Models → Groq** selects the existing Codex harness for chat through
`https://api.groq.com/openai/v1/responses`, and `openai-compat` completions for meeting
summaries through the same base URL's `/chat/completions`. The default model is
`openai/gpt-oss-20b`; an explicit meeting model can override it for completion jobs.
The Codex sandbox and TINA MCP approval grants continue to apply. The temporary worker-local
`groq_responses.py` loopback proxy authenticates Codex requests, strips unsupported Responses
fields and non-function tools, and serializes tool calls for Groq's GPT-OSS models. It does
not execute tools or expand the harness's grants. Upstream SSE events and HTTP error statuses
retain their existing path through Codex. Groq's
[Responses API is in beta](https://console.groq.com/docs/responses-api); a live account key
and an available model are required to verify inference beyond local protocol tests.

### DeepSeek

**Settings → Models → DeepSeek** selects the existing Claude Code harness using the
provider's [Anthropic-compatible endpoint](https://api-docs.deepseek.com/guides/anthropic_api/)
at `https://api.deepseek.com/anthropic`. Meeting completion jobs use `openai-compat` at
`https://api.deepseek.com`. Both default to `deepseek-flash`; the optional meeting model
overrides the chat model for completion jobs. This is DeepSeek API-key authentication,
not a Claude subscription credential. The existing harness permissions and tool approvals
continue to govern tool execution.

### Gemini

**Settings → Models → Gemini** selects the existing `agy` harness with
`modelProvider=gemini` and Gemini API-key authentication. Meeting completion jobs use
`openai-compat` at `https://generativelanguage.googleapis.com/v1beta/openai`, following the
[Gemini compatibility API](https://ai.google.dev/gemini-api/docs/openai). Both default to
`gemini-3.8-flash`. This provider requires a Gemini API key and does not fall back to
Antigravity consumer/OAuth credentials or synthesize a Terms acknowledgment. The legacy
Antigravity selection retains its separate acknowledgment and authentication checks.

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
