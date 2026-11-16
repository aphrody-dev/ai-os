# Architectural Roadmap & Fork Portfolio Evaluation

## 1. Executive Summary & Core Mission

This document establishes the canonical roadmap and technical evaluation of the `aphrody-dev` GitHub portfolio and the local `C:\aphrody` subsystems. The overarching target is the construction of a sovereign, ultra-low-overhead, unprivileged (Ring-3) AI daemon and inference substrate: **`r3d` (`ring3-agent`)**.

### System Pillars:

1. **Ring-3 Usermode Isolation**: Pure unprivileged execution under OS limits (Win32 Job Objects on Windows NT; user namespaces, seccomp-BPF, and cgroups v2 on Linux). No kernel drivers, no root-privilege requirement.
2. **Early Boot & Deterministic High-PID Scheduling**: Systemd early-boot integration (`DefaultDependencies=no`, `After=local-fs.target`, FIFO scheduling, `Nice=-15`) mapped to upper PID space (`ns_last_pid` >= 3,000,000) to isolate the agent from transient system processes.
3. **Reversible Windows Graphical VRAM Diet**: Live VRAM reclamation from non-essential graphical processes (DWM, Explorer, WebView2, Widgets) via non-destructive Win32 hooks (`SPI_SETUIEFFECTS`, working-set trimming, EcoQoS power throttling), yielding maximum dedicated VRAM for local LLM inference on the NVIDIA GeForce RTX 4070 12GB (`sm_89`).
4. **Tri-Backend Inference Router**:
   - **Local NVIDIA GPU (`cuda-sm89`)**: Ada Lovelace Tensor Cores FP8/BF16/INT4 with FlashAttention-2 / PagedAttention and dynamic KV-cache allocation.
   - **VPS Multi-Core CPU (`vps-cpu-avx2`)**: Ring-3 AVX2 + FMA3 quantized INT8/Q4_0 forward compute tuned for OVH France (`203.0.113.1`, `203.0.113.2`) and Hostinger US (`203.0.113.3`).
   - **Browser WebGPU (`webgpu-wgsl`)**: In-browser client inference executing directly via `navigator.gpu` using WGSL compute shaders.
5. **Ultra-Lightweight Control Plane**: Pure Rust native HTTP server (`std::net::TcpListener`, zero async framework bloat) exposing concise endpoints (`/ok`, `/stat`, `/cfg`, `/off`, `/on`, `/models`, `/chat`, `/embed`, `/gpu`) and full OpenAI/MCP compatibility.

---

## 2. GitHub Hygiene & Account Isolation (`aphrody-dev`)

### Account State:

- **Active GitHub Account**: `aphrody-dev` (Exclusive).
- **Secondary Account (`aphrody-code`)**: Logged out and severed.
- **Archived Public Repositories Purged**: 9 obsolete repositories permanently deleted (`audiocraft`, `ipc-channel`, `komorebi`, `pathfinder`, `pydoll-cf-waf-bypasser-skills`, `rust-cssparser`, `rust-smallvec`, `rust-url`, `yasb`).
- **Active Repositories Evaluated**: 36 repositories.

---

## 3. Comprehensive Evaluation of `aphrody-dev` Repositories

### Tier A — Core Strategic Foundations (Keep & Integrate Directly)

These repositories form the direct dependencies, architectural inspirations, or submodules of the `ring3-agent` ecosystem:

