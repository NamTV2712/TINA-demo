# Desktop alignment dependency cycle — 2026-10-28

Status: resolved in source and rebuilt JavaScript; architecture gates green.

## Change

Moved existing alignment types, SHA-256 hashing, validation and word/speaker
projection unchanged into `alignment-model.ts`. The journal and meeting-memory
now use this model; `alignment.ts` retains background job orchestration and its
journal dependency. All affected imports, including alignment tests, were updated.
No circular-dependency exception or gate exclusion was added.

The dependency direction is now:

- `alignment.ts` → `transcript-journal.ts` → `alignment-model.ts`.
- `alignment.ts` → `alignment-model.ts`.
- `meeting-memory.ts` → `alignment-model.ts` (types only).

The move retained the exact worker and pure-function bodies. CAS checks, audio
provenance, alignment validation, projection rules and SQLite transactions did
not change. The architecture description, seal and generated DSL views were updated.

## Verification

- `pnpm -C core/meetings/services/desktop test`: passed (exit 0), including TypeScript
  build and process recovery. Alignment coverage includes seven worker batch calls,
  accepted tokens, OOV handling, source gaps, stale edits/Restore, speaker rename,
  audio playback, monotonic revision events, cancellation, ACL, contracts and restart.
- `node scripts/gates.mjs graph`: passed; source and compiled dependency cycles gone.
- `node scripts/gates.mjs dataflow`: passed; 123 nodes, 101 edges, 14 carriers,
  complete and sealed (P23). Existing writer-attribution advisories remain nonblocking.
- `node scripts/gates.mjs arch-report`: passed; all mapped modularity gates green.
- `git diff --check` on changed tracked documentation/architecture files: passed.

Logs: `/tmp/tina-alignment-cycle-{desktop-tests,graph,dataflow,arch-report}.log`.
This was a refactor and gate check: the running Desktop process was not restarted,
no database migration was performed, and real microphone/meeting acceptance was
not rerun. Existing unrelated checkout changes were retained.

## Runtime restart follow-up

At the owner's request, Desktop was subsequently restarted through launchd using
SIGTERM and its existing KeepAlive policy. PID changed from 62874 to 10543;
health and configured ASR were ready after 0.71 seconds. Ports 8056, 8057 and 9099
all belong to the new process. There were no live sessions before restart.
SQLite inode and row counts were preserved: 90 meetings, 330 transcript records
and 282,310 audio chunks. ASR selection metadata is unchanged. No new recording
was started. Evidence: `/tmp/tina-desktop-restart-20261028.json`.
