#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
PYTHON="$REPO_ROOT/.venv/funasr/bin/python"

if [ ! -x "$PYTHON" ]; then
  echo "FunASR environment is missing. Follow deploy/transcription/funasr/README.md." >&2
  exit 1
fi

exec "$PYTHON" "$SCRIPT_DIR/server.py"
