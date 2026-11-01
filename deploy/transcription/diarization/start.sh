#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config_file=${TINA_DIARIZATION_ENV_FILE:-""}
if [ -z "$config_file" ]; then
  if [ -f "$here/.env" ]; then
    config_file="$here/.env"
  else
    config_file="$HOME/.config/tina/diarization.env"
  fi
fi
. "$repo_dir/deploy/transcription/dotenvx-env.sh"
tina_load_env "$config_file" "$repo_dir" "$@"
: "${TINA_DIARIZATION_MODELS:?Set the model directory}"
: "${TINA_DIARIZATION_TOKEN:?Set the worker token}"
cd "$repo_dir/deploy/transcription/diarization"
exec "$repo_dir/.venv/diarization/bin/python" -m uvicorn server:app --host 127.0.0.1 --port 18014 --workers 1
