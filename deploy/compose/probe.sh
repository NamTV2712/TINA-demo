#!/usr/bin/env bash
# Resolve the same project/env/override chain as make all, then run scripts/probe/journey.sh.
# The probe creates a test user/key and meeting; use make doctor for read-only inspection.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$here/bin/stack.py" probe
