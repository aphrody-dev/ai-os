# Google Antigravity CLI (agy) reference (NHITL)

Verified 2026-11-13. Installed `1.5.7` (`agy --version`); `agy changelog` tops at `1.5.7`.

Sources: `agy --help`, `agy mcp --help`, `agy changelog` (1.5.7); REF = https://antigravity.google/docs/cli/reference ; HL = https://antigravity.google/docs/cli/headless ; GS = https://antigravity.google/docs/getting-started?tab=cli . Context7 and a GitHub repo for agy were not used: no official source repo located; no local mirror in C:\aphrody\third_party (fd).

## Settings

- File `~/.gemini/antigravity-cli/settings.json`. (REF, HL)
- `toolPermission` default `"request-review"`; values `request-review`, `proceed-in-sandbox` (falls back to request-review without sandbox), `always-proceed` (runs commands, web, MCP without prompting unless an ask/deny rule matches), `strict` (prompts before every action incl. reads). (REF)
- `always-proceed` auto-approves MCP tool calls and page reads; outside-workspace writes are no longer auto-approved by it. (changelog)
- `artifactReviewPolicy` default `"asks-for-review"`; values `asks-for-review`, `agent-decides` ("currently the same as asks-for-review"), `always-proceed` (never waits). (REF)
- `allowNonWorkspaceAccess` boolean default `false`; still subject to `toolPermission`. (REF)
- `trustedWorkspaces` string[] default `[]`: folders trusted when prompted. (REF)
- `historySize` integer default `2000`: prompt history entries; `-1` keeps all, `0` clears. (REF)
- `permissions.allow` rules, e.g. `"command(git)"`, `"command(regex:...)"`, `"write_file(src/)"`. (HL)
- `--settings`: session-only JSON of settings.json keys, never saved. (`agy --help`)

## Modes and flags

- `--mode accept-edits|auto|plan`; default mode `default`/`Agent`. Auto on Windows 11 24H2+ for personal Google accounts. (`agy --help`, changelog, GS)
- `--dangerously-skip-permissions`: auto-approve all tool requests; headless `permission_mode` becomes `always-proceed` (default `request-review`). (`agy --help`, HL)
- `--sandbox`: terminal restrictions. (`agy --help`)
- Headless: `-p/--print/--prompt`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--print-timeout` (0 = no limit), `-c/--continue`, `--conversation <id>`, `-i/--prompt-interactive`, `--disable-slash-commands`, `--add-dir`, `--model`, `--effort`. `--mode` in `-p` fixed in a recent release. (`agy --help`, HL, changelog)
- Subcommands: `acp`, `agents`, `changelog`, `install`, `mcp` (add/remove/list/enable/disable), `models`, `plugin`, `remote-control`, `update`. (`agy --help`, `agy mcp --help`)

## Hooks

- Shared hooks file is `~/.gemini/config/hooks.json`; `/hooks` formerly wrote to `~/.gemini/antigravity-cli/hooks.json` by mistake (fixed). Workspace hooks: `<workspace>/.agents/hooks.json`. Events seen: `PreToolUse`, `PostToolUse`, `Stop` (input has `continuation_active`, 1.5.6), `SessionStart`, `PostInvocation`. (changelog)

## MCP

- User-level `mcp_config.json`, migrated to `~/.gemini/config/mcp_config.json`; legacy path was `~/.gemini/antigravity-cli/mcp_config.json`. Accepts `//`, `/* */`, trailing commas, `url`, `enabledTools`, `timeoutSeconds`, `tools.eager`. Plugin servers namespaced `<plugin>_<server>`. (changelog)

## Rules / context files

- Global rules: `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md` and their `~/.gemini/config/` counterparts, plus `~/.gemini/config/rules/`; `GEMINI.md`/`AGENTS.md` rules override built-in instructions. (changelog)
- Workspace-level loading order of `GEMINI.md`/`AGENTS.md` not documented in the pages fetched: unverified.

## Sessions

- Local state in `~/.gemini/antigravity-cli/`: `conversations/`, `conversation_summaries.db`, `history.jsonl`, `log/`, `crashes/` (directory listing). No retention/cleanup key found besides `historySize` (REF).

## Local state vs docs (read-only check, ~/.gemini/antigravity-cli/)

- `toolPermission: "always-proceed"`: valid, NHITL. No conflict.
- `artifactReviewPolicy: "agent-decides"`: CONFLICT for NHITL; docs say it currently behaves as `asks-for-review` (waits). NHITL value is `always-proceed`.
- `allowNonWorkspaceAccess: true`: valid.
- `trustedWorkspaces`: 70 entries with duplicates and many removed paths (`C:\aphrody\bun`, `C:\aphrody\yolo-*`, ...), plus `C:\`.
- `hooks.json` sits in `~/.gemini/antigravity-cli/`, but the shared path is `~/.gemini/config/hooks.json` (absent locally): the pre-tool-guard hook likely does not load. Its matcher `run_command|write_file|edit_file` was not checked against current tool names.
- `mcp_config.json` exists in both `~/.gemini/antigravity-cli/` (legacy) and `~/.gemini/config/` (current).