| Repository       | Upstream Parent                 | Upstream Stars | Primary Language | Strategic Value & Integration Role                                                                                                                                                                                      |
| :--------------- | :------------------------------ | :------------- | :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mistral.rs`     | `EricLBuehler/mistral.rs`       | 7,823          | Rust             | **Primary Local Inference Engine**: Fast Rust LLM engine with direct CUDA/cuBLAS/FlashAttention kernels, PagedAttention, and quantized GGUF/GGML support. Integrated as the high-throughput local backend for RTX 4070. |
| `burn`           | `tracel-ai/burn`                | 16,266         | Rust             | **Universal Tensor Framework**: Backend-agnostic deep learning in Rust supporting WGPU, LibTorch, CUDA, and WebAssembly targets.                                                                                        |
| `cubecl`         | `tracel-ai/cubecl`              | 2,494          | Rust             | **High-Performance JIT Kernel Language**: Generates optimized WGSL, CUDA, and Vulkan compute kernels from Rust syntax. Essential for portable custom GEMM/RMSNorm kernels.                                              |
| `litebox`        | `microsoft/litebox`             | 3,276          | Rust             | **Ring-3 Usermode Library OS**: Microsoft sandbox technology for running untrusted code in unprivileged Ring-3 without container virtualization overhead.                                                               |
| `asterinas`      | `asterinas/asterinas`           | 5,086          | Rust             | **Framekernel Architecture**: Rust-based OS kernel providing Linux ABI compatibility with formal safety guarantees.                                                                                                     |
| `bun`            | `oven-sh/bun`                   | 96,748         | Zig / C++ / Rust | **Full-Stack Runtime & Fast Tooling**: Canonical JavaScript/TypeScript engine, bundler, and package manager used across Aphrody web properties.                                                                         |
| `maki`           | `tontinton/maki`                | 1,395          | Rust             | **Local Coding Agent Core**: Autonomous coding agent logic, AST-aware file editing, and loop control for autonomous developer workflows.                                                                                |
| `agents-cli`     | `google/agents-cli`             | 6,335          | Go / Rust        | **Agent Protocol Reference**: Canonical CLI standard for agent execution and multi-agent task distribution.                                                                                                             |
| `models.dev`     | `anomalyco/models.dev`          | 7,592          | TypeScript       | **Unified Model Registry & Capability Database**: Schemas and metadata catalog for LLMs, context lengths, and token pricing.                                                                                            |
| `strobe`         | `anomalyco/strobe`              | 147            | Rust             | **Low-Overhead System Profiler**: Real-time process metrics, CPU cycles, and memory pressure monitoring.                                                                                                                |
| `transcribe.cpp` | `handy-computer/transcribe.cpp` | 2,157          | C++ / GGML       | **Voice-to-Agent Pipeline**: Lightweight speech-to-text transcription powered by whisper GGML compute.                                                                                                                  |
| `hex`            | `anomalyco/hex`                 | 6,161          | Rust             | **Terminal Productivity & Hex/Binary Inspection**: Deep memory and protocol inspection tool for local IPC protocols.                                                                                                    |
| `coreutils`      | `uutils/coreutils`              | 24,357         | Rust             | **POSIX Substrate**: Complete Rust rewrite of GNU coreutils for deterministic execution in unprivileged environments.                                                                                                   |
| `brush`          | `reubeno/brush`                 | 2,308          | Rust             | **POSIX/Bash Compatible Shell**: Embedded shell interpreter written in pure Rust. Enables the agent to execute shell commands natively in-process without spawning bash subprocesses.                                   |
| `chwd`           | `CachyOS/chwd`                  | 138            | C++ / Shell      | **Hardware Auto-Detection**: Profiles CPU ISA (AVX2, FMA) and GPU capabilities (PCI IDs, driver versions) to select optimal inference codepaths.                                                                        |
| `NixOS-WSL`      | `nix-community/NixOS-WSL`       | 3,158          | Nix              | **Declarative Linux Runtime**: Reproducible WSL2 image for local testing of high-PID systemd services and seccomp sandboxing.                                                                                           |
| `zed`            | `zed-industries/zed`            | 94,665         | Rust             | **High-Performance GPUI Editor**: Benchmark for zero-overhead GPU-accelerated UI architecture using Vulkan/DirectX/Metal.                                                                                               |
| `cosmic-epoch`   | `pop-os/cosmic-epoch`           | 7,001          | Rust             | **Sovereign Desktop Subsystem**: Wayland compositor and desktop components built with iced and smithay.                                                                                                                 |
| `niri`           | `niri-wm/niri`                  | 28,996         | Rust             | **Scrollable-Tiling Wayland Compositor**: Reference implementation for minimal graphical compositor memory footprint.                                                                                                   |
| `gpui-shell`     | `andre-brandao/gpui-shell`      | 172            | Rust             | **Lightweight GPUI Application Harness**: Extracted windowing framework from Zed for standalone tools and agent HUDs.                                                                                                   |
| `rio`            | `raphamorim/rio`                | 7,725          | Rust             | **WebGPU-Powered Terminal Emulator**: Fast terminal emulator rendering via WGPU and WebGPU shaders.                                                                                                                     |

---

### Tier B — Specialized Reference / Niche Utility

These repositories provide specific algorithms, data structures, or auxiliary functionality:

| Repository              | Upstream Parent                     | Upstream Stars | Primary Language | Function & Evaluation                                                                                                                  |
| :---------------------- | :---------------------------------- | :------------- | :--------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| `tree-sitter`           | `tree-sitter/tree-sitter`           | 27,430         | C / Rust         | **Incremental Parsing Library**: Code structure analysis, AST generation, and token boundaries. Essential for agent code intelligence. |
| `opentui`               | `anomalyco/opentui`                 | 13,781         | TypeScript       | **Terminal UI Components**: Web-like declarative TUI components for agent monitoring.                                                  |
| `helix`                 | `helix-editor/helix`                | 46,940         | Rust             | **Modal Text Editor**: Terminal-first editor using tree-sitter. Reference for fast TUI rendering without GUI baggage.                  |
| `Boxedwine64`           | `andrewnakas/Boxedwine64`           | 10             | C++              | **User-Mode x86/x64 Emulator**: Runs Windows binaries in unprivileged environments. Reference for user-mode syscall emulation.         |
| `opentunnel`            | `anomalyco/opentunnel`              | 427            | Rust             | **Encrypted TCP/UDP Tunneling**: Fast reverse proxy for exposing local daemon endpoints without public IPs.                            |
| `lore`                  | `EpicGames/lore`                    | 9,127          | Rust             | **Distributed Build & Asset Pipeline**: Asset caching and high-throughput content addressing.                                          |
| `EAC-Extractor-Utility` | `lguilhermee/EAC-Extractor-Utility` | 99             | Rust             | **Binary Asset Unpacker**: Specialized extraction utility for compressed archives.                                                     |

---

### Tier C — Redundant / Overlapped Forks (Candidates for Archival or Consolidation)

These forks overlap with Tier A components or have been superseded by more integrated sovereign tools:

| Repository                       | Overlapping Core Component              | Architectural Rationale for Archival                                                                                                                                    |
| :------------------------------- | :-------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fish-shell`                     | `brush`                                 | `fish-shell` uses a custom syntax incompatible with POSIX/Bash scripts. `brush` provides a pure Rust, thread-safe, in-process POSIX/Bash interpreter.                   |
| `alacritty`                      | `rio`                                   | `alacritty` uses traditional OpenGL and has rigid rendering architecture. `rio` is built natively on WebGPU/WGPU, aligning directly with our browser/GPU shader target. |
| `lapce`                          | `zed`                                   | `lapce` uses Floem/Druid and has fragmented plugin development. `zed`'s GPUI is production-grade, highly optimized, and directly forkable.                              |
| `jan`                            | `mistral.rs` + `burn`                   | `jan` bundles an Electron/Tauri desktop wrapper with heavy node dependencies. `ring3-agent` implements a pure native Rust HTTP daemon with 100x lower memory overhead.  |
| `Exo` / `mochi-desktop` / `rune` | `gpui-shell` / `cosmic-epoch` / `taffy` | Python/Electron desktop wrappers with high memory footprints. Superseded by native Rust GPUI/Taffy architectures.                                                       |
| `sst`                            | `wrangler` + Cloudflare Workers         | `sst` introduces complex Node/IaC abstraction layers. Sovereign deployments prioritize native Cloudflare and minimal Rust/Go deployers.                                 |

