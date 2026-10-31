#!/bin/sh
# Next.js standalone rewrites are baked at build time from TINA_API_URL.
# Do not patch them at runtime: build args and runtime env must agree.

if [ -z "${TINA_API_URL:-}" ]; then
  echo "ERROR: TINA_API_URL is required for dashboard runtime config" >&2
  exit 1
fi

exec node server.js
