#!/bin/sh
# Root (prd) or sudo (fr1, fr2: keys of $SUDO_USER copied too): dedicated user `agent` for the runner.
#   ssh prd 'sh -s' < tools/agents/bootstrap-user.sh ; then ssh agent@prd 'sh -s' < tools/agents/install.sh
# Creates `agent` with full root through sudo (NOPASSWD: ALL, /etc/sudoers.d/aphrody-agent checked by visudo -cf;
# owner decision 2026-11-13, same as device/fleet/bootstrap/common.sh agent_user), docker group, copies root's
# authorized_keys (public keys only), enables linger,
# makes the log collection dir writable. Agent CLI logins stay per user: the owner runs
# `sudo -iu agent claude login` / `codex login` / `gh auth login` once (OAuth, interactive).
set -eu
U=${AGENTS_USER:-agent}
[ "$(id -u)" = 0 ] || { echo "bootstrap-user: run as root" >&2; exit 1; }
id "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"
H=$(getent passwd "$U" | cut -d: -f6)
install -d -m 0700 -o "$U" -g "$U" "$H/.ssh"
{ cat /root/.ssh/authorized_keys; [ -z "${SUDO_USER:-}" ] || cat "$(getent passwd "$SUDO_USER" | cut -d: -f6)/.ssh/authorized_keys"; } 2>/dev/null >> "$H/.ssh/authorized_keys" || true
sort -u -o "$H/.ssh/authorized_keys" "$H/.ssh/authorized_keys"
chown "$U:$U" "$H/.ssh/authorized_keys"; chmod 0600 "$H/.ssh/authorized_keys"
getent group docker >/dev/null && usermod -aG docker "$U"
t=$(mktemp); printf '%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$U" > "$t"
visudo -cf "$t" >/dev/null && install -m 0440 -o root -g root "$t" /etc/sudoers.d/aphrody-agent; rm -f "$t"; visudo -c >/dev/null
loginctl enable-linger "$U"
install -d -m 0755 -o "$U" -g "$U" /var/lib/aphrody-agents /var/lib/aphrody-agents/logs
chown -R "$U:$U" /var/lib/aphrody-agents
# ai-os relay (127.0.0.1:8790) bearer token, readable by the runner user only. Re-run after a rotation.
T=/root/.local/state/aphrody/relay/token
if [ -f "$T" ]; then install -d -m 0700 -o "$U" -g "$U" "$H/.local" "$H/.local/state" "$H/.local/state/aphrody" "$H/.local/state/aphrody/relay"; install -m 0600 -o "$U" -g "$U" "$T" "$H/.local/state/aphrody/relay/token"; fi
command -v tmux git >/dev/null
echo "bootstrap-user: ok user=$U home=$H"
