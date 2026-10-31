# routine.v1 — a saved recurring/event unit (trigger → plan)

A routine = `(name, trigger, plan)` — the authoring entity a user creates (e.g. with `/routine`). It
**compiles down** to existing mechanism: `kind:scheduled` → a `schedule.v1` cron job whose body is a
`unit.v1` Invocation; `kind:event` → an event-source subscription that emits the same Invocation. It
adds **no new execution path** — the dispatcher + scheduler already run it. Owner = the `identity.v1`
subject (per-person).

**Status: sealed** in `contracts.seal.json`. `gate:schema` validates the golden vectors.

The additive `trigger.timezone` field is an IANA zone; absent retains UTC. The compiled schedule
carries that zone. File-authored routines use owner/workspace/file IDs, source hashes for explicit
mutations, and an active-private-workspace reference so a scheduled worker starts in the source
workspace. Renaming the display label does not rename the file or change that ID.
