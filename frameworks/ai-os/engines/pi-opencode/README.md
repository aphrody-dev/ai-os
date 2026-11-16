# pi-opencode

<!-- catalog:begin unit -->

> Minimalist modular autonomous coding harness fusing Pi (4-tool core), OpenCode + OpenTUI (Bun & Rust libs/UI), Locally Uncensored + Heretic + Ring3-Agent (open-weights local inference), and Symphony + Ralph NHITL worktree loops

| Type        | Path                                   |
| :---------- | :------------------------------------- |
| Bun package | `frameworks/ai-os/engines/pi-opencode` |

**Commands**

```sh
bun run --cwd frameworks/ai-os/engines/pi-opencode start
bun run --cwd frameworks/ai-os/engines/pi-opencode serve
bun run --cwd frameworks/ai-os/engines/pi-opencode tui
bun run --cwd frameworks/ai-os/engines/pi-opencode models
bun run --cwd frameworks/ai-os/engines/pi-opencode test
bun run --cwd frameworks/ai-os/engines/pi-opencode check
bun run --cwd frameworks/ai-os/engines/pi-opencode fmt
bun run --cwd frameworks/ai-os/engines/pi-opencode fmt:check
```

Part of Aphrody: [aphrody-labs/ay](../../../../README.md), [Catalog](../../../../docs/reference/catalog/package.md).
<!-- catalog:end -->

Unified minimalist, autonomous coding harness synthesized from the real late-2026 open-source ecosystem and engineered around **Linus Torvalds**, **Jarred Sumner**, and **Larry Page** principles:

1. **Pi Minimalist & Modular Agent Core** (`C:\aphrody\third_party\pi` — `earendil-works/pi`, 121k+ stars):
   - Zero framework bloat: exposes only 4 atomic composable tools (`read`, `write`, `edit`, `bash`) in [`src/pi-core.ts`](file:///C:/aphrody/frameworks/ai-os/engines/pi-opencode/src/pi-core.ts).
   - Strict userspace safety boundary (`C:\Windows\System32`, `/usr/bin`, `/etc` and workspace-escape attempts are deterministically blocked in both Rust and TypeScript).
2. **OpenCode + OpenTUI Bun & Rust Libraries / UI** (`C:\aphrody\third_party\opencode` — `anomalyco/opencode`, 225k+ stars & `C:\aphrody\third_party\opentui` — `aphrody-dev/opentui`):
   - Native Rust zero-copy FNV-1a/Merkle workspace snapshotter, bounded LCS diff engine, and Win32 thread inspector ([`rust-core/src/lib.rs`](file:///C:/aphrody/frameworks/ai-os/engines/pi-opencode/rust-core/src/lib.rs)) loaded via `bun:ffi` ([`src/native-bridge.ts`](file:///C:/aphrody/frameworks/ai-os/engines/pi-opencode/src/native-bridge.ts)).
   - `bun:sqlite` WAL session/event persistence, differential OpenTUI terminal renderer, and instant zero-dependency Bun Web UI/API server ([`src/opencode-ui.ts`](file:///C:/aphrody/frameworks/ai-os/engines/pi-opencode/src/opencode-ui.ts)).
3. **Locally Uncensored + Heretic + Ring3-Agent Open-Weights Inference** (`C:\aphrody\third_party\locally-uncensored` — `PurpleDoubleD/locally-uncensored` v3.0.10, `C:\aphrody\third_party\heretic` — `p-e-w/heretic` v2, `C:\aphrody\crates\ring3-agent`):
   - Hardware-aware catalog of abliterated / Heretic-modified open-weights models fitting RTX 4070 12GB (`sm_89`), OVH FR AVX2 VPS, and Browser WebGPU ([`src/lu-provider.ts`](file:///C:/aphrody/frameworks/ai-os/engines/pi-opencode/src/lu-provider.ts)).
   - Direct OpenAI-compatible tool-calling bridge to `Locally Uncensored` (`127.0.0.1:8129/v1`), `ring3-agent` (`127.0.0.1:8787`), `mistral.rs`, `Ollama`, and `llama.cpp` without cloud refusal filters, plus `heretic-init` config generation.
4. **Symphony + Ralph Full-Auto NHITL ("No Human In The Loop") Workflow** (`C:\aphrody\third_party\symphony` — `openai/symphony` & `C:\aphrody\third_party\ralph` — `snarktank/ralph`):
   - Versioned in-repo `WORKFLOW.md` + `prd.json` contract executed inside detached Git worktrees (`withIsolatedWorktree`) until empirical acceptance commands (`bun test`, `bun check`, `cargo test`) turn GREEN ([`src/nhitl-loop.ts`](file:///C:/aphrody/frameworks/ai-os/engines/pi-opencode/src/nhitl-loop.ts)).

## Quick Usage

```powershell
pi-opencode tui                  # OpenTUI workspace & Merkle snapshot status
pi-opencode models 12            # Models fitting 12 GB RTX 4070 sm_89 + active engine probe
pi-opencode heretic-init         # Generate Heretic v2 4-bit refusal-suppression config
pi-opencode serve 4096           # Start OpenCode Bun HTTP + WAL SQLite UI/API server
pi-opencode nhitl                 # Run full NHITL WORKFLOW.md + prd.json autonomous loop
```
