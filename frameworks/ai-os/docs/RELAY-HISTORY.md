# Relay history and target (frameworks/ai-os/src/relay)

Read on 2026-11-15. Sources: `git log` in this repository, files in the working tree, crates.io API, `bun info`, the agy summaries database. Where a fact was not read, the document says so.

## 1. Git history

### 1.1 Size and churn

- 29 tracked files, 6724 lines (`git ls-files`, `wc -l`, 2026-11-15).
- 49 commits touch the folder, all between 2026-11-13 and 2026-11-15 (`git log --follow`).
- First commit `f2df75e96` (2026-11-13, "one package @aphrody/ai-os, no npm dependency") adds 14 relay files and 2268 lines (`git show --stat f2df75e96`).
- Churn (lines added plus deleted, commits touching the file; `git log --numstat`):

| File             | Churn | Commits | Lines now |
| ---------------- | ----- | ------- | --------- |
| `oauth.ts`       | 3364  | 10      | 1032      |
| `a2a.ts`         | 1996  | 6       | 658       |
| `tools.ts`       | 1687  | 17      | 547       |
| `outbound.ts`    | 1597  | 5       | 515       |
| `protocols.ts`   | 1189  | 13      | 291       |
| `mcp-hub.ts`     | 1047  | 13      | n/a       |
| `agent-tools.ts` | 968   | 9       | 288       |
| `acp.ts`         | 908   | 6       | n/a       |

### 1.2 Timeline

- 2026-11-13: `f2df75e96` (one package, no npm dependency), `8c3c113aa` (Gemini review 11/20 and verdict), `4ec1814b2` (A2A 1.0 and ACP v1), `9e5aa5afc` (ACP engine per session), `197c77258` (orchestrator), `dd32870db` (embedded OAuth 2.1 server), `66f3ad1dc` (OAuth fixes from a Gemini review), `c40176d64` (loopback redirect port, RFC 8252).
- 2026-11-14: `b4bfc8671` (rea, agent-desktop and agent-browser reachable only through the hub), `83716e405`, `7f8ece096`, `98f70452c` (gnu hub server).
- 2026-11-15: `d02787c93` (session mailbox on bun:sqlite), `2943cbaa3` (e2e suite against the live relay), `3b7c8bd55` (hub headers read from env), `0150f70a3` and `ad585879b` (electron and py2bun hub tools), `7de1138b5` (comments translated to English), `2f58a39db` (registry MCP).

### 1.3 Fix-of-fix chains

- Error codes: `2886f1865` (a network error was returned as the JSON-RPC code) then `b04c0aa78` (an unknown tool returns -32602).
- Start-up on other hosts: `74c0c2c55` (the relay on prd started in failure) and `b5a0e3332` (`core-tools.ts` was imported but not tracked, so fresh checkouts failed to start).
- `83716e405`: the `/mcp/core` route was misplaced by a zero-context staging.
- `8985b1a04`: tree restored after `b38c8de7` and `f1cc9b32` were committed from an empty private index.
- No `git revert` in the folder log; failures were repaired forward.

### 1.4 Reviews

- Scores in commit messages: 11/20 (`8c3c113aa`), 14.5/20 (`c644c1d80`), 17.5/20 (`edcfb1232`), 8/20 (`07389c599`), 10/20 to 11/20 for a three-voice review (`c962371b5`, `051beebc7`).
- `frameworks/ai-os/docs/reviews/` holds only `brain-gemini.md`; the relay verdicts named in those commits are not archived there.

### 1.5 Origin

- `ab0521071` (2026-11-13) first brought the relay in (bridge Claude Code to Gemini over CDP, A2A, MCP).
- `LEGACY-INVENTORY.md:26` says four MCP servers were merged into the relay; the legacy sources are `aphrody-labs/src@5525822` and `aphrody-labs/agent@efa63bb` (`LEGACY-INVENTORY.md:37`).
- Paths from absorbed repos (labs, nt, tv, yolo): no rename found by `git log --diff-filter=R` for this folder.

## 2. Agent sessions

- Claude Code transcripts searched by commit hash: the hits are the sessions that investigated or used the relay later (mailbox commit `d02787c93` appears in session `8a42912e`); none shows which session wrote `f2df75e96` and the first relay commits. Not established.
- agy (`conversation_summaries.db`): 398 rows, 283 dated 2026-11-13 to 2026-11-15, none titled; no conversation could be matched to relay code.

## 3. Documents against code

Read: `frameworks/ai-os/docs/{RELAY,ARCHITECTURE,LEGACY-INVENTORY,ROADMAP}.md`. Not checked: ROUTER, MODEL_ROUTING, NHITL, ORCHESTRATOR, FUSION.

