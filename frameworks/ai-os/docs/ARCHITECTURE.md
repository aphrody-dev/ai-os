# Architecture (`@aphrody/ai-os`)

Cross-platform sandboxed Unix/GNU-like OS distribution for autonomous agents. Workspaces: Bun (`frameworks/ai-os`), Rust 2024 (`src/core/capi`, `frameworks/agent/context`, `frameworks/agent/py`, `system/posix/omarchy`), Python `uv` (`frameworks/ai-os/python`). Native code compiles with the shared Chromium LLVM 24 toolchain on `fr1`/CI, never on the workstation.

## Layers

```
 L6 protocols  Relay (MCP 2026-07-28 + 2025-11-25, A2A 1.0.1, ACP 1.31.0, OAuth 2.1) | Gateway (OpenAI, UIMessageStream v7)
 L5 agent-os   POSIX/FHS VFS (/etc/ai-os, /var/lib/ai-os, /proc/agent, /dev/{llm,rag,world,sys1}) | orch | brain | review | nhitl
 L4 cognition  System 1 fast-path (<1ms policy router) <-> Causal World Model (surprise) <-> System 2 LLM + multi-head Context RAG
 L3 userland   OverlaySandbox / wasmsh -> rubash + niubash 1.5.0 + yash-rs + uutils/coreutils + WinuxCmd (Windows NT + Linux)
 L2 sandbox    litebox (Library OS Win32+Linux) | hyperlight (WHP/KVM micro-VM ~1-2ms) | wasmtime + cap-std | Landlock/JobObjects
 L1 inference  fabric (llama.cpp v1.0 RPC WireGuard) | mistralrs 0.8 | ort 2.0-rc.15 | burn 0.23 + cubecl | cloud gateways
 L0 c-abi      aphrody_core_capi (include/aphrody_core.h: core_* + ai_os_*) loaded via bun:ffi / pyo3 / C23 ThinLTO
```

## Active Subsystems (`frameworks/ai-os/src`)

| Subsystem                      | Path                                                                                            | Status & Scope                                                                                                                                                         |
| :----------------------------- | :---------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified C ABI & FHS VFS        | `src/core/cabi.ts` + `src/core/capi/src/ai_os.rs`                                               | `ai_os_uname_json`, `ai_os_vfs_resolve_json`, `ai_os_llm_spec_json`, `ai_os_rag_*`, `ai_os_world_*`, `ai_os_sys1_decide_json`                                          |
| Core runtime & sandbox         | `src/core/{agent,context,memory,sandbox,shell,skills,skill-lint,council,secrets,home,tools}.ts` | Multi-step tool loop, `OverlaySandbox`, `runSandboxedJs`, `runJustBash`, FTS5+semantic+structural+recency `Context`                                                    |
| Runtime LLM bridge             | `src/llm`                                                                                       | Zero hardcoded models; discovers `openai`, `anthropic`, `google`, `openrouter`, `huggingface`, `vercel`, `cloudflare`, `ollama`, `fabric`, `agy`, `claude`, `opencode` |
| Protocol relay                 | `src/relay`                                                                                     | HTTP/WS/TCP/TLS/stdio: MCP `2026-07-28` (`server/discover`) + `2025-11-25`, A2A `1.0.1`, ACP `1.31.0`, OAuth 2.1, outbound singleflight cache                          |
| Gateway                        | `src/gateway`                                                                                   | OpenAI `/v1/chat/completions`, Vercel AI SDK v7 `UIMessageStream`, JSON Patch UI specs, channel webhooks                                                               |
| Orchestrator & Fabric          | `src/orch`, `src/fabric`                                                                        | Fleet routing (`fr1`, `prd`, `fr2`), distributed `llama-server` RPC over WireGuard                                                                                     |
| Brain, Research, Review, NHITL | `src/brain`, `src/research`, `src/review`, `src/nhitl`                                          | Memory sync/zstd archive, Context7 v2 + fact-check, multi-voice tribunal, NHITL scanner                                                                                |
| Google Cloud Agents            | `src/google/{jules,stitch}`                                                                     | Absorbed Jules API and Stitch MCP clients                                                                                                                              |

> Purged modules (delegated to host CLIs `agy`, Claude Code, OpenCode, or upstream tools): `src/tui`, `src/core/pm.ts`, `src/core/hub.ts`, `src/core/scheduler.ts`, `src/core/lattice.ts`, `src/relay/portless.ts`, `native/fx`, and fake `crates/ring3-agent`.

## Context (Multi-Head Retrieval)

Module `src/core/context.ts` + Rust `frameworks/agent/context` (shared SQLite WAL schema `entries`, `entries_fts`, `kv`).

| Stage               | Implementation                                                                                                                    |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------- |
| Encoder             | `Context.ingest`: memories, `SKILL.md`, research results, `MEMORY.md`, code symbol chunks                                         |
| Multi-head scoring  | Parallel heads: lexical (FTS5 `bm25`), semantic (cached embeddings), structural (symbol overlap), recency (exponential half-life) |
| Masking & Redaction | Scope allowlist + predicate applied before `LIMIT` (no starvation); `redactText` strips secrets on output                         |
| Fusion              | Weighted RRF (`k = 60`, default weights: lexical `0.2`, semantic `0.7`, structural `0.05`, recency `0.05`)                        |

Retrieval benchmark (`bun bench/retrieval.ts`, 39 entries, 30 queries):

| Embedder              | Head Config         | P@1   | R@5               | MRR   | ms/query             |
| :-------------------- | :------------------ | :---- | :---------------- | :---- | :------------------- |
| `hash512`             | lexical             | 0.200 | 0.533             | 0.343 | 1.4                  |
| `bge-m3` (Workers AI) | semantic            | 0.200 | 0.800             | 0.423 | 228 cold / ~2 cached |
| `bge-m3` (Workers AI) | tuned RRF (0.2/0.8) | -     | 0.867 (0.800 LOO) | -     | 2.5                  |
