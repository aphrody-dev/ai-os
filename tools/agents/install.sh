#!/bin/sh
# Agent runner install for a Linux fleet host (prd, fr1, fr2). Idempotent, non-interactive.
#   ssh prd 'sh -s' < tools/agents/install.sh        (or from a checkout: sh tools/agents/install.sh)
# Env: AGENTS_SRC (checkout, default ~/agents/src), AGENTS_UPDATE=1 (upgrade CLIs to latest).
# Called at the end of device/fleet/bootstrap/*.sh when present. Doc: docs/agents/AGENT-FIRST.md.
set -eu
[ "$(id -u)" != 0 ] || { echo "install: never as root; run bootstrap-user.sh as root, then this as user agent" >&2; exit 1; }

SRC=${AGENTS_SRC:-$HOME/agents/src}
REPO=${AGENTS_REPO:-https://github.com/aphrody-labs/src.git}
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

need() { command -v "$1" >/dev/null 2>&1; }
need git || { echo "install: git missing" >&2; exit 1; }
need tmux || { echo "install: tmux missing (toolchain bootstrap installs it)" >&2; exit 1; }
need bun || { curl -fsSL https://bun.sh/install | bash; }

# 1. Runner checkout on main (blobless clone, no submodules: agents work on first-party code).
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$(dirname "$SRC")"
  git clone --filter=blob:none --branch main "$REPO" "$SRC"
fi
git -C "$SRC" config user.name "aphrody-dev"
git -C "$SRC" config user.email "contact@aphrody.com"
# Push credentials: gh's helper, which reads GH_TOKEN (injected by the runner from the user credstore).
git -C "$SRC" config --unset-all credential.https://github.com.helper 2>/dev/null || true
git -C "$SRC" config --add credential.https://github.com.helper ''
git -C "$SRC" config --add credential.https://github.com.helper '!gh auth git-credential'
git -C "$SRC" pull --ff-only --quiet origin main || true
install -m 0755 "$SRC/tools/agents/pre-push" "$SRC/.git/hooks/pre-push"

# 2. Agent CLIs (upstream packages, global bun installs). Claude Code uses its own native installer.
claude --version >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash
for spec in codex:@openai/codex gemini:@google/gemini-cli opencode:opencode-ai pi:@earendil-works/pi-coding-agent; do
  bin=${spec%%:*}; pkg=${spec#*:}
  # Check the bun global bin itself: a same-named wrapper elsewhere on PATH does not count.
  if [ ! -x "$HOME/.bun/bin/$bin" ] || [ "${AGENTS_UPDATE:-0}" = 1 ]; then bun add -g "$pkg@latest" >/dev/null 2>&1; fi
done
# npm CLIs with a `#!/usr/bin/env node` shebang run on bun's node mode when node is absent.
need node || ln -sf "$(command -v bun)" "$HOME/.bun/bin/node"
# gemini-cli 0.68 ignores defaultApprovalMode=yolo in settings: the wrapper (first on PATH) adds the flag
# unless the caller already chose a mode.
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/gemini" <<'EOF'
#!/bin/sh
# tools/agents/install.sh: gemini-cli in full-access mode (settings yolo ignored in 0.68).
# Management subcommands reject --approval-mode (gemini extensions list: "Unknown arguments", fr2 2026-11-13).
case ${1:-} in mcp|extensions|extension|skills|skill|hooks|hook|gemma|models) exec "$HOME/.bun/bin/gemini" "$@" ;; esac
case " $* " in *" --approval-mode"*|*" -y "*|*" --yolo "*) exec "$HOME/.bun/bin/gemini" "$@" ;; esac
exec "$HOME/.bun/bin/gemini" --approval-mode yolo "$@"
EOF
chmod 0755 "$HOME/.local/bin/gemini"
# Every shell of the user (login, interactive, `ssh host codex`) finds the CLIs: before 2026-11-13,
# prd's agent had no ~/.profile and `codex` was "command not found" outside the runner.
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$rc"
  # Prepended: Ubuntu's .bashrc returns early for non-interactive shells.
  grep -q '# aphrody-agents PATH' "$rc" || { printf '%s\n' 'case ":$PATH:" in *":$HOME/.bun/bin:"*) ;; *) PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; export PATH ;; esac # aphrody-agents PATH'; cat "$rc"; } > "$rc.new" && mv "$rc.new" "$rc"
done

# Trust the runner checkout for Claude Code (headless runs cannot answer the trust dialog).
bun -e 'const f=process.env.HOME+"/.claude.json";const fs=require("fs");const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};j.projects??={};j.projects[process.argv[1]]={...(j.projects[process.argv[1]]??{}),hasTrustDialogAccepted:true};fs.writeFileSync(f,JSON.stringify(j,null,2))' "$SRC"

# 3. systemd user units (linger keeps them running without a login session).
need loginctl && loginctl enable-linger "$(id -un)" 2>/dev/null || true
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
UNITS=$HOME/.config/systemd/user
mkdir -p "$UNITS"
BUN=$(command -v bun)
for f in "$SRC"/tools/agents/systemd/*; do
  sed -e "s|@SRC@|$SRC|g" -e "s|@BUN@|$BUN|g" "$f" > "$UNITS/$(basename "$f")"
done
systemctl --user daemon-reload
systemctl --user enable --now aphrody-agents.service aphrody-agents-health.timer aphrody-agents-pull.timer >/dev/null
"$BUN" "$SRC/tools/agents/runner.ts" health

echo "install: ok host=$(hostname) src=$SRC"
for c in claude codex gemini opencode pi; do printf '  %s: ' "$c"; "$c" --version 2>&1 | head -1 || echo missing; done
tmux list-windows -t agents -F '  tmux #{window_index} #{window_name}' 2>/dev/null || true