Claims the code does not back:

- `LEGACY-INVENTORY.md:26`: MCP through the "official SDK". The relay uses none; `src/relay/mcp-http.ts:2` says it replaces `@modelcontextprotocol/sdk`.
- `RELAY.md:3` and its commands use `src/relay`; the real path is `frameworks/ai-os/src/relay`.
- `RELAY.md:19`: `native/relay-windows/install.ps1` does not exist.
- `ARCHITECTURE.md:3` names `frameworks/agent/py`: absent.
- `ROADMAP.md:6` states a license, while `AGENTS.md` §4 says none is chosen.
- `ROADMAP.md:19` item 6 lists A2A, ACP and MCP over HTTP as future work; the relay already has them. `LEGACY-INVENTORY.md:35` places A2A/ACP in the gateway "(roadmap)".

Backed: `src/core/{cabi,agent,council,secrets,context}.ts`, `src/{llm,gateway,orch,fabric,brain,research,review,nhitl}`, `src/relay/hook.ts`, `device/fleet/prd/systemd/aphrody-relay.service`.

## 4. Current reality

- Protocols written by hand: MCP (2025-11-25 and 2026-07-28), A2A 1.0.1, ACP v1, OAuth 2.1, JSON-RPC over HTTP, WS, TCP and TLS (`RELAY.md:5-10`). No `@modelcontextprotocol/*` or `rmcp` dependency.
- Tests: no unit test in `relay/` except the hub MCP servers added later (`test/relay/registry-mcp.test.ts`, `unixwin-mcp.test.ts`); the live e2e suite is `2943cbaa3`. Coverage not measured.
- Service: `AphrodyRelay` runs `frameworks/ai-os/src/relay/cli.ts serve` from source (`CLAUDE.md`, Gotchas). Sessions regularly start with the relay MCP refused (ECONNREFUSED) while the service is up; not measured here.
- Ownership: model routing and inference moved to aphrody-labs/open (`crates/ai-router`, C ABI and service; `packages/ai-router`).
- Not measured yet: module coupling, dead code (`ay code refs`).

## 5. Target

Live versions (crates.io API and `bun info`, 2026-11-15):

| Crate or package                  | Version | Updated    |
| --------------------------------- | ------- | ---------- |
| `rmcp`                            | 3.10.0  | 2026-11-12 |
| `agent-client-protocol`           | 5.3.0   | 2026-11-14 |
| `russh`                           | 0.65.1  | 2026-11-03 |
| `gix`                             | 0.90.0  | 2026-10-22 |
| `chromiumoxide`                   | 0.9.1   | 2026-02-25 |
| `a2a-rs`                          | 0.10.5  | 2026-10-20 |
| `axum`                            | 0.8.9   | 2026-04-14 |
| `oauth2`                          | 5.0.0   | 2025-01-21 |
| `@modelcontextprotocol/sdk` (npm) | 1.32.2  | 2026-10-23 |

Rust already in src: `system/ay/src/{applet,plugin,sh}.rs`, `src/core/capi/src/ai_os.rs`, `system/remote`, `system/up`, `system/winux/*`. Their APIs are not reviewed in this document.

Scope: one Rust host that assembles the operating system's tools for agents. It exposes process, file system, shell (`ay sh`, rubash), git (`gix`), ssh (`russh`), browser (CDP), desktop (UIA on Windows), the session mailbox and the external MCP hub as MCP tools through `rmcp`. It speaks A2A through an A2A crate and ACP through `agent-client-protocol`. Model routing stays in aphrody-labs/open (`ai-router`); src keeps the host and the tools.

Migration, each step with its proof:

1. Baseline: measure the TS relay (p50 and p99 latency of `tools/list` and one tool call, resident memory, cold start) with `hyperfine` and `oha`. Proof: numbers archived here.
2. Mailbox and hub proxy in Rust on `rmcp`, behind the same `/mcp` routes. Proof: the e2e suite (`2943cbaa3`) passes against both, and the benchmark beats the baseline.
3. Tools one family at a time (process, fs, shell, git, ssh, CDP, UIA), reusing `system/ay` and `system/winux`. Proof: one test per tool plus the same e2e call.
4. A2A and ACP through the SDKs. Proof: conformance of the agent card and of the session methods in `RELAY.md:9-10`.
5. OAuth: replace the 1032-line `oauth.ts` with a maintained crate; the review fixes of `66f3ad1dc` become tests.
6. Delete each TS module after its proof; the service runs a built binary, not source.

Risks: UIA and CDP coverage in Rust, MCP spec drift, the `rmcp` 3.x API not yet read, and `chromiumoxide`'s last release dated 2026-02-25.