---

## 4. Local Subsystem Audit (`C:\aphrody`)

| Subsystem Directory                            | Focus & Upstream Lineage                                                    | Integration Status with `r3d`                                                 |
| :--------------------------------------------- | :-------------------------------------------------------------------------- | :---------------------------------------------------------------------------- |
| `C:\aphrody\apps\web`                          | Strict Google replica, 100% pure Bun, 0 external npm dependencies.          | Frontend presentation layer for client-side WebGPU agent chat console.        |
| `C:\aphrody\crates\bench`                          | Benchmarking harnesses for memory latency and inference throughput.         | Performance verification suite for AVX2 vs CUDA latency.                      |
| `C:\aphrody\third_party\bun`                       | Upstream `oven-sh/bun` source tree.                                         | Host runtime for scripts and high-speed local control scripts.                |
| `C:\aphrody\third_party\chromium` & `chromium-bun` | Chromium upstream source and headless bindings.                             | Headless web interaction and testing for WebGPU browser compute.              |
| `C:\aphrody\crates\depot` & `depot_tools`          | Sovereign monorepo engine using Google `argh` + `zerocopy` + `windows-sys`. | Build orchestration and dependency management.                                |
| `C:\aphrody\third_party\dioxus` & `taffy`          | Rust UI layout and cross-platform GUI framework.                            | Native UI layout engine for local HUD displays.                               |
| `C:\aphrody\crates\gamescope-rs`                   | Rust micro-compositor wrapper.                                              | Display management for low-latency isolated rendering.                        |
| `C:\aphrody\third_party\linux` & `unix`            | Linux kernel headers and Unix core tools.                                   | Target headers for systemd early-boot units and seccomp profile generation.   |
| `C:\aphrody\third_party\longbridge`                | High-frequency trading and low-latency network protocols.                   | Reference for zero-copy binary streaming and connection pooling.              |
| `C:\aphrody\third_party\microsoft`                 | Native Windows NT APIs, WDK, and Windows SDK tools.                         | Win32 Job Object, Power Throttling, and DWM hook definitions.                 |
| `C:\aphrody\apps\rosegriffon` & `shenron`          | Production web platforms (`rosegriffon.fr`, `dragonballfr.com`).            | Real-world consumer applications consuming `r3d` API endpoints.               |
| `C:\aphrody\third_party\storytold`                 | Interactive narrative engine.                                               | AI agent testbed for creative text generation and branching state logic.      |
| `C:\aphrody\third_party\wgpu` & `winit`            | WebGPU native implementation in Rust and cross-platform windowing.          | Underpins client-side rendering and GPU shader execution.                     |
| `C:\aphrody\third_party\zed`                       | High-performance GPUI collaborative editor.                                 | Reference architecture for low-latency buffer management and thread dispatch. |

