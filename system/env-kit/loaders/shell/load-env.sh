#!/usr/bin/env sh
# POSIX / Bash / Zsh sourceable loader for $ENV_KIT_ROOT/.env, or the .env of the repository holding this script (bash)
# or the file given as the first argument. The current directory is never searched: a .env found there is untrusted input.
# Usage: . system/env-kit/loaders/shell/load-env.sh
# Never echoes secret values. Preserves already-set non-empty environment variables unless ENV_KIT_OVERRIDE=1.

_env_kit_load() {
  _ek_file="${1:-}"
  if [ -z "$_ek_file" ]; then
    _ek_root="${ENV_KIT_ROOT:-}"
    if [ -z "$_ek_root" ] && [ -n "${BASH_SOURCE:-}" ]; then
      _ek_root="$(cd "$(dirname "$BASH_SOURCE")/../../../.." 2>/dev/null && pwd)"
    fi
    if [ -z "$_ek_root" ]; then
      echo "load-env: set ENV_KIT_ROOT or pass the path of the .env file" >&2
      return 1
    fi
    _ek_file="$_ek_root/.env"
    unset _ek_root
  fi

  [ -f "$_ek_file" ] || return 0

  while IFS= read -r _ek_line || [ -n "$_ek_line" ]; do
    _ek_line="${_ek_line%"$(printf '\r')"}"
    case "$_ek_line" in
      ""|\#*|[[:space:]]\#*) continue ;;
    esac
    case "$_ek_line" in
      export\ *) _ek_line="${_ek_line#export }" ;;
    esac
    case "$_ek_line" in
      *=*)
        _ek_key="${_ek_line%%=*}"
        _ek_val="${_ek_line#*=}"
        # Trim leading/trailing spaces on key
        _ek_key="$(printf '%s' "$_ek_key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        case "$_ek_key" in
          ''|*[!A-Za-z0-9_]*|[0-9]*) continue ;;
          # Names that change how programs load code or how the shell behaves are never taken from a file.
          LD_*|DYLD_*|BASH_ENV|ENV|GIT_*|PATH|IFS|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|*_OPTIONS) continue ;;
        esac
        _ek_val="$(printf '%s' "$_ek_val" | sed 's/^[[:space:]]*//')"
        # Quotes (same grammar as parseDotEnv, tests/vectors): "..." decodes \n \t \r \" \\ and stops at the
        # closing quote (a trailing comment is ignored); '...' is literal up to the closing quote.
        case "$_ek_val" in
          \"*)
            _ek_val="$(printf '%s' "$_ek_val" | awk '{
              s = substr($0, 2); out = ""
              for (i = 1; i <= length(s); i++) {
                c = substr(s, i, 1)
                if (c == "\\") { i++; n = substr(s, i, 1)
                  if (n == "n") out = out "\n"; else if (n == "t") out = out "\t"; else if (n == "r") out = out "\r"; else out = out n
                } else if (c == "\"") break; else out = out c
              }
              printf "%s", out }')"
            ;;
          \'*)
            _ek_val="${_ek_val#\'}"
            _ek_val="${_ek_val%%\'*}"
            ;;
          *)
            _ek_val="$(printf '%s' "$_ek_val" | sed 's/[[:space:]][[:space:]]*#.*$//;s/^[[:space:]]*//;s/[[:space:]]*$//')"
            ;;
        esac
        eval "_ek_cur=\${$_ek_key:-}"
        if [ "${ENV_KIT_OVERRIDE:-0}" = "1" ] || [ -z "$_ek_cur" ]; then
          if [ -n "$_ek_val" ] || [ "${ENV_KIT_OVERRIDE:-0}" = "1" ]; then
            export "$_ek_key=$_ek_val"
          fi
        fi
        ;;
    esac
  done < "$_ek_file"

  unset _ek_file _ek_line _ek_key _ek_val _ek_cur
}

_env_kit_load "$@"
