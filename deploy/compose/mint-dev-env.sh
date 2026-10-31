#!/usr/bin/env bash
# mint-dev-env.sh — seed deploy/compose/.env from .env.example and MINT every secret the stack
# refuses to run without. Since 0.12.27 the services refuse to boot on an empty or published
# placeholder for these keys (config.v1 `forbidden_values`); a fresh checkout therefore needs real
# values before `docker compose up`. `make up` / `make all` / `make dev`, CI's value leg and
# release-validate call this instead of a bare `cp` — it never overwrites an existing non-empty value.
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${1:-$here/.env}"
[ -f "$env_file" ] || cp "$here/.env.example" "$env_file"
# Do not silently rotate an existing administrator/signing credential. Old published
# placeholders require an explicit migration; a fresh template leaves this empty.
admin=$(sed -n 's/^ADMIN_TOKEN=//p' "$env_file" | head -1 | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//' | tr -d "\"'")
case "$admin" in
  dev-admin-token|tina-internal-secret|lite-internal-secret|changeme|change-me|CHANGE-ME|default|secret)
    echo "ADMIN_TOKEN is a published placeholder. Replace it explicitly on the existing deployment; no secrets were rotated." >&2
    exit 1;;
esac
mint() { openssl rand -hex 32; }
for key in ADMIN_TOKEN INTERNAL_API_SECRET TINA_FLOWS_API_KEY TINA_FLOWS_TIMELINE_KEY; do
  if grep -qE "^${key}=[[:space:]]*(\"\"|'')?[[:space:]]*$" "$env_file"; then
    v="$(mint)"
    # portable in-place edit (GNU and BSD sed)
    sed -i.bak "s|^${key}=.*|${key}=${v}|" "$env_file" && rm -f "$env_file.bak"
    echo "minted ${key}"
  elif ! grep -qE "^${key}=" "$env_file"; then
    echo "${key}=$(mint)" >> "$env_file"; echo "appended ${key}"
  else
    echo "kept ${key}"
  fi
done
