# Legacy AI inventory (src @ 5525822)

Lines = .ts/.rs/.py/.zig. Imported with `git archive HEAD packages/<name>` into `legacy/<name>`; deleted from src.

| Package          | Files | Lines | Content                                                                                           |
| ---------------- | ----- | ----- | ------------------------------------------------------------------------------------------------- |
| ai-os            | 75    | 20231 | control plane, providers, MCP/A2A/ACP, sentinel, extractor, bun:ffi bus, triad copy, sqlite state |
| knowledge-engine | 18    | 5561  | context7 client, deep research, fact-check, docs/skills generators, MCP stdio                     |
| ai-triad         | 22    | 3793  | codex/agy/gemini/claude runners, OAuth device flow, gateway, TUI                                  |
| agy              | 13    | 3079  | Antigravity CLI glue, gemma lab, notebook, web app, rust-desktop                                  |
| pi-opencode      | 17    | 2159  | pi core tools, opencode UI, NHITL loop, provider                                                  |
| brain            | 6     | 588   | session merge                                                                                     |
| total            | 151   | 35411 |                                                                                                   |

## Duplicates found

- `runAgent`, `routeTask`, `runCouncil`: ai-os/src/triad and ai-triad/src/runners (same council logic twice).
- `redactSecret(s)FromText`, `parseDotEnv`: ai-os/src/env.ts, ai-os/nexus/security.ts, knowledge-engine/env/safe-env.ts.
- `runCliSubprocess`, `resolveCodexExecutable`, `resolveBinaryCatalog`: ai-triad/discovery.ts and ai-os/extracted.
- MCP servers: ai-os/protocols/mcp.ts, ai-os/nexus/unified-mcp.ts, knowledge-engine/mcp/stdio.ts, ai-triad/server/gateway.ts (4 implementations).
- Provider layers: ai-os/providers, pi-opencode/lu-provider.ts, ai-triad runners (replaced by `src/core/model.ts`).
- Memory: brain, ai-os/nexus/brain-memory.ts (replaced by `src/core/memory.ts`).

## Absorbed (2026-11-12)

- MCP x4 -> `src/relay` (MCP) (official SDK, stdio). Removed: ai-os protocols/mcp.ts, nexus/unified-mcp.ts, knowledge-engine src/mcp, ai-triad server.
- Council x2 -> `src/core/council.ts` (`council`, `route`, `ask`). Removed: ai-os src/triad, ai-triad.
- Redactors x3 -> `src/core/secrets.ts`. Copies left inside ai-os/env.ts, nexus/security.ts and knowledge-engine/env go when those packages are dissolved.
- brain -> core memory; pi-opencode (pi tools, provider) -> core tools + model.ts. Both removed.
- Remaining legacy: ai-os, knowledge-engine, agy (23 639 lines). Their entry points still import the removed files and do not run; legacy is not built.

## Dissolved (2026-11-12, legacy/ deleted)

- knowledge-engine: context7 client -> research/context7.ts (docs_search, docs_fetch tools); fact-check -> research/factcheck.ts; deep research -> research pipeline; MCP -> src/relay (MCP); redactor -> core/secrets.ts.
- ai-os: providers/federation -> core/model.ts; brain-memory -> core/memory.ts; skills-hub -> core/skills hub; protocols a2a/acp -> gateway (roadmap); triad -> core/council.ts.
- Dropped (no consumer, or replaced by vendor SDKs): ai-os extractor, system1 trainer/decisional engine, sentinel, posix/nix/wasm-webgpu, bun:ffi desktop bus (windows-rs crate planned), benchmark arena, rosegriffon ops; knowledge-engine docs/skills generators, kernel crawler, agy session auditor; agy (Antigravity CLI glue, gemma lab, notebook, finops, web app, rust-desktop).
- Source remains in git history: aphrody-labs/src@5525822 packages/_, aphrody-labs/agent@efa63bb legacy/_.
