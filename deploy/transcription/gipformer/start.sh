#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
config_file=${TINA_GIPFORMER_ENV_FILE:-"$HOME/.config/tina/gipformer.env"}
if [ -f "$config_file" ]; then
  set -a
  . "$config_file"
  set +a
fi
: "${TINA_GIPFORMER_TOKEN:?Set a private worker token}"
cd "$repo_dir/deploy/transcription/gipformer"
exec "$repo_dir/.venv/gipformer-fsmn/bin/python" server.py
