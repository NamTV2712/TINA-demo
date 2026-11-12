
# TINA Demo — Email and Password Login

## Purpose

Allow one authorized administrator to sign in
without Google or Microsoft OAuth.

## Configuration

The deployment uses two environment variables:

- TINA_PASSWORD_LOGIN_EMAIL
- TINA_PASSWORD_LOGIN_HASH

Provision credentials through AWS Secrets Manager.
Never store plaintext passwords in Git.

## Security

- HTTPS is mandatory.
- Passwords are verified with scrypt.
- Failed login attempts are rate-limited per process.
- The existing TINA session and role system is reused.
- Passwordless email login remains disabled in production.

## Deployment

1. Build the updated Terminal Docker image.
2. Configure the credentials securely.
3. Redeploy the Terminal container.
4. Verify login and administrator permissions.
5. Confirm unauthenticated requests are rejected.

Keep HTTPS access restricted during testing.
