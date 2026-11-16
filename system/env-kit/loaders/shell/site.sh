#!/bin/sh
# Token rendering over discover.sh. Tracked configs carry @@a.b.c@@ tokens (same vocabulary as discover_get); a host's
# values are discovered when the file is installed, so nothing site-specific is committed or stored.
#   . site.sh; site_render <file>             file with every token replaced, on stdout
#   site_install <mode> <src> <dst>           `install` of the rendered file
#   site_get <path>, site_ssh <role>          discover_get, and the ssh alias of a role (the role itself)
_ss_dir=$(cd "$(dirname "${BASH_SOURCE:-$0}")" 2>/dev/null && pwd)
[ -f "$_ss_dir/discover.sh" ] && . "$_ss_dir/discover.sh" || . /usr/local/lib/aphrody/discover.sh

site_get() { discover_get "$1"; }
site_ssh() { echo "$1"; }

site_render() {
  _sr_sed=
  for _sr_k in $(grep -o '@@[A-Za-z0-9_.-]*@@' "$1" | sort -u | tr -d '@'); do
    _sr_v=$(discover_get "$_sr_k") || { echo "site: nothing answers for $_sr_k" >&2; return 1; }
    _sr_sed="$_sr_sed -e s|@@$_sr_k@@|$_sr_v|g"
  done
  if [ -n "$_sr_sed" ]; then sed $_sr_sed "$1"; else cat "$1"; fi
}

site_install() {
  _si_mode=$1; _si_src=$2; _si_dst=$3
  _si_tmp=$(mktemp) && site_render "$_si_src" > "$_si_tmp" && install -m "$_si_mode" "$_si_tmp" "$_si_dst"; _si_rc=$?
  rm -f "$_si_tmp"; return $_si_rc
}
