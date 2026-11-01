#!/bin/sh
# Source a plain local env file, or re-exec the caller with Dotenvx-injected values.
tina_load_env() {
  _tina_env_file=$1
  _tina_repo_dir=$2
  shift 2
  [ -f "$_tina_env_file" ] || return 0
  [ "${TINA_DOTENVX_ENV_LOADED:-}" = 1 ] && return 0

  if grep -q 'encrypted:' "$_tina_env_file"; then
    _tina_dotenvx=${DOTENVX_BIN:-$(command -v dotenvx || true)}
    [ -n "$_tina_dotenvx" ] || {
      echo "This env file is Dotenvx-encrypted; install dotenvx and provide its private key." >&2
      return 1
    }
    _tina_key_file=${DOTENVX_KEY_FILE:-}
    if [ -z "$_tina_key_file" ]; then
      if [ -f "$(dirname "$_tina_env_file")/.env.keys" ]; then
        _tina_key_file="$(dirname "$_tina_env_file")/.env.keys"
      elif [ -f "$_tina_repo_dir/.env.keys" ]; then
        _tina_key_file="$_tina_repo_dir/.env.keys"
      fi
    fi
    if [ -n "$_tina_key_file" ]; then
      case "$_tina_key_file" in
        /*) ;;
        *) _tina_key_file="$_tina_repo_dir/$_tina_key_file" ;;
      esac
    fi
    _tina_script="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")"
    if [ -n "$_tina_key_file" ]; then
      exec "$_tina_dotenvx" run --overload --redact -f "$_tina_env_file" -fk "$_tina_key_file" -- env TINA_DOTENVX_ENV_LOADED=1 "$_tina_script" "$@"
    fi
    exec "$_tina_dotenvx" run --overload --redact -f "$_tina_env_file" -- env TINA_DOTENVX_ENV_LOADED=1 "$_tina_script" "$@"
  fi

  set -a
  . "$_tina_env_file"
  set +a
}
