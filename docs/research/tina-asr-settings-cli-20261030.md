# TINA CLI 0.3.0 — scoped ASR settings

Implemented ASR status, configure and verify with a green English ASR settings TUI submenu.
The installed tina symlink uses the updated code immediately. No new dependency or server API was added.

```bash
tina asr status
tina asr verify
tina asr configure
tina asr status --scope account
tina asr configure --scope global --backend custom \
  --url http://host.docker.internal:18002 --token-env TINA_ENDPOINT_TOKEN --dry-run
```

The URL above is an explicit example, never an automatic worker selection. Use --yes instead of
--dry-run only after reviewing scope, endpoint and credential action. Interactive configure selects
scope/backend, asks for endpoint and hidden token, shows the preview, then requires confirmation.
JSON/noninteractive mode never waits for input. Account mode requires a supplied API key and identifies
the account ID; it cannot target an arbitrary user ID.

## Existing authority boundaries

- Global fields use GET/PUT /internal/settings/transcription under the deployment's private internal
  credential. Only the selected project's running Identity API with the expected published port is used.
- Account fields use /user/transcription with the authenticated account key. The key is first validated
  for expiry and bot/tx/legacy scope. Denial never becomes a global fallback.
- Custom global endpoints map to the API's deployment slot. Named FunASR/Sherpa slots have URL fields
  but no token field; authenticated endpoints use custom. No arbitrary model-setting field is invented.
- Effective selection is re-read through /internal/transcription/resolve after saving. Verify reuses
  the existing bounded host/container status probes; status itself does not claim inference readiness.
- Endpoint credentials come from hidden input, an environment variable name, or an owner-only regular
  token file (not a dotenv file). Symlinks, public files and malformed token/URL values are rejected.
  No new CLI credential store is created. Raw token argv is refused without echoing the secret.
- Changing a credential-bearing endpoint requires a new token or explicit clear; unchanged endpoints
  preserve credentials by omission. Previews/results contain only credential presence/action.
- Partial writes retain unrelated fields and the other scope. Settings are re-read before writing to
  catch changes made during confirmation. Exact global/effective account token readback is checked,
  without printing the value. Failed/unconfirmed writes do not claim rollback or retry blindly.
- Active sessions are not restarted; settings apply to new sessions. Actual bot user overrides may
  differ from global defaults. Desktop binding and current CLI account may be different identities.

## Verification

- Installed tina check cli: 109 passed, 1 skipped, 15 subtests passed. Covers scoped previews/writes,
  account denial, dry-run and cancellation before PUT, credential decisions on endpoint changes,
  token file access rules, target project binding, intervening edits, uncertain writes, readback mismatch,
  malformed settings, secret-free JSON, raw credential argv rejection and TUI dispatch.
- CLI/graph/dataflow/contracts passed through tina check all. CALM deploy description, seal and
  generated views updated to describe the existing Identity configuration seam.
- Actual FastAPI Identity routes exercised with TestClient and an in-memory session double:
  global write/readback, account write/readback, dry-run unchanged, denied account, other scope and
  unrelated endpoint retained. This tests route semantics, not real PostgreSQL persistence.
- PTY: ASR menu opened, live global/Desktop status displayed, configure cancelled at scope selection
  before any settings write, returned to menu and exited with terminal modes restored.
- Production smoke used only status, verify and configure dry-run. Global settings values, .env hash
  and production container IDs were unchanged. Verify correctly remained unsuccessful because the
  existing deployment ASR endpoint was unreachable; no backend was switched to make checks green.

Evidence: /tmp/tina-asr-cli-release.json, /tmp/tina-asr-check-all-complete.json,
/tmp/tina-asr-identity-integration.log, /tmp/tina-asr-production-preview.json and
/tmp/tina-asr-tui-output.bin. Integration/PTY harnesses are /tmp/tina-asr-identity-integration.py
and /tmp/tina-asr-tui-check.py. No production restart, model start, audio upload or inference occurred.

## Limits

The existing global settings API has no atomic CAS. The CLI catches edits observed at re-read, but
another administrator can still race after that check; add server CAS before relying on concurrent
editing. No automatic rollback can safely undo an ambiguous write in that situation. Endpoint status
does not validate recognition quality, language suitability or every bot user's pinned backend.
