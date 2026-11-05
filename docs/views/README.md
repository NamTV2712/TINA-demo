# docs/views — generated architecture projections

Deterministic views carved from the SSOT chart (`architecture.calm.json`). **Never hand-edit** —
regenerate with `pnpm arch:dsl --write`; `gate:dataflow` fails when any view is stale.

| File | View |
|---|---|
| `architecture.dsl` | compact text projection — the always-in-context LLM index |
| `containers.mmd` | C4-ish container view: systems, services, clients, protocols |
| `ownership.mmd` | P23 data-carrier ownership: write=solid, read=dashed, multi-writer carriers dashed-outline |
| `flow-*.mmd` | one sequence diagram per declared flow (live transcript, agent dispatch) |
| `deployment.mmd` | runtime spawn topology (runtime.v1 workloads) |
| `egress.mmd` | tenant trust boundary; edges carrying a data-egress control |

GitHub renders the `.mmd` files natively (Mermaid).

The current chart includes the `meeting-translation.v2` contract and the private meeting
translation SQLite cache owned by `agent-api`. Terminal and extension read/advance the same
owner-authorized phrase overlay; model inference uses the existing isolated completion-worker
path. The projections show the cache's ownership and client connections; the
[contract guide](../../core/agent/contracts/meeting-translation.v2/README.md) describes phrase
boundaries, observed tail buffering and retries.

For architecture changes, review `architecture.calm.json`, update its seal with `pnpm seal:arch`,
regenerate these views, then run `pnpm gate:dataflow` and `pnpm gate:calm`. A README-only update
does not require resealing or regenerating the diagrams.