---

## 5. Architectural Blueprint for `ring3-agent` (`r3d`)

```
+-----------------------------------------------------------------------------------+
|                                 r3d.exe (Ring-3 Daemon)                           |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  +--------------------+   +-----------------------+   +------------------------+  |
|  |   Control Plane    |   |    Isolation & Diet   |   |   Tri-Backend Engine   |  |
|  |                    |   |                       |   |                        |  |
|  | - std::net HTTP    |   | - Win32 JobObject     |   | [1] CUDA sm_89         |  |
|  | - SSE EventStream  |   | - Linux high-PID      |   |     (RTX 4070 12GB)    |  |
|  | - Instant Switch   |   | - Systemd Early-Boot  |   | [2] VPS CPU AVX2       |  |
|  | - Hot Reload       |   | - Windows GPU-Diet    |   |     (OVH + Hostinger)  |  |
|  |   (/cfg, /off)     |   |   (VRAM Reclamation)  |   | [3] WebGPU WGSL        |  |
|  +--------------------+   +-----------------------+   |     (Browser Compute)  |  |
|                                                       +------------------------+  |
+-----------------------------------------------------------------------------------+
```

### Key Technical Innovations:

1. **Zero External Framework Footprint**: Built with zero async runtime dependencies. Uses lightweight standard library sockets with non-blocking worker pools to achieve binary sizes under 1.5 MB with instantaneous startup (< 2 ms).
2. **Deterministic VRAM Reallocation**: Rather than requiring dedicated headless servers, the Windows GPU-Diet module temporarily sheds non-critical Windows desktop composition effects (`SPI_SETUIEFFECTS`), trims process working sets, and throttles idle renderers to maximize contiguous VRAM available to CUDA.
3. **True In-Browser WebGPU Compute**: The `/gpu` endpoint serves a self-contained, zero-dependency HTML interface executing quantized matrix-vector operations, RMSNorm, and Softmax directly on client GPUs via WGSL compute shaders.
