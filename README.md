# Sovereign AI Control Plane (`C:\src\ai-os`)

Unified Multi-Protocol AI Control Plane, Native `bun:ffi` Computer-Use Bus, Multi-Provider Inference Federation, and Real-Time/Nightly Standards Sentinel built in **100% pure `oven-sh/bun` v1.4.4** (`dependencies: {}`, `devDependencies: {}`).

## Architecture & Core Subsystems

1. **Exhaustive Code & Dependency Extractor (`src/extractor.ts`)**:
   - Extracts every direct and transitive Cargo crate, `package.json`, `pnpm-lock.yaml` package/snapshot, C-ABI symbol, and source module from `C:\src\agent-browser` (`v0.42.0`) and `C:\src\agent-desktop` (`v1.2.0`).
   - Generates `EXTRACTION_MANIFEST.json` and `COMPARISON_AND_INTEGRATION_MATRIX.md`.
2. **Native Fat-LTO Binaries & Zero-Copy FFI (`src/ffi/desktop.ts`)**:
   - `C:\Users\aphro\.local\bin\agent-desktop.exe` (Rust 2024 Fat-LTO CLI)
   - `C:\Users\aphro\.local\bin\agent_desktop_ffi.dll` (Rust 2024 Fat-LTO C-ABI v7 shared library loaded via `bun:ffi`)
   - `C:\Users\aphro\.local\bin\agent-browser.exe` (Rust CDP + `axe-core` a11y + WebGPU doctor Fat-LTO binary)
   - `C:\Users\aphro\.local\bin\ai-os.exe` (Standalone AOT Bun v1.4.4 control plane)
3. **Universal Protocol Router (`src/protocols/` & `src/server.ts`)**:
   - **OpenAI Spec**: `/v1/models`, `/v1/chat/completions` (JSON + SSE + Vercel DataStream `v1`), `/v1/responses`, `/v1/embeddings`, plus Open WebUI / Ollama bridge (`/api/version`, `/ollama/api/tags`).
   - **MCP (`2025-03-26`)**: `/mcp` Streamable HTTP + `ai-os mcp-stdio` JSON-RPC 2.0 exposing `desktop_snapshot`, `desktop_action`, `browser_navigate`, `browser_a11y_tree`, `monorepo_exec`, `sentinel_status`, and `skills_search`.
   - **A2A (Agent2Agent)**: `/.well-known/agent.json` Agent Card + `/` JSON-RPC (`tasks/send`, `tasks/get`, `tasks/cancel`, `tasks/sendSubscribe` SSE).
   - **ACP (Agent Client Protocol)**: `/acp` JSON-RPC 2.0 (`initialize`, `session/new`, `session/prompt`, `session/cancel`).
   - **Skills & Hooks Registry**: `/api/skills` and `/api/hooks` indexing `SKILL.md` and `hooks.json` across Google/DeepMind, Vercel-Labs, Anthropic, OpenCode, `agent-browser`, `agent-desktop`, and `C:\src\.agents`.
4. **Multi-Provider & Local Uncensored Federation (`src/providers/federation.ts`)**:
   - Connects local engines (`ring3-agent` `8787`, `Locally Uncensored` `8129`, `llama.cpp` `8081`/`8084`, `mistral.rs` `8080`, `vLLM` `8000`, `Ollama` `11434`, `Open WebUI` `3000`) and cloud APIs (Gemini, Claude, OpenAI / Vercel AI Gateway) with strict secret redaction (`src/env.ts`).
5. **Real-Time & Nightly Standards Sentinel (`src/sentinel/index.ts`)**:
   - Probes 25 live upstream feeds (WHATWG HTML/DOM/Fetch, W3C WebGPU, TC39, Linux `7.4-rc*` `kernel.org`, `uutils/coreutils`, Windows 11 Insiders, `windows-rs`, Chrome Win64 Canary vs `C:\src\bun-parity`, ChromiumOS, AOSP Android 17/18, MCP, A2A, ACP, Bun, OpenCode, Pi, Skills, `llama.cpp`, `Ollama`, `vLLM`, `Open WebUI`) backed by `sentinel.sqlite` (WAL).

## CLI Commands

```powershell
bun fmt --check
bun check
bun test
bun run build
ai-os serve --port 4318
ai-os nightly-sync
ai-os doctor
```
