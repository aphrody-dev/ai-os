# AI-OS Objective Ecosystem & Language Benchmark Report

- **Generated At**: `2026-11-11T02:11:01.734Z`
- **Selection Law**: Tier-1 Rust 2024 + Vercel/Bun TypeScript first; promote Tier-2 (CUDA sm_89, Zig, Python uv/JAX, Go) strictly when empirically >15% superior.
- **Runtime**: `Bun v1.4.4` (`win32/x64`)

## 1. Empirical Compute & OS Benchmarks

| Workload             | Candidate                                                      | Language                 | Tier                       | WASM/WebGPU Portable | Median Latency (us) | Throughput (ops/s) |
| -------------------- | -------------------------------------------------------------- | ------------------------ | -------------------------- | -------------------- | ------------------: | -----------------: |
| `cosine_rag_1024x32` | Bun v1.4.4 TypeScript Float32Array                             | TypeScript (Bun/Vercel)  | `tier1-rust-bun`           | Yes                  |                53.7 |              18622 |
| `cosine_rag_1024x32` | Rust wasm32-unknown-unknown (4673 B)                           | Rust (WASM32)            | `tier1-rust-bun`           | Yes                  |                41.5 |              24096 |
| `cosine_rag_1024x32` | Zig ReleaseFast wasm32 (7775 B)                                | Zig (WASM32)             | `tier2-proven-accelerator` | Yes                  |                42.6 |              23474 |
| `cosine_rag_1024x32` | Rust Native AVX2+FMA3 bun:ffi (sovereign_polyglot_ffi.dll)     | Rust Native              | `tier1-rust-bun`           | Host Native          |                13.7 |              72993 |
| `cosine_rag_1024x32` | C++/CUDA 13.4 sm_89 (NVIDIA GeForce RTX 4070)                  | CUDA C++ (sm_89)         | `tier2-proven-accelerator` | Host Native          |                1.41 |             709220 |
| `hash_32kb`          | Bun Native CryptoHasher SHA-256 (Rust/BoringSSL)               | TypeScript (Bun Native)  | `tier1-rust-bun`           | Host Native          |                13.4 |              74627 |
| `hash_32kb`          | Rust WASM32 FNV-1a 64-bit                                      | Rust (WASM32)            | `tier1-rust-bun`           | Yes                  |                26.9 |              37175 |
| `hash_32kb`          | Zig WASM32 FNV-1a 64-bit                                       | Zig (WASM32)             | `tier2-proven-accelerator` | Yes                  |                26.7 |              37453 |
| `posix_pipeline`     | AiPosixOs In-Memory VFS + WASM Glob (just-bash + uutils style) | TypeScript + Rust WASM32 | `tier1-rust-bun`           | Yes                  |                14.3 |              69930 |
| `decision_routing`   | System-1 Deterministic/BitNet Transducer (Rust + Bun)          | Rust + TypeScript        | `tier1-rust-bun`           | Yes                  |                69.5 |              14388 |

## 2. Objective Winners per Workload

- **`cosine_rag_1024x32`**: Fastest = **C++/CUDA 13.4 sm_89 (NVIDIA GeForce RTX 4070) (1.41 us)** | Portable Winner = **Rust wasm32-unknown-unknown (4673 B) (41.5 us)** | Decision = _Promote Tier-2 (C++/CUDA 13.4 sm_89 (NVIDIA GeForce RTX 4070)) -> 9.72x faster than Tier-1_
- **`hash_32kb`**: Fastest = **Bun Native CryptoHasher SHA-256 (Rust/BoringSSL) (13.4 us)** | Portable Winner = **Zig WASM32 FNV-1a 64-bit (26.7 us)** | Decision = _Keep Tier-1 (Bun Native CryptoHasher SHA-256 (Rust/BoringSSL))_
- **`posix_pipeline`**: Fastest = **AiPosixOs In-Memory VFS + WASM Glob (just-bash + uutils style) (14.3 us)** | Portable Winner = **AiPosixOs In-Memory VFS + WASM Glob (just-bash + uutils style) (14.3 us)** | Decision = _Keep Tier-1 (AiPosixOs In-Memory VFS + WASM Glob (just-bash + uutils style))_
- **`decision_routing`**: Fastest = **System-1 Deterministic/BitNet Transducer (Rust + Bun) (69.5 us)** | Portable Winner = **System-1 Deterministic/BitNet Transducer (Rust + Bun) (69.5 us)** | Decision = _Keep Tier-1 (System-1 Deterministic/BitNet Transducer (Rust + Bun))_

## 3. Pareto LLM & Decision Model Routing Matrix

| Provider                | Ecosystem                                                      | Latency (ms) | $/1M Input |   Context | Local Privacy | Objective Role                                                                             |
| ----------------------- | -------------------------------------------------------------- | -----------: | ---------: | --------: | ------------- | ------------------------------------------------------------------------------------------ |
| `ai-os/system1-bun`     | Sovereign Rust + Bun System-1                                  |         0.07 |      $0.00 |    32 768 | Yes           | Sub-ms POSIX/MCP tool dispatch & JSON transduction (0 VRAM)                                |
| `gemma-4-local-sm89`    | Google DeepMind Gemma 4 + llama.cpp / Ring-3 CUDA sm_89        |         7.33 |      $0.02 |   128 000 | Yes           | 24/7 autonomous local multimodal/uncensored coding & NotebookLM synthesis on RTX 4070 12GB |
| `vertex-gemini-keyless` | Google Cloud Vertex AI / AI Ultra (Gemini 2.5 Flash & 3.1 Pro) |          320 |      $0.15 | 1 048 576 | Cloud         | 1M+ context repository digestion, live Google Search grounding & multimodal video/audio    |
| `anthropic-claude`      | Anthropic Claude (Opus / Sonnet via Triad)                     |            0 |      $3.00 |   200 000 | Cloud         | Deep architectural verification & multi-file refactoring                                   |
| `openai-codex`          | OpenAI Responses / Codex CLI (via Triad)                       |            0 |      $2.50 |   200 000 | Cloud         | Algorithmic verification & Council consensus tie-breaker                                   |
