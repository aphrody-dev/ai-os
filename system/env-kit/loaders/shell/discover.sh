#!/bin/sh
# Shell twin of system/env-kit/src/discover.ts: site facts come from the protocols that answer, never from a stored inventory.
# The only per-machine input is ssh_config(5): a role (fr1, fr2, prd) is a Host alias, here or in /etc/ssh/ssh_config.d.
#   discover_get hosts.fr2.mesh_ip      hosts.<role>.{ssh,user,port,hostname,public_ip,public_ipv6,mesh_ip,link_ip}, network.mesh_cidr,
#                                       identity.{name,email,github_user}, windows.{user,home,machine}
#   discover_addr fr2                   address to dial (ssh -G hostname, resolved with getent when it is a name)
#   discover_self                       this host's role (/etc/aphrody/role)
# Results are cached in ~/.cache/aphrody/discover.tsv (TTL DISCOVER_TTL, default 3600 s); a stale entry answers when the live lookup fails.

DISCOVER_TTL=${DISCOVER_TTL:-3600}
_dc_file=${APHRODY_DISCOVER_TSV:-${XDG_CACHE_HOME:-${HOME:-${USERPROFILE:-/tmp}}/.cache}/aphrody/discover.tsv}

discover_self() { tail -n 1 /etc/aphrody/role 2>/dev/null; }

# discover_cached <key> <command...>: fresh cache, else the command's output, else the stale cache.
discover_cached() {
  _dk=$1; shift
  _dn=$(date +%s)
  _dl=$(awk -F'\t' -v k="$_dk" '$1==k{print $2 "\t" $3}' "$_dc_file" 2>/dev/null | tail -n 1)
  _dt=${_dl%%	*}; _dv=${_dl#*	}
  if [ -n "$_dl" ] && [ $((_dn - _dt)) -lt "$DISCOVER_TTL" ]; then printf '%s\n' "$_dv"; return 0; fi
  _dnew=$("$@" 2>/dev/null | head -n 1)
  if [ -n "$_dnew" ]; then
    mkdir -p "$(dirname "$_dc_file")" 2>/dev/null
    { grep -v "^$_dk	" "$_dc_file" 2>/dev/null; printf '%s\t%s\t%s\n' "$_dk" "$_dn" "$_dnew"; } > "$_dc_file.tmp" 2>/dev/null && mv "$_dc_file.tmp" "$_dc_file"
    printf '%s\n' "$_dnew"; return 0
  fi
  [ -n "$_dl" ] && { printf '%s\n' "$_dv"; return 0; }
  return 1
}

_dc_sshg() { ssh -G "$1" 2>/dev/null | awk -v f="$2" '$1==f{sub(/^[^ ]+ /,""); print; exit}'; }
_dc_probe() { _dc_on "$1" 'ip -o -4 addr show scope global; echo ===; ip -o link'; }
# n-th tunnel (WireGuard: link/none) IPv4 of a role, whatever the interface is called
_dc_mesh() { _dc_probe "$1" | awk -v n="$2" '/^===/{s=1;next} !s{a[$2]=$4;o[++c]=$2;next} /link\/none/{t=$2;sub(/:$/,"",t);tun[t]=1} END{for(i=1;i<=c;i++) if(tun[o[i]] && ++k==n){x=a[o[i]];sub(/\/.*/,"",x);print x;exit}}'; }
# first public IPv4 of a role (global scope, not RFC 1918, not a tunnel)
_dc_pub() { _dc_probe "$1" | awk '/^===/{s=1;next} !s{a[$2]=$4;o[++c]=$2;next} /link\/none/{t=$2;sub(/:$/,"",t);tun[t]=1} END{for(i=1;i<=c;i++){x=a[o[i]];sub(/\/.*/,"",x); if(!tun[o[i]] && x !~ /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/){print x;exit}}}'; }
# Runs a command on a role: locally when it is this host, else over ssh.
_dc_on() { _r=$1; shift; if [ "$_r" = "$(discover_self)" ]; then sh -c "$*"; else ssh -o BatchMode=yes -o ConnectTimeout=8 "$_r" "$*"; fi; }

# first global IPv6 of a role
_dc_pub6() { _dc_on "$1" "ip -o -6 addr show scope global" | awk "{sub(/\\/.*/,\"\",\$4); if (\$4 !~ /^f[cd]/) {print \$4; exit}}"; }

discover_addr() {
  _a=$(_dc_sshg "$1" hostname)
  case $_a in "") return 1;; *[!0-9.]*) getent ahostsv4 "$_a" 2>/dev/null | awk '{print $1; exit}';; *) echo "$_a";; esac
}

discover_get() {
  case $1 in
    hosts.*.*)
      _role=${1#hosts.}; _role=${_role%%.*}; _key=${1##*.}
      case $_key in
        ssh) echo "$_role";;
        user|port|proxyjump) discover_cached "$1" _dc_sshg "$_role" "$_key";;
        hostname) discover_cached "$1" _dc_on "$_role" 'hostname -f 2>/dev/null || hostname';;
        public_ip) discover_cached "$1" _dc_pub "$_role" || discover_cached "$1" _dc_sshg "$_role-mesh" hostname || discover_addr "$_role";;
        public_ipv6) discover_cached "$1" _dc_pub6 "$_role";;
        mesh_ip) if [ "$_role" = "$(discover_self)" ]; then _dc_mesh "$_role" 1
                 else getent hosts "$_role.mesh" 2>/dev/null | awk '{print $1; exit}' | grep . || discover_cached "$1" _dc_mesh "$_role" 1; fi;;
        link_ip|extra_mesh_ip) discover_cached "$1" _dc_mesh "$_role" 2;;
        *) return 1;;
      esac;;
    network.mesh_cidr) _m=$(discover_get hosts.fr1.mesh_ip) && echo "${_m%.*}.0/24";;
    identity.name) git config --global user.name;;
    identity.email) git config --global user.email;;
    identity.github_user) discover_cached "$1" gh api user --jq .login;;
    windows.user) echo "${USERNAME:-${USER:-$(id -un)}}";;
    windows.home) echo "${USERPROFILE:-$HOME}";;
    windows.machine) echo "${COMPUTERNAME:-$(hostname)}";;
    *) # zones.*, accounts.*: Cloudflare API and gcloud answer through the TS resolver
      command -v bun >/dev/null 2>&1 && bun "$(dirname "${BASH_SOURCE:-$0}")/../../src/discover.ts" get "$1";;
  esac
}
