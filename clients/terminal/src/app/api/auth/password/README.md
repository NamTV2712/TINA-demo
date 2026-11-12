
# TINA Password Login

This route provides single-account email/password
authentication for the TINA AWS demo.

- GET: reports whether password login is configured.
- POST: verifies credentials using scrypt.
- Successful login uses TINA's existing session system.
- Production requires HTTPS.
- Credentials are supplied through environment variables.

Required variables:
- TINA_PASSWORD_LOGIN_EMAIL
- TINA_PASSWORD_LOGIN_HASH

Never commit real passwords or password hashes.
