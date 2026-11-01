#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config_file=${TINA_GIPFORMER_ENV_FILE:-""}
if [ -z "$config_file" ]; then
  if [ -f "$here/.env" ]; then
    config_file="$here/.env"
  else
    config_file="$HOME/.config/tina/gipformer.env"
  fi
fi
. "$repo_dir/deploy/transcription/dotenvx-env.sh"
tina_load_env "$config_file" "$repo_dir" "$@"
: "${TINA_GIPFORMER_TOKEN:?Set a private worker token}"
cd "$repo_dir/deploy/transcription/gipformer"
exec "$repo_dir/.venv/gipformer-fsmn/bin/python" server.py
