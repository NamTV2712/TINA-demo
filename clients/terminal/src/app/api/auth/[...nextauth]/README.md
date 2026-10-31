# [...nextauth]

NextAuth catch-all route — the OAuth broker for Google + Microsoft sign-in. NextAuth owns only the OAuth
handshake; the `signIn` callback converts the verified identity into the terminal's `tina-token` +
`tina-user-info` cookies via `findOrCreateUserToken` (`../adminApi.ts`), so the rest of the terminal's
auth is unchanged. Providers self-gate on env presence; credentials come from `tina-secrets` (see the
parent `README.md` and the repo `.env.local`). Mirrors the production webapp's nextauth route.

When neither OAuth provider is configured, `GET /api/auth/providers` returns an empty object so the
login gate can hide the OAuth buttons; the separate direct-email login remains limited to test accounts.
