#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
config_file=${TINA_DIARIZATION_ENV_FILE:-"$HOME/.config/tina/diarization.env"}
if [ -f "$config_file" ]; then
  set -a
  . "$config_file"
  set +a
fi
: "${TINA_DIARIZATION_MODELS:?Set the model directory}"
: "${TINA_DIARIZATION_TOKEN:?Set the worker token}"
cd "$repo_dir/deploy/transcription/diarization"
exec "$repo_dir/.venv/diarization/bin/python" -m uvicorn server:app --host 127.0.0.1 --port 18014 --workers 1
