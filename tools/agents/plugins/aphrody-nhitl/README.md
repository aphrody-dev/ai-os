# aphrody-nhitl

No human in the loop for Claude Code, through supported extension points only (plugin hooks,
user settings, headless CLI). claude.exe is never patched.

Claude Code runs with `bypassPermissions`. There is no deny-list engine: the only command guard is the
small Bash PreToolUse hook in `tools/agents/claude/settings.json` (coreutils redirection, shared-index
`git commit`, `git add -A`, `git stash`, staging `.env`, writes under `C:/Windows/System32`), synced by
`just agents-sync`. The boundary against damage is the OS: `runuser -u agent` on prd; on the Windows PC the
launcher can run Claude Code under WSL2 with the sandbox (see "OS boundary").

| Piece            | File                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                  |
| :--------------- | :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart     | `src/learn-auto.ts`    | Detached `/learn` at most once per 24 h.                                                                                                                                                                                                                                                                                                                                                  |
| Stop, SessionEnd | `src/learn-capture.ts` | Lesson capture to `~/.claude/learning/journal.jsonl`.                                                                                                                                                                                                                                                                                                                                     |
| Status line      | `src/statusline.ts`    | `nhitl · mode · model · agents n[/total] · ctx %`, wired in `~/.claude/settings.json`.                                                                                                                                                                                                                                                                                                    |
| Launcher         | `bin/claude-nhitl.ts`  | `claude -p` with `--permission-mode bypassPermissions --permission-prompts none --output-format stream-json --verbose`, `--session-id`/`--resume`/`--continue`, stream teed to `~/.claude/learning/runs/<sid>.jsonl`. As root, claude runs via `runuser -u $NHITL_RUN_AS` (default `agent`), never with `IS_SANDBOX`. `--help` for the runner contract. |

Tests: `bun test ./test` here (`bun test tools/agents/plugins/aphrody-nhitl` from the root). Install: `claude plugin marketplace add C:/aphrody` (root marketplace `.claude-plugin/marketplace.json`) then
`claude plugin install aphrody-nhitl@aphrody --scope user`; after edits bump `version` and run
`claude plugin marketplace update aphrody && claude plugin update aphrody-nhitl@aphrody`.

## OS boundary on the PC (judge N4, decided 2026-11-13)

Choice: route (a), `bin/claude-nhitl.ts --sandbox wsl` (default on Windows; `native` inside a Linux or
WSL shell; `off` elsewhere, prd keeps `runuser -u agent`). The launcher runs
`wsl.exe [-d distro] --cd /mnt/c/... --exec env NHITL_RUN=1 claude ... --settings <json>` (argv, no shell string).
The inline settings (`src/sandbox.ts`) set `sandbox.enabled`, `allowUnsandboxedCommands: false` (also makes
the sandbox admin-required, so repository settings cannot loosen it), `failIfUnavailable: true` (WSL1 or missing
bubblewrap = exit, never a silent unsandboxed run), `excludedCommands: []`, write access limited to `--cwd` and
`--add-dir`, `denyRead` on `.env*` (except `.env.example`), `~/.ssh`, `~/.aws`, gcloud and gh configs, and
`denyWrite` on `.git/hooks` and `.git/config` of those roots. No fallback: `--sandbox wsl` off Windows exits 2.

Measured (Linux 7.3, bubblewrap, the mechanism WSL2 uses; `test/launcher.test.ts`, skipped without bwrap):

| Probe                                     | Unsandboxed       | Sandboxed                            |
| ----------------------------------------- | ----------------- | ------------------------------------ |
| `bun -e rmSync(<file outside the roots>)` | file deleted      | file kept (read-only filesystem)     |
| `cat $(printf .en; printf v)`             | prints the secret | `Permission denied`, nothing printed |
| `bun -e`, `git init`/`commit`, `just`     | work              | work (write roots allow them)        |

Not measured: no Windows or WSL2 host was available to this run, so the end-to-end `wsl.exe` launch, `/mnt/c`
(drvfs) behavior of the bind mounts, and `just`/`bun test` timings under WSL2 are untested. First task on the PC:
`bun test ./test` then one `claude-nhitl --sandbox wsl "run the two probes"` and archive the result here.

Route (b), dedicated local account + ACL + Job Object, not retained:

- A Job Object bounds processes and memory, not file access; the file boundary rests on ACLs alone.
- Denying `%USERPROFILE%` to the account also denies what Claude Code, bun, git and gh need under their own profile
  paths; the account needs its own copies of every login (claude.ai, gh, gcloud), a second set of secrets to guard.
- `bun -e rmSync` inside the allowed tree (`C:\aphrody`) is still permitted: ACLs cannot separate it from legitimate
  edits, whereas the sandbox write roots plus `denyWrite` on `.git` can.
- Needs `icacls`, account creation and `kernel32` FFI (`CreateJobObjectW`), all unverifiable without Windows here.
  Reconsider only if WSL2 is unavailable on the PC; then ACL deny on secrets and protected `.git` is the minimum.

## Sources read (2026-11-13, Claude Code 2.1.322 installed)

- https://code.claude.com/docs/llms.txt (index)
- https://code.claude.com/docs/en/hooks.md: common input, exec form `command`+`args`, `onFailure`, PreToolUse `permissionDecision`, PermissionRequest `decision.behavior`, Stop `decision: "block"` and 8-continuation cap, SubagentStop input, SessionStart `additionalContext`, Notification types
- https://code.claude.com/docs/en/checkpointing.md: `/rewind` restores Edit/Write changes, not files only Bash changed
- https://code.claude.com/docs/en/permission-modes.md: actions no mode auto-approves, critical-path `rm` in `-p` runs
- https://code.claude.com/docs/en/permissions.md, https://code.claude.com/docs/en/settings-reference.md
- https://code.claude.com/docs/en/plugins/manifest-reference.md, https://code.claude.com/docs/en/plugins/marketplace-reference.md (`directory` source, relative `./` plugin source), https://code.claude.com/docs/en/plugins/cli-reference.md (`claude plugin validate`)
- https://code.claude.com/docs/en/statusline.md, https://code.claude.com/docs/en/headless.md (`--permission-prompts none`), https://code.claude.com/docs/en/cli-reference.md (`--session-id`, `--resume`), https://code.claude.com/docs/en/output-styles.md
- GitHub anthropics/claude-code@89eb88e335 (CHANGELOG 2.1.323), anthropics/skills@2c5958ecac (skills list)
