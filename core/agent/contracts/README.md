# contracts — published by `agent`

Language-neutral contracts this domain owns (JSON Schema, read by path). Consumers reference these by
path; `gate:schema` validates goldens ≡ schema (P8). `contracts.seal.json` is the source of truth for
frozen schemas; unsealed contracts remain in development.

The set is the vocabulary of the **one Dispatcher** (agent-api): an external trigger becomes a `unit.v1`
Invocation, which runs a governed `claude` turn over a mounted `workspace.v1`, optionally producing tasks,
proactive cards, and tool calls.

| Contract | What it governs | Sealed |
|---|---|---|
| **`unit.v1`** | the universal invocation envelope — `{ identity, runner, workspaces, trigger, start }`; trigger ∈ message · scheduled · event · transcription. Everything funnels through this. | yes |
| **`workspace.v1`** | the user-workspace template + EntityFrontmatter convention (the git knowledge graph the agent reads/writes). | yes |
| **`routine.v1`** | a trigger → plan routine; compiles to `runtime/contracts/schedule.v1` (the cron loop). | yes |
| **`task.v1`** | a task's state + its representation as a workspace entity. | yes |
| **`tool.v1`** | a tool/integration grant — `{ scope, grant, cred_ref, transport, barriers }`; resolved to the selected runner's allowed tools + MCP policy. | yes |
| **`tool-approval.v1`** | an owner-scoped, per-call approval request/decision for gated MCP tools. | yes |
| **`event.v1`** | an external event (e.g. email, meeting) mapped into a `unit.v1` Invocation — generic event ingress. | yes |
| **`proactive-card.v1`** | a proactive output card with actions (agent-initiated surface). | yes |
| **`invoke.v1`** | the legacy meetings→agent invocation seam. **Sealed**; retiring as callers move to `unit.v1`. | **yes** |

Note: `schedule.v1` (the Scheduler job spec routines compile to) is owned by `runtime`, not `agent` —
see `core/runtime/contracts/schedule.v1/`.
