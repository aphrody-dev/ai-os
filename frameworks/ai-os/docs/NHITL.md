# NHITL index

Owner rule: do everything else that remains to be done before a summary; a pause, a final question or an action left to the owner violates NHITL (no human in the loop). Everything that violates it is indexed here.

## Commands

| Command                                                                                                                | Effect                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ai-os nhitl scan [--only transcript,settings,code,queue,docs,hook,ledger] [--local]`                                  | reproducible rescan, JSON (counts per source and per category) |
| `ai-os nhitl list [--source S] [--category C] [--status open\|fixed\|inevitable] [--severity S] [--q fts] [--limit N]` | entries, human triage included                                 |
| `ai-os nhitl stats`                                                                                                    | counts per category and status, last scan per source           |
| `ai-os nhitl set <id> <status> [--reason …]`                                                                           | human triage, kept from one scan to the next                   |
| `ai-os nhitl login claude\|codex [--hosts prd,fr2]`                                                                    | login of the runner CLIs without input by the agent            |
| `ai-os orch queue [--host H]`                                                                                          | queued tasks and estimated tokens of their prompts             |

Recipes: `just nhitl <args>`, `just nhitl-schedule` (hourly scheduled task `aphrody-nhitl-scan` on Windows, crontab on Unix).

## Database

`<src>/var/agents/nhitl.sqlite` (`NHITL_DB` takes precedence): table `violation` (source, location, category, severity, excerpt, fix, status, reason), FTS5 `violation_fts`, `triage` (statuses set by hand), `unit_cache` (unchanged transcripts not reread), `scan` (log). Excerpts limited to 160 characters and redacted (token patterns, values of sensitive variables).

## Sources

| Source     | Read                                                                                                   | Categories                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| transcript | `~/.claude/projects/*/*.jsonl`, last text of each turn of the main agent                               | `passive_wait`, `owner_todo`, `conditional_offer`, `final_question`                                             |
| settings   | `.claude/settings*.json` (user, src, projects of `~/.claude.json`), agy (CLI, `config.json`), opencode | `settings_deny`, `settings_confirm`                                                                             |
| code       | src outside `third_party`, tests and docs (`rg --pcre2`)                                               | `interactive_prompt`, `owner_approval`, `endless_wait`, `browser_login`, `missing_noninteractive`               |
| queue      | `var/agents` of the PC, of prd (fr2 bounce over the mesh) and of fr2                                   | `queue_failed`, `queue_failed_auth`, `queue_requeued_auth`, `owner_approval`, `held_effect`, `host_unreachable` |
| docs       | `*.md` outside `third_party`                                                                           | `doc_manual_action` (archived reports: inevitable)                                                              |
| hook       | `~/.claude/learning/nhitl.jsonl` (aphrody-nhitl plugin)                                                | `hook_deny`, `hook_confirm`                                                                                     |
| ledger     | `src/nhitl/ledger.json`, items recorded by hand with their cause                                       | free                                                                                                            |

Status `inevitable` is reserved for guardrails (secrets, system), external effects held by contract (`owner-rules`), web interface confirmations meant for end users, and physical gestures of the owner (UAC, passkey, mobile app).
