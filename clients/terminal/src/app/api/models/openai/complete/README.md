# Manual ChatGPT callback completion

Authenticated, same-origin POST accepts a callback URL copied from another browser. It validates
the configured loopback origin/path and consumes OAuth state only for the original TINA subject.
It shares token exchange, OIDC verification and generation-checked save with the automatic callback.
No credential or authorization code is returned, persisted in browser storage, or logged.
