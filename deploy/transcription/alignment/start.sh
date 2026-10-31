#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
config_file=${TINA_ALIGNMENT_ENV_FILE:-"$HOME/.config/tina/alignment.env"}
if [ -f "$config_file" ]; then
  set -a
  . "$config_file"
  set +a
fi
: "${MFA_CONDA_PREFIX:?Set the MFA Conda environment prefix}"
: "${MFA_ROOT_DIR:?Set the MFA model/config directory}"
: "${MFA_DICTIONARY:?Set the Vietnamese MFA dictionary path}"
: "${MFA_ACOUSTIC_MODEL:?Set the Vietnamese MFA acoustic model path}"
: "${TINA_ALIGNMENT_TOKEN:?Set the worker token}"
cd "$repo_dir/deploy/transcription/alignment"
exec "$repo_dir/.venv/alignment/bin/python" -m uvicorn server:app --host 127.0.0.1 --port 18015 --workers 1
