# ChatGPT callback across browser profiles — 2026-10-28

The user opened the generated authorization link in a different browser/profile. That profile
had no TINA session cookie. The callback previously consumed pending OAuth state before checking
the authenticated TINA subject, so returning to the original browser could no longer complete it.

Reproduced on the running Terminal before the change: anonymous callback returned 400; retrying
the same state with the initiating TINA session also returned the generic expired/mismatch error.

## Change

- Pending state is consumed only by its initiating authenticated TINA subject, once, within the
  existing ten-minute TTL. Anonymous and mismatched requests preserve it.
- Without a TINA session, a callback carrying state/code shows a copyable callback URL. The user
  pastes it into the original TINA Settings tab and chooses Finish connection.
- The new same-origin authenticated POST /api/models/openai/complete accepts only the configured
  loopback callback origin/path and uses the same completion routine as the automatic callback.
- OIDC signature/nonce/audience verification, PKCE and generation-checked credential saves remain
  in that shared routine. Disconnect still cancels pending state and prevents stale saves.
- Callback responses use no-store and no-referrer. Codes live only in the callback page/component
  memory; access/refresh tokens remain server-side. Reconnecting an existing account no longer
  hides the handoff controls merely because its old saved connection still reports connected.

## Evidence

- 17 focused tests passed across callback, disconnect, auth helpers and account-connection UI.
- Terminal production Docker build passed; deployed to tina-verify-20261015-terminal-1.
- Live negative-flow test passed: anonymous callback 200 with handoff, anonymous completion 401,
  initiating session recovered the request and reached the simulated access_denied response,
  replay rejected. The test did not call the provider token endpoint or replace saved credentials.
- GET /meetings/30 returned 200 after deployment; container healthy.

The real account's OAuth consent/token exchange still requires the user and is not yet verified.
Pending states remain in Terminal process memory; deployment/restart invalidates old links.
Generate a new link after this deployment and keep the initiating TINA tab open while signing in.
