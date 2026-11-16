# Sovereign Knowledge Engine (`@aphrody/knowledge-engine`)

<!-- catalog:begin unit -->

> Unified Context7 v2 + Multi-Hop Deep Research + Deterministic Fact-Checker + Monorepo Docs & Skills Generator + Continuous AGY Session Reviewer in pure Bun v1.4.4

| Type        | Path                                        |
| :---------- | :------------------------------------------ |
| Bun package | `frameworks/ai-os/engines/knowledge-engine` |

**Commands**

```sh
bun run --cwd frameworks/ai-os/engines/knowledge-engine research
bun run --cwd frameworks/ai-os/engines/knowledge-engine factcheck
bun run --cwd frameworks/ai-os/engines/knowledge-engine gen-docs
bun run --cwd frameworks/ai-os/engines/knowledge-engine gen-skills
bun run --cwd frameworks/ai-os/engines/knowledge-engine review-sessions
bun run --cwd frameworks/ai-os/engines/knowledge-engine watch
bun run --cwd frameworks/ai-os/engines/knowledge-engine mcp-stdio
bun run --cwd frameworks/ai-os/engines/knowledge-engine build
```

Part of Aphrody: [aphrody-labs/ay](../../../../README.md), [Catalog](../../../../docs/reference/catalog/package.md).
<!-- catalog:end -->

Unified **Context7 v2 + 5-Channel Deep Research + Deterministic Fact-Checker + Monorepo Docs & Skills Generator + Continuous AGY Session Reviewer** built in 100% pure **Bun v1.4.4** (`bun:sqlite` WAL + `bun:ffi` `rust_stack_ffi.dll` Blake3).

## Binaries & Shims (`%USERPROFILE%\.local\bin`)

- `ske.exe` — Standalone AOT-compiled Bun executable (`bun build --compile --minify`).
- `ske.cmd` / `knowledge-engine.cmd` — Userland CLI entrypoints.
- `ske mcp-stdio` — Native MCP `2025-03-26` stdio server registered across Antigravity CLI, Gemini CLI, Codex, Claude Code, OpenCode, and Zed.

## Modules

1. [`src/context7/client.ts`](file:///C:/aphrody/frameworks/ai-os/engines/knowledge-engine/src/context7/client.ts): Context7 v2 `/libs/search` and `/context` client cached in `C:\aphrody\var\knowledge.sqlite` (`context7_cache` keyed by `rs_blake3_hex`, 24h TTL).
2. [`src/research/deep-research.ts`](file:///C:/aphrody/frameworks/ai-os/engines/knowledge-engine/src/research/deep-research.ts): Parallel 5-channel Deep Research across Context7, Exa Neural Search, GitHub Live API, Kernel.org/Freedesktop GitLab, and local `C:\aphrody` lockfiles -> `C:\aphrody\docs\research\<slug>.md`.
3. [`src/factcheck/verifier.ts`](file:///C:/aphrody/frameworks/ai-os/engines/knowledge-engine/src/factcheck/verifier.ts): Deterministic multi-evidence Fact Checker over local paths, `~/.local/bin` binaries, lockfile versions, GitHub repos, Context7 API symbols, secret hygiene, `C:\Windows\System32` non-mutation, and zero-emoji compliance.
4. [`src/generators/docs-gen.ts`](file:///C:/aphrody/frameworks/ai-os/engines/knowledge-engine/src/generators/docs-gen.ts) & [`src/generators/skills-gen.ts`](file:///C:/aphrody/frameworks/ai-os/engines/knowledge-engine/src/generators/skills-gen.ts): Generates `C:\aphrody\docs\MONOREPO_ATLAS.md`, `C:\aphrody\third_party\bun\docs\sovereign\index.mdx`, and the 5 sovereign `SKILL.md` workspace skills.
5. [`src/reviewer/agy-session-auditor.ts`](file:///C:/aphrody/frameworks/ai-os/engines/knowledge-engine/src/reviewer/agy-session-auditor.ts): Incremental `< 30ms` auditor over all `brain/*/transcript.jsonl` sessions + continuous `ske watch` daemon.
6. [`src/mcp/stdio.ts`](file:///C:/aphrody/frameworks/ai-os/engines/knowledge-engine/src/mcp/stdio.ts): MCP `2025-03-26` server exposing `ctx7_query_docs`, `deep_research`, `fact_check`, `generate_docs_and_skills`, `review_agy_sessions`, and `knowledge_status`.
