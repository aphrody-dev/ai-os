# Fusion: OpenClaw + Hermes ecosystems -> aphrody-labs/agent

Listed 2026-11-12 with `gh api orgs/openclaw/repos` (non-archived) and `gh api orgs/NousResearch/repos` (agent-related).
Forks: aphrody-labs/openclaw and aphrody-labs/hermes-agent (branch `windows-native`, see C:\aphrody\docs\agents\WINDOWS-NATIVE-PORT.md, 16eea3d).
Status: done / partial / todo / skip (out of scope: macOS/Apple-only, org ops, forks of upstream tools we already fork).

## Rules

- OpenClaw (TS): moved to bun only (bun install/test/build, Bun.serve, Bun.$, bun:sqlite, bun:ffi, Bun.file, workers). Remove pnpm/node/tsx/vitest/esbuild, polyfills and utils that bun or `src/core` already provide.
- Hermes (Python): stays under uv (`python/`). Python reaches the Rust core through pyo3 (`frameworks/agent/context`, feature `python`) and the TS side through the relay (MCP over stdio or HTTP, `frameworks/ai-os/docs/RELAY.md`). bun:ffi only loads C ABI libraries into bun; Python never goes through it. Logic that duplicates OpenClaw goes into the shared TS modules.
- Home: one `~/.agent` (`agent init`), templates merged from OpenClaw workspace templates and Hermes SOUL.

## Core

