#!/bin/sh
# Agent runner on the Windows PC (native: bun + psmux `tmux`, no WSL). Idempotent, no admin needed.
# Registers scheduled task \Aphrody\AgentsHealth (at logon + every 5 min, hidden console) that runs
# `runner.ts health`: it creates/repairs the psmux session "agents", requeues orphans, ships logs to prd.
#   just agents-install-pc
set -eu
SRC=${SRC_ROOT:-C:/aphrody}
BUN=$(command -v bun) || { echo "install-pc: bun missing" >&2; exit 1; }
command -v tmux >/dev/null || { echo "install-pc: tmux (psmux, winget arndawg.tmux-windows) missing" >&2; exit 1; }
WBUN=$(cygpath -w "$BUN" 2>/dev/null || echo "$BUN")
RUNNER="$SRC/tools/agents/runner.ts"
TR="conhost.exe --headless \"$WBUN\" --no-env-file \"$RUNNER\" health"

schtasks.exe /Create /F /TN "Aphrody\\AgentsHealth" /SC MINUTE /MO 5 /TR "$TR" >/dev/null
schtasks.exe /Create /F /TN "Aphrody\\AgentsLogon" /SC ONLOGON /TR "$TR" >/dev/null
# Agent tooling (tools/agents/toolchain.toml): drift fix every hour and at session start.
SYNC="conhost.exe --headless \"$WBUN\" \"$SRC/system/machine-ts/src/toolchain.ts\" sync"
schtasks.exe /Create /F /TN "Aphrody\\AgentsSync" /SC HOURLY /TR "$SYNC" >/dev/null
schtasks.exe /Create /F /TN "Aphrody\\AgentsSyncLogon" /SC ONLOGON /TR "$SYNC" >/dev/null
SRC_ROOT=$SRC "$BUN" "$RUNNER" health
schtasks.exe /Query /TN "Aphrody\\AgentsHealth" /FO LIST | grep -iE 'TaskName|Next Run|Prochaine|Status|Statut' || true
tmux list-windows -t agents -F '  tmux #{window_index} #{window_name}' 2>/dev/null || true
