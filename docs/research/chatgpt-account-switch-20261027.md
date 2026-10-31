# ChatGPT account switch — 2026-10-27

Implemented and deployed to local Compose project `tina-verify-20261015` (Terminal :23000,
Agent API :28100). Account switching is available in Settings → Models → Agent model.

## Behavior

- Disconnect removes only the authenticated TINA user's ChatGPT profile. TINA login, model
  preferences and ASR configuration remain intact. A new connection starts without old account hints.
- Agent API serializes profile saves, refresh and disconnect using the same file lock. Disconnect
  rotates a durable generation before deleting credentials, rejecting callbacks from an older login.
- Pending OAuth state is cancelled per subject. The logout route rejects cross-origin requests
  and missing TINA authentication. The credential broker requires the internal secret.
- The meeting header distinguishes Meeting AI, chat and ASR. An unpinned meeting inherits the
  personal model selection rather than the old API-process default. Explicit workspace pins win.
- Fixed Compose's empty NEXTAUTH_URL, which caused NextAuth to throw Invalid URL during rendering.
  The default now uses the actual published loopback port; HTTPS deployments can override it.

## Verification

- Python: 69 tests passed in test_openai_disconnect.py, test_agent_config.py and test_api.py.
  Updated an existing Redis test fake to implement the production client's close() method.
- Terminal: 9 targeted route, auth-helper and component tests passed. Includes disconnect success,
  failure without losing account state, per-user isolation and ASR status request failure.
- Terminal production build and Docker builds for Terminal/Agent API succeeded.
- Architecture sealed and dataflow gate passed: 120 nodes, 95 edges, 11 carriers.
- Live Agent API reports chat and Meeting AI as gpt-6-luna for TINA subject 1.
- Live credential-broker test used an isolated synthetic subject: unauthenticated access rejected;
  save/disconnect succeeded; old-generation save rejected with 409; synthetic files removed.
- Live Terminal GET / and /meetings/30 return 200. POST logout without a session returns 401;
  cross-origin POST returns 403. Both updated containers are healthy.
- The real saved connection was preserved for the user to switch through the UI.

## Limits

The new account's OAuth login/consent still requires user interaction. No successful completion
with that new account has been verified. Disconnect is local unlink, not global provider-token
revocation or browser logout; already dispatched jobs may retain a short-lived token.
Browser rendering/click verification was not available in this session; UI behavior was tested
with component tests and deployed routes were checked over HTTP.

An accidental whole-workspace build also exposed a pre-existing bot config.ts type error
(number incompatible with a function-and-number intersection); the isolated Terminal build passed.
The whole-repo config-contract gate remains blocked by existing undeclared diarization/alignment
environment keys on Meeting API and TRANSCRIPTION_MODEL/AWS_REGION/AWS_BEARER_TOKEN_BEDROCK/
OPENAI_API_KEY reads on Agent API. The ChatGPT auth directory is now declared in Agent API config.v1.
No STT, audio, raw transcript or canonical revision mutation was part of this change.
