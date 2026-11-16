# Gemini review: agent tooling refactor (2026-11-14)

- Reviewer: Gemini, mode "Carbon High", gemini.google.com (owner session, via claude-in-chrome; the relay `gemini_review` failed with Antigravity `RESOURCE_EXHAUSTED 429`).
- Chat: https://gemini.google.com/app/299c488ff1de755c
- Scope: `git diff 9c7471dc 83716e40` on `tools/agents/toolchain.toml`, `system/machine-ts/src/{toolchain,relay-headers}.ts`, `frameworks/ai-os/src/relay/{mcp-hub,protocols,server}.ts`, `frameworks/ai-os/src/brain/cli.ts`.
- Score: **8/20**.

| # | Defect reported | Verdict | Outcome |
|---|---|---|---|
| 1 | Other agents get the relay URL without credentials; `[[mcpfile]]` rewrites the whole MCP key | Partly confirmed | Codex and OpenCode hold their own OAuth grant (OpenCode approved locally with the relay token); the exclusive rewrite is the intent. agy grant not verified. |
| 2a | JSONC comments lost, comment claimed "rest of file intact" | Confirmed | Manifest comment corrected. |
| 2a | `~/.gemini/settings.json` also written by `agy mcp` | Refuted | agy writes `~/.gemini/config/mcp_config.json`. |
| 2b | Missing file silently skipped | Refuted | Missing file means the agent is not installed. |
| 2c | Empty or `null` file crashes the applier | Confirmed | Parse guarded, `ERR` line reported. |
| 2d | Typo in `mcp = [...]` silently ignored | Confirmed | `info` line per unresolved name. |
| 3 | OpenCode and Pi lose skills they do not get from a plugin; cleanup could delete a manifest-managed skill | Confirmed | Their dirs removed from `link_dirs`; cleanup limited to skill directories not named in `[[claude.skill]]` or `[[skill.private]]`. |
| 4.1 | First sync overwrites a hand-written prompt file | Confirmed | Existing content kept, block appended; header only for an absent or empty file. |
| 4.2 | Pi prompt file missing | Confirmed | `~/.pi/agent/AGENTS.md` added. |
| 4.3 | Hard-coded `C:\aphrody` in the header | Confirmed | Repo root computed. |
| 4.4 | First run on a host without `~/.gemini` needs two passes | Confirmed, not fixed | Minor; second pass converges. |
| 5.1 | `/mcp/core` lists own tools only but still calls aggregated tools | Confirmed | `tools/call` refused with -32602, test added. |
| 5.2 | `in BUILTIN` | Confirmed | `Object.hasOwn`. |
| 5.3 | `rpc(mcpRpc)` may receive a second argument | Refuted | `dispatch` calls the handler with one argument. |
| 6 | `relay-headers.ts`: `process.exit` right after a write can truncate a Windows pipe | Confirmed | Awaited write, `process.exitCode`. Extracting `relayToken` to a leaf module: not done. |
| 7 | agy list parsing takes any first token; `remove` return codes ignored | Confirmed | Strict row filter, `ERR` on failure. |
| 8.1 | figma and cloudflare no longer forced absent on the Linux fleet | Confirmed | Explicit `absent` entries for prd, fr1, fr2. |
| 8.2 | `rea` entry pins a JDK patch path and has no install step | Confirmed, not fixed | Path mirrors the installed server; install step still to declare. |
