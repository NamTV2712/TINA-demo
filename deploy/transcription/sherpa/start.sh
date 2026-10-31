#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
binary="$repo_dir/core/meetings/services/native-asr/target/release/tina-native-asr"
if [ ! -x "$binary" ]; then
  printf '%s\n' 'Build first: cargo build --release --manifest-path core/meetings/services/native-asr/Cargo.toml' >&2
  exit 1
fi
exec "$binary"
