# Claude Code CLI reference (NHITL)

Verified 2026-11-13. Installed `2.1.322 (Claude Code)` (`claude --version`). Upstream CHANGELOG head is `2.1.323` (anthropics/claude-code `CHANGELOG.md` at 89eb88e3357be13ae7fcf8966144ad32f44def33): local install is one release behind.

Sources: `claude --help` (2.1.322); CS = https://code.claude.com/docs/en/settings ; SR = https://code.claude.com/docs/en/settings-reference.md ; MEM = https://code.claude.com/docs/en/memory.md ; CL = CHANGELOG.md@89eb88e.

## Settings files

- User `~/.claude/settings.json`; shared project `.claude/settings.json`; project local `.claude/settings.local.json`; managed `managed-settings.json`/MDM/server. (CS)
- Precedence high to low: managed, `--settings`, project local, shared project, user. Lists such as `permissions.allow` merge. (CS)
- On Windows `~/.claude` = `%USERPROFILE%\.claude`; relocate with `CLAUDE_CONFIG_DIR`. `~/.claude.json` holds account, MCP servers, per-project trust. (CS)
- Strict JSON: comments or trailing commas are a Settings Error. `-p` skips broken files silently; check with `claude doctor`. (CS)
- Edits to `permissions`, `hooks` reload live; `model`, `effortLevel` only at session start. (CS)

## Permission modes

- `--permission-mode` choices: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`. (`claude --help`)
- `"manual"` is an alias for `"default"`. (SR, CL)
- `permissions.defaultMode` `auto` and `bypassPermissions` are ignored from project or local settings since v2.1.257; set them in `~/.claude/settings.json` or pass `--permission-mode`. (SR, CS, CL)
- `skipDangerousModePermissionPrompt`: scope user, local, managed, `--settings`; background sessions count only user and managed; default unset (dialog shown). (SR)
- `disableBypassPermissionsMode`: any file, forbids bypass. (SR index)
- Unset defaultMode: interactive terminal and VS Code sessions start in auto mode. (CL)
- If auto mode is unavailable, `--permission-mode auto`/`defaultMode: auto` now starts in Manual. (CL 2.1.323)
- Flags: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--allowedTools`, `--permission-prompts host|none` (with `--print`; `none` = denied automatically). (`claude --help`)
- `permissions.denyInsteadOfPrompting` (v2.1.319+), `permissions.blockWritesOutsideWorkingDirectories` (v2.1.314+), `permissions.blockReadsOutsideWorkingDirectories` (v2.1.257+): `true` honored over managed. (CS)

## Headless

- `-p/--print`, `--output-format text|json|stream-json`, `--input-format`, `--include-hook-events`, `--no-session-persistence` (print only), `-c/--continue`, `-r/--resume`, `--session-id <uuid>`, `--fork-session`, `--bg/--background`, `--bare` (skips hooks, plugins, CLAUDE.md dirs unless passed), `--settings`, `--setting-sources`, `--mcp-config`, `--strict-mcp-config`. (`claude --help`)
- Subcommands: `agents`, `attach`, `auth`, `auto-mode`, `doctor`, `mcp`, `plugin`, `purge` (delete a project's Claude Code data), `rm`, `stop`, `logs`, `setup-token`, `update`. (`claude --help`)

## Hooks

- Key `hooks` in any settings file; `disableAllHooks` turns off hooks, status line, `@` suggestion command. (SR index)
- `ConfigChange` hook fires on direct settings file edits. (CS)

## MCP

- MCP servers live in `~/.claude.json` (user/local) and `.mcp.json` (project); `--mcp-config` adds files. (CS; `claude --help`)

## Memory / context files

- `~/.claude/CLAUDE.md` (user), `./CLAUDE.md` or `./.claude/CLAUDE.md` (project), `./CLAUDE.local.md` (local), `.claude/rules/`. Ancestors load at launch, subdirectories on demand. (MEM)
- `AGENTS.md` is read only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working dir or above; `~/.claude/CLAUDE.md` and rules still load alongside. Toggle under "Project instructions" in `/config`. (MEM, CL)

## Sessions and cleanup

- `cleanupPeriodDays`: any file, default `30`; transcripts of Desktop/Cowork sessions kept past it since v2.1.248. (SR)
- Sweep also covers `~/.claude/tasks/`, `~/.claude/shell-snapshots/`, `~/.claude/backups/`, `cc-daemon-*` temp folders; `skills/.trash`, `plugins/.trash` capped near 1024 entries. (CL)

## Local state vs docs (`~/.claude/settings.json`, read-only check)

- `permissions.defaultMode: "bypassPermissions"` and `skipDangerousModePermissionPrompt: true` sit in user settings: honored (SR). No conflict.
- `cleanupPeriodDays` is not set locally: default 30 days applies (SR).
- C:\aphrody has `CLAUDE.md`, so `AGENTS.md` is NOT auto-loaded (MEM); `.agents/SOUL.md` and `AGENTS.md` reach the model only via explicit reads or `@` imports. Conflict with the claim in CLAUDE.md that AGENTS.md is the canonical contract.
