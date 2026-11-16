# ai-os, orchestrator, NHITL, review tribunal and relay recipes (imported by the root justfile).

# @aphrody/ai-os CLI: agent (init, run, tui, gateway, research, ...) or relay (`just ai-os relay serve`)
[group('ai-os')]
ai-os *args:
    bun run --cwd "{{root}}/frameworks/ai-os" src/cli.ts {{args}}

# @aphrody/ai-os tests (inside the package, never `bun test` from the root)
[group('ai-os')]
ai-os-test:
    bun --cwd "{{root}}/frameworks/ai-os" test

# Live relay E2E (service AphrodyRelay on 127.0.0.1:8790): protocols, hub MCP, skills, subagents, CLIs, hook guard; skipped if the relay is down
[group('ai-os')]
relay-e2e:
    bun test "{{root}}/frameworks/ai-os/test/relay/e2e.test.ts"

# Markdown skills archive for Gemini (var/skills-archive; --publish uploads to R2) and two-way Claude<->Gemini memory sync
[group('ai-os')]
skills-archive *args:
    bun "{{root}}/frameworks/ai-os/src/brain/skills-archive.ts" {{args}}
    bun "{{root}}/frameworks/ai-os/src/brain/memory-sync.ts"

# ai-os orchestrator (frameworks/ai-os/docs/ORCHESTRATOR.md): hosts, engines, health, run <workflow.json>, plan "<goal>", design, market
[group('ai-os')]
orch *args:
    bun run --cwd "{{root}}/frameworks/ai-os" src/cli.ts orch {{args}}

# NHITL index (frameworks/ai-os/src/nhitl, var/agents/nhitl.sqlite): scan [--only s] [--local] | list [--status open] | stats | set <id> <status> | login claude|codex
[group('ai-os')]
nhitl *args:
    bun run --cwd "{{root}}/frameworks/ai-os" src/cli.ts nhitl {{args}}

# Hourly NHITL rescan as a user scheduled task (no elevation); `schtasks /Delete /TN aphrody-nhitl-scan /F` removes it
[group('ai-os')]
[windows]
nhitl-schedule:
    schtasks /Create /F /SC HOURLY /TN aphrody-nhitl-scan /TR "conhost.exe --headless \"$(bun -e 'process.stdout.write(process.execPath)')\" run --cwd \"{{root}}/frameworks/ai-os\" src/cli.ts nhitl scan"

[group('ai-os')]
[unix]
nhitl-schedule:
    (crontab -l 2>/dev/null | grep -v 'nhitl scan'; echo "17 * * * * cd {{root}}/frameworks/ai-os && bun src/cli.ts nhitl scan --local >/dev/null 2>&1") | crontab -

# Unattended lifecycle: code, fmt, check, tests, judges, fix, docker on prd, deploy (dry-run unless --apply), monitor, optimize
[group('ai-os')]
lifecycle *args:
    bun run --cwd "{{root}}/frameworks/ai-os" src/cli.ts orch lifecycle {{args}}

# Three-voice review tribunal, no human (docs/reviews/README.md): Gemini + Claude in parallel, neutral judge decides;
# verdicts in docs/reviews/<voice>-<date>-<slug>.md + INDEX.md. Usage: just review <paths|diff|A..B|commit> [-- paths]
# [--voices gemini,claude,judge] [--threshold 16] [--fix] [--dry-run]. Arguments go through "$@", never interpolated.
[group('ai-os')]
[positional-arguments]
review *args:
    bun run --cwd "{{root}}/frameworks/ai-os" src/cli.ts review "$@"

# Windows service AphrodyRelay (elevated): exe = published artefact relay-service of .github/workflows/ai-os.yml
[group('ai-os')]
[windows]
relay-install exe:
    pwsh -NoProfile -File "{{root}}/frameworks/ai-os/native/relay-windows/install.ps1" -ServiceExe "{{exe}}"

# Linux user unit of the relay (prd and Linux hosts; source in device/fleet/prd/systemd)
[group('ai-os')]
[unix]
relay-install:
    install -Dm644 "{{root}}/device/fleet/prd/systemd/aphrody-relay.service" "$HOME/.config/systemd/user/aphrody-relay.service"
    systemctl --user daemon-reload
    systemctl --user enable --now aphrody-relay
    systemctl --user restart aphrody-relay

# LLM provider inventory, ai-os providers (frameworks/ai-os/src/providers/sources.toml) (usage: just ai-providers [--check])
[group('ai-os')]
ai-providers *args:
    bun "{{root}}/frameworks/ai-os/src/providers/cli.ts" {{args}}
