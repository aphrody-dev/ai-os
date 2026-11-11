# Sovereign AI-OS Vendor Distillation & Stack Selection Matrix

## 1. Selection Law (Rust & Vercel/Bun TypeScript First -> Empirical Promotion)

1. **Tier 1 (Default Mandatory)**: **Rust 2024 (`Cargo` + `wasm32-unknown-unknown`)** and **TypeScript (`Bun v1.4.4` + Vercel Edge/WebGPU compatible)** with zero npm bloat.
2. **Tier 2 (Promoted ONLY when empirically faster/better)**:

- **C/C++ CUDA 13.4 `sm_89`** (`sovereign_cuda_sm89.dll`, `llama.cpp`, `transcribe.cpp`): Promoted for dense/quantized GPU tensor compute (`> 15x` over CPU).
- **Zig `-O ReleaseFast`**: Promoted for freestanding zero-libc WASM/C-ABI shims (7.7 KB WASM binary).
- **Python `uv` + PyO3**: Promoted strictly for JAX/Optax/Tunix DeepMind research notebooks.
- **Go 1.27**: Promoted strictly for OCI/WireGuard/MASQUE mesh (`infra_go.dll`, `src-deploy`).
- **.NET 10/11 NativeAOT**: Promoted strictly when bridging Windows WinUI / `hostfxr` assemblies (`n2b_dotnet`).

## 2. Distilled Vendor Ecosystems (Vendor -> Docs + Refs + Manifests + Skills)

- **Vercel & Vercel-Labs** (`third_party/labs`): Distilled into `src/protocols/fusion-specs.ts` (Vercel UIMessageStream v1 SSE) and `src/posix/unix-os.ts` (`just-bash` virtual POSIX shell).
- **Google DeepMind & Google** (`third_party/google-ecosystem`): Distilled into keyless Vertex AI grounding, A2A JSON-RPC, Gemma 4 chat/RMSNorm kernels, and progressive-disclosure skill packs.
- **OpenAI & Llama/ggml** (`third_party/ai-ecosystem`): Distilled into `/v1/chat/completions`, `/v1/responses`, GGUF binary header parser, and `llama-server` / `r3d` federation.
- **Microsoft, Cloudflare & uutils** (`third_party/microsoft`, `third_party/cloudflare`, `crates/unix`): Distilled into `AiPosixOs` (`litebox` capability mounts + `uutils` coreutils + `workerd` WASM/WebGPU edge compatibility).

## 3. Complete Scan of `github.com/aphrody-dev` (39 Repositories)

| Repository                          | Domain             | Primary Stack                      | Distilled Integration in `ai-os`                                          |
| ----------------------------------- | ------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| `aphrody-dev/transcribe.cpp`        | ai-llm-compute     | C/C++ ggml CUDA sm_89              | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/strobe`                | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/sst`                   | cloud-edge-infra   | TypeScript / Go / Rust             | Cloud/Edge IaC, secure tunneling & next-gen VCS                           |
| `aphrody-dev/rune`                  | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/rio`                   | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/opentunnel`            | cloud-edge-infra   | TypeScript / Go / Rust             | Cloud/Edge IaC, secure tunneling & next-gen VCS                           |
| `aphrody-dev/NixOS-WSL`             | posix-nix-kernel   | Rust 2024                          | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/niri`                  | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/models.dev`            | ai-llm-compute     | TypeScript (Bun/Vercel) + Rust/Zig | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/mistral.rs`            | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/maki`                  | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/lore`                  | cloud-edge-infra   | TypeScript / Go / Rust             | Cloud/Edge IaC, secure tunneling & next-gen VCS                           |
| `aphrody-dev/litebox`               | posix-nix-kernel   | Rust 2024                          | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/lapce`                 | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/jan`                   | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/hex`                   | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/helix`                 | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/gpui-shell`            | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/fish-shell`            | posix-nix-kernel   | Rust 2024                          | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/Exo`                   | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/EAC-Extractor-Utility` | posix-nix-kernel   | Rust 2024                          | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/desktop`               | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/cubecl`                | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/cosmic-epoch`          | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/burn`                  | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/brush`                 | posix-nix-kernel   | Rust 2024                          | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/Boxedwine64`           | posix-nix-kernel   | C++ / WASM                         | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/asterinas`             | posix-nix-kernel   | Rust 2024                          | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/alacritty`             | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/agents-cli`            | ai-llm-compute     | TypeScript (Bun/Vercel) + Rust/Zig | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/agent-desktop`         | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/agent-browser`         | ai-llm-compute     | Rust Fat-LTO + WebGPU/CUDA         | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/bun`                   | ai-llm-compute     | TypeScript (Bun/Vercel) + Rust/Zig | LLM/STT inference, WebGPU/CUDA compute, Computer-Use FFI & telemetry      |
| `aphrody-dev/tree-sitter`           | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/coreutils`             | posix-nix-kernel   | Rust 2024                          | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/chwd`                  | posix-nix-kernel   | Rust 2024                          | POSIX/Unix shell, coreutils, library-OS sandbox & NixOS declarative store |
| `aphrody-dev/opentui`               | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/zed`                   | ui-terminal-editor | Rust + WebGPU/GPUI                 | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
| `aphrody-dev/mochi-desktop`         | ui-terminal-editor | Python (uv)                        | GPU terminal, Tree-sitter AST, modal/IDE editor & Wayland/M3 shell        |
