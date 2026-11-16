# @aphrody/ai-os

<!-- catalog:begin unit -->
<!-- prettier-ignore-start -->
> Aphrody AI OS: Unix/GNU-like agent OS distribution unifying LLM, RAG, World Model, and System 1 decision under one C ABI (aphrody_core_capi)

| Type | Path |
| :-- | :-- |
| Bun package | `frameworks/ai-os` |

**Commands**

```sh
bun run --cwd frameworks/ai-os test
bun run --cwd frameworks/ai-os check
bun run --cwd frameworks/ai-os relay
```

Part of Aphrody: [aphrody-labs/ay](../../README.md), [Catalog](../../docs/reference/catalog/package.md).
<!-- prettier-ignore-end -->
<!-- catalog:end -->

Cross-platform sandboxed Unix/GNU-like operating system distribution for autonomous agents, unifying POSIX/FHS VFS, LLM runtime discovery, hybrid RAG, causal World Model, and sub-millisecond System 1 decision routing behind **one single C ABI** (`ai_os_*` in [src/core/capi](../../system/core/capi), header [aphrody_core.h](../../system/core/capi/include/aphrody_core.h)).

`@aphrody/ai-os` is an agent kernel and runtime distribution, not a TUI, package manager, or cron wrapper (those belong to host agent harnesses such as `agy`, Claude Code, and OpenCode). Zero third-party npm dependencies (`bun:ffi`, `bun:sqlite`, `Bun.serve`, `Bun.listen`, `Bun.spawn`, `fetch`).

## FHS Virtual Layout & Unified C ABI (`ai_os_*`)

| VFS / Device  | C ABI Entrypoint (`aphrody_core.h`)               | Role                                                                                                                                                                                                                            |
| :------------ | :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uname` / FHS | `ai_os_uname_json`, `ai_os_vfs_resolve_json`      | OS identity, standards (`openapi-3.2.1`, `mcp-2026-07-28`, `a2a-1.0.1`, `acp-1.31.0`, `vercel-ai-sdk-7.0`, `cloudflare-agents-0.33`), confined FHS paths (`/etc/ai-os`, `/var/lib/ai-os`, `/home/agent`, `/proc/agent`, `/tmp`) |
| `/dev/llm`    | `ai_os_llm_spec_json`                             | Runtime-discovered multi-provider LLM wire contract (zero hardcoded models)                                                                                                                                                     |
| `/dev/rag`    | `ai_os_rag_upsert_json`, `ai_os_rag_query_json`   | Shared SQLite WAL + FTS5 BM25 + recency RRF store (`frameworks/agent/context`)                                                                                                                                                  |
| `/dev/world`  | `ai_os_world_step_json`, `ai_os_world_state_json` | Persistent causal state transitions (`world_entities`, `world_transitions`) + prediction error (`surprise`)                                                                                                                     |
| `/dev/sys1`   | `ai_os_sys1_decide_json`                          | Sub-millisecond (`< 1 ms`) System 1 router (`exec` / `escalate_sys2` / `deny`) with SQLite audit trail (`sys1_decisions`)                                                                                                       |

## Subsystems

| Path                   | Export                | Role                                                                                                                                                                                                           |
| :--------------------- | :-------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core`             | `./core`              | Unified C ABI bridge (`cabi.ts`), agent loop, confined tools, `OverlaySandbox` / `runSandboxedJs`, `runJustBash`, `Context` multi-head selection, `Memory`, `Skills`, `council`, secret redaction              |
| `src/llm`              | `./llm`               | Runtime provider & model discovery (`openai`, `anthropic`, `google`, `openrouter`, `huggingface`, `vercel`, `cloudflare`, `ollama`, `fabric`, `RELAY_OPENAI_ENDPOINTS`, plus CLIs `agy`, `claude`, `opencode`) |
| `src/relay`            | `./relay`             | Unified protocol daemon over HTTP/WS/TCP/TLS/stdio: MCP (`2026-07-28` stateless `server/discover` + `2025-11-25`), A2A `1.0.1`, ACP `schema-v1.31.0`, OAuth 2.1 PKCE/DCR/Device                                |
| `src/gateway`          | `./gateway`           | OpenAI-compatible `/v1/chat/completions`, Vercel AI SDK v7 `UIMessageStream` SSE, WebSocket sessions, channel webhooks                                                                                         |
| `src/orch`             | -                     | Fleet orchestrator (`fr1` build/training, `prd` production, `fr2` edge), health, task classification & lifecycle                                                                                               |
| `src/fabric`           | -                     | Distributed `llama-server` + WireGuard RPC tensor-split inference fabric (`tools/ai/fabric.toml`)                                                                                                              |
| `src/brain`            | -                     | Cross-agent memory absorption, zstd cold-transcript packing, and `CLAUDE.md` / `GEMINI.md` brain sync                                                                                                          |
| `src/research`         | `./research`          | Parallel outline research, deterministic fact-checking, Context7 v2 client                                                                                                                                     |
| `src/review`           | -                     | Multi-engine tribunal review & NHITL scoring                                                                                                                                                                   |
| `src/nhitl`            | -                     | No-Human-In-The-Loop ledger & violation scanner                                                                                                                                                                |
| `src/google`           | `./jules`, `./stitch` | Absorbed Google Jules (`jules.googleapis.com/v1alpha`) and Stitch MCP clients                                                                                                                                  |
| `python`               | -                     | `uv` workspace: `pyo3` bridge `agent_core` (`frameworks/agent/context`, feature `python`) + Hermes memory provider                                                                                             |
| `native/relay-windows` | -                     | Windows service `AphrodyRelay` (.NET 11 NativeAOT)                                                                                                                                                             |

## Verification & Usage

```sh
bun test test                                   # run from frameworks/ai-os (124 pass, 0 fail)
bun src/cli.ts run "summarize README.md"        # headless agent run on discovered model
bun src/cli.ts relay serve                      # serve /rpc /mcp /a2a /ws + TCP/TLS
bun src/cli.ts orch health                      # fleet & engine health
```

## Architecture & Research References

- docs/ARCHITECTURE.md — Layered Agent OS architecture, C ABI contract, and `Context` retrieval metrics.
- ../../docs/research/ai-os-stack-factcheck.md — November 2026 Context7 + GitHub/npm/crates.io deterministic fact-check (`100/100`).

License: MIT OR Apache-2.0. Third-party notices in `NOTICE` and `licenses/`.