| Repo                                                                                        | Target module                                                 | Status                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| openclaw/openclaw (agent loop, tools, memory, sessions)                                     | system/core-ts (all reads through core/context.ts)            | partial (loop, tools, memory, skills, heartbeat, home, context)                            |
| openclaw/openclaw (gateway, channels, plugins SDK)                                          | src/gateway, packages/plugins                                 | todo                                                                                       |
| openclaw/openclaw docs/reference/templates                                                  | templates/home                                                | done                                                                                       |
| NousResearch/hermes-agent agent/, tools/ (memory, skills, learning loop, cron, compression) | system/core-ts + python/hermes_agent_memory (pyo3 agent_core) | partial (skill lint/usage/curation, cron, memory provider on the shared store, skills hub) |
| NousResearch/hermes-agent acp_adapter                                                       | src/gateway (ACP)                                             | todo                                                                                       |
| NousResearch/hermes-agent SOUL / persona                                                    | templates/home/SOUL.md                                        | done                                                                                       |
| openclaw/openclaw-windows-node, openclaw-windows-packaging (C#)                             | crates/windows (windows-rs) + MSIX in packaging/              | todo                                                                                       |
| openclaw/ocm (Rust manager)                                                                 | crates/ocm                                                    | todo                                                                                       |

## Skills, plugins, registry

| Repo                                                                                              | Target                                                                                                                    | Status |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| openclaw/clawhub (skill + plugin registry)                                                        | packages/hub (client); the server runs on Bun.serve (prd), not Workers (bun:sqlite, Bun.$ and bun:ffi do not exist there) | todo   |
| openclaw/agent-skills                                                                             | skills/ (bundled)                                                                                                         | todo   |
| openclaw/clawscan (skill security scan, Go)                                                       | packages/hub scan (TS port)                                                                                               | todo   |
| openclaw/babelfish (plugins from other agent apps)                                                | packages/plugins compat                                                                                                   | todo   |
| openclaw/catalog (model catalog)                                                                  | system/core-ts model catalog                                                                                              | todo   |
| openclaw/kitchen-sink, plugin-inspector, crabpot, tidepool                                        | packages/plugins test fixtures                                                                                            | todo   |
| NousResearch/hermes-official-plugins, hermes-labs-plugins, hermes-example-plugins                 | python/plugins + plugin bridge                                                                                            | todo   |
| NousResearch/hermes-plugin-{honcho,mem0,openviking,supermemory,retaindb,byterover}                | memory provider interface in core                                                                                         | todo   |
| NousResearch/hermes-plugin-{backsearch,sprites,solstice}, hermes-nvidia, hermes-collective-wisdom | plugins                                                                                                                   | todo   |
| NousResearch/hermes-agent-self-evolution                                                          | core learning loop                                                                                                        | todo   |

## Protocols, tools, runtime libs

| Repo                                                                                    | Target                                     | Status  |
| --------------------------------------------------------------------------------------- | ------------------------------------------ | ------- |
| openclaw/acpx (ACP client)                                                              | src/gateway ACP                            | todo    |
| openclaw/mcporter (MCP as TS API)                                                       | src/relay (MCP) client                     | todo    |
| openclaw/turnwire (MCP relay, Go)                                                       | src/relay (MCP) relay                      | todo    |
| openclaw/lobster (workflow shell)                                                       | system/core-ts workflows (Vercel Workflow) | todo    |
| openclaw/libterminal                                                                    | src/tui                                    | todo    |
| openclaw/fs-safe, proc-safe, proxyline                                                  | core sandbox/fs (bun-native)               | todo    |
| openclaw/clawrouter (provider router)                                                   | core/model.ts + AI Gateway                 | partial |
| openclaw/clawpdf, ffmpeg-wasm, libopus-wasm, rastermill                                 | packages/media                             | todo    |
| openclaw/carapace (design tokens)                                                       | apps/web                                   | todo    |
| openclaw/collab, cookbook, uirouter, reef, hermit, krillswitch, crabhelm, openclaw-atif | evaluate per repo                          | todo    |

## Channels and crawlers

| Repo                                                                                                                                    | Target                                                              | Status |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| openclaw/wacli, wacrawl, telecrawl, slacrawl, discrawl, imsgcrawl, notcrawl, graincrawl, photoscrawl, gitcrawl, birdclaw, crawlkit (Go) | src/gateway channels via Chat SDK + packages/crawl (TS, bun:sqlite) | todo   |
| openclaw/crabline (mock channel server)                                                                                                 | gateway tests                                                       | todo   |
| openclaw/clickclack, clawdex, clawgo, esp-openclaw-node (C)                                                                             | evaluate (esp node -> firmware/)                                    | todo   |
| openclaw/gogcli, goplaces, spogo, remindctl                                                                                             | tools via MCP                                                       | todo   |

## Eval, ops

| Repo                                                                                                                                                                                                          | Target                                | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| openclaw/Kova, clawgrit-reports, openclaw-rtt                                                                                                                                                                 | bench/                                | todo   |
| NousResearch/hermes-toolperf-evals, hermes-compression-eval, harbor-fork                                                                                                                                      | evals/                                | todo   |
| openclaw/crabbox, crabfleet, clawpatch, clawsweeper* , octopool, releases, release-workflows, telemetry, docs, ask-molty, community, rfcs, homebrew-tap, nix-openclaw*, openclaw-ansible, openclaw-enterprise | skip or infra/ later                  | skip   |
| openclaw/bun, WebKit                                                                                                                                                                                          | already forked (aphrody-labs/bun)     | skip   |
| openclaw/Peekaboo, AXorcist, Swabble, Tachikoma, imsg, crawlbar, openclaw-facetime                                                                                                                            | macOS-only                            | skip   |
| NousResearch/NemoClaw (OpenClaw in NVIDIA OpenShell)                                                                                                                                                          | sandbox backend                       | todo   |
| NousResearch/RL, tinker-atropos, vllm, lighteval, Hermes-Function-Calling                                                                                                                                     | inference/training, out of agent core | skip   |
| NousResearch/autonovel, pokemon-agent, cline, nousflash-agents, local_generative_agents, agent-governance-toolkit, hermes-paperclip-adapter                                                                   | examples / evaluate                   | skip   |

## OpenClaw bun-native status (2026-11-12, fork branch `bun-native`, 52bfe78ce)

- `bun pm migrate` rejects the pnpm 12 lockfile (two YAML documents; then NonExistentWorkspaceDependency, oven-sh/bun#23026, although every link target exists). Fallback in `scripts/bun-migrate.ts`: workspaces/overrides/patches/trusted deps go from pnpm-workspace.yaml into package.json; the 1331 packages pnpm resolved to a single version are pinned as overrides; nested `a>b` overrides are dropped (bun overrides are global).
- `bun install` on prd: OK (1701 installs) with `bunfig.toml` `[run] bun = true` (node -> bun) and the preinstall guard accepting Bun 1.4.4+.
- `bun run build` on prd: blocked. TypeScript 7 native API (`typescript/sync`, SyncRpcChannel) reads `child.stdout._handle.fd`, a Node internal Bun does not expose. Options: patch typescript (patchedDependencies) to use a FIFO on POSIX like its Windows named-pipe path, or add `_handle.fd` to Bun's child_process in aphrody-labs/bun.
- Not started: replacing tsx/vitest/esbuild per package.
