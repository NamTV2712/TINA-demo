#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
viegem_env_file=${TINA_VIEGEM_ENV_FILE:-$HOME/.config/tina/.env.viegem}
if [ -f "$viegem_env_file" ]; then
    TINA_VIEGEM_TOKEN=$("${DOTENVX_BIN:-dotenvx}" get TINA_VIEGEM_TOKEN --quiet --strict --overload \
        -f "$viegem_env_file" -fk "${TINA_VIEGEM_KEYS_FILE:-$(dirname -- "$viegem_env_file")/.env.keys}")
    export TINA_VIEGEM_TOKEN
    # Extract only the derived worker-control key, never export the platform secret.
    TINA_VIEGEM_DRAIN_KEY=$("${DOTENVX_BIN:-dotenvx}" get INTERNAL_API_SECRET --quiet --strict --overload \
        -f "$viegem_env_file" -fk "${TINA_VIEGEM_KEYS_FILE:-$(dirname -- "$viegem_env_file")/.env.keys}" 2>/dev/null \
        | "$repo_dir/.venv/viegem/bin/python" -c 'import sys,hmac; s=sys.stdin.read().strip(); print(hmac.new(s.encode(),b"tina-asr-drain:v1:viegem","sha256").hexdigest() if s else "")')
    export TINA_VIEGEM_DRAIN_KEY
fi
: "${TINA_VIEGEM_TOKEN:?Set a private worker token of at least 32 characters}"
exec "$repo_dir/.venv/viegem/bin/python" "$repo_dir/deploy/transcription/viegem/server.py"
