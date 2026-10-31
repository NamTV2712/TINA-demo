# TINA CLI 0.2.0 — diagnostics and repository checks

Implemented the agreed next scope: full system diagnostics and allowlisted repository checks,
with English CLI/TUI copy and the existing green theme. The installed symlink picks up the changes;
no package reinstall or production restart is required.

## Commands

```bash
tina doctor --full
tina doctor --full --json
tina check cli
tina check graph
tina check dataflow
tina check contracts
tina check all --json
tina check all --dry-run
```

TUI includes Full system check and Repository checks. The latter opens a submenu for all checks
or an individual suite. Both views use the same CLI handlers and retain detailed failure results.

## Authority and read-only behavior

- Full doctor collects Compose engine/config/image/service results without stopping after the
  first failure. Normal doctor still checks Compose only.
- ASR selection comes from Identity's existing resolver, not a guessed model/port. Only explicit
  deployment selection may fall back to the deployment environment. A configured Desktop account
  key selects its preferences; denied credentials never fall back to global defaults. Bot ASR
  probes cover global defaults, not every participant/user or an active session's pinned backend.
- ASR status is probed from the host and inside the selected Agent API container. Container probe
  credentials are passed through stdin, never process arguments. Responses are bounded and
  allowlisted. HTTP redirects and proxy environment variables are disabled; tokens are not returned.
- Desktop :8056 health checks liveness/configuration. Capture :9099 is TCP-only: listener reachable
  means not_verified, not verified recording. A closed bridge blocks readiness. No WebSocket handshake
  or capture session is created. Ready and complete are separate; unsupported status/bridge proof
  remains an evidence gap. ASR/worker health is not inference or audio-quality acceptance.
- Alignment/diarization URLs are from the selected deployment; host.docker.internal is translated
  to loopback for host probes. Optional unconfigured workers are explicit. Host-only worker env
  files, Capture permissions, AEC and microphone input are not inspected.
- The four check names map to fixed argv commands. They reuse existing gates, never seal/deploy,
  and do not require a live Docker stack to dispatch. CLI tests use the existing test environment
  via frozen/offline/no-sync uv; npm/npx is offline. Missing prerequisites fail with a log.
- Each check writes a private redacted log outside the repo and preserves exit code, duration,
  log path and failure tail. All runs continue across individual failures. Timeout is 300 seconds;
  timeout/cancel terminates the child process group. No volume deletion or service restart occurs.
- Failed full doctor/check commands return exit 1 and retain data.diagnostics/data.checks in their
  JSON error envelope. Dry-run creates neither probes nor check logs.

## Verification

- Installed tina check cli: 87 tests passed, 1 skipped, 11 subtests passed. Tests include resolver
  authority/fallback, account denial, unknown endpoints, metadata token/control-character filtering,
  response limits, redirect refusal, private log permissions, missing tools, timeouts/cancellation,
  JSON errors, Docker-independent checks and TUI submenu dispatch.
- Installed tina check all: CLI, graph, dataflow and contract-version PASS. Architecture deploy
  description updated, architecture seal regenerated and diagram views synchronized.
- PTY test opened Full system check, displayed the live diagnostics failure, opened Repository
  checks, ran graph successfully, returned to menu and quit. Terminal modes were restored.
- Production container IDs and StartedAt timestamps remained unchanged around full doctor. Selected
  .env, CLI sources, architecture seals and ASR contract hashes also remained unchanged by probes.
- Installed dry-run for full doctor and all checks returned will_write=false. Syntax/whitespace PASS.

Evidence: /tmp/tina-check-all-complete.json, /tmp/tina-check-cli-final.json,
/tmp/tina-doctor-full-final.json and /tmp/tina-full-tui-output.bin. Individual gate logs live under
~/Library/Logs/TINA/checks/. Last 87-test run: 20261030-151422-v9s8piq9/cli.log.

## Live findings, not changed by this task

Compose passed all checks; Desktop host responded; configured alignment/diarization health passed.
Capture bridge listener was reachable but remained not_verified. Identity currently resolves ASR
to deployment defaults; both host and container status probes were unreachable. Full doctor correctly
returns diagnostics_failed/exit 1. No backend was switched or started to make the result green.

No meeting/ASR/agent end-to-end inference test was run. This task does not add backup/restore,
host worker start/stop, meeting API commands, or fix pre-existing README/TTS gate issues.
