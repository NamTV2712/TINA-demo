# auth/login

`POST {email}` — find-or-create the user + mint an APIToken (scopes bot,tx,browser) via admin-api,
set the httpOnly `tina-token` cookie. No email is sent. This passwordless path only works when
`NODE_ENV` is `development` or `test`, and only for addresses at the reserved `@example.test` domain.
Production sign-in must use a configured OAuth provider.
