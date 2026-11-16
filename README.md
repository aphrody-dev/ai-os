# ai-os

Aphrody AI OS and the AI surface of the legacy monorepo, as one standalone repository: the agent kernel and relay (`frameworks/ai-os`), the A2A, MCP, agent, model, inference and RAG crates, and the few system packages they need.

The tree is generated, not copied by hand: [`extract.toml`](extract.toml) selects units of [aphrody-labs/legacy](https://github.com/aphrody-labs/legacy) at a pinned rev, and [`tools/extract.ts`](tools/extract.ts) builds it, including the root `package.json` and `Cargo.toml`. CI runs the extraction again and fails if the tree changes. [`extract.lock.json`](extract.lock.json) lists what was taken.

## Layout

| Path | Content |
| :-- | :-- |
| `frameworks/ai-os` | Bun package: relay (HTTP and stdio MCP), LLM runtime discovery, RAG, term, Google and Jules tools |
| `frameworks/*` | Rust crates (A2A, agents, models, llama, embed, RAG, memory, MCP client, gateway, accounts) and `automate` |
| `system/*` | `core` (C ABI of the AI OS), `config`, `vault`, `env-kit`, `core-ts`, `gnu-ts`, `omniu`, `py2bun-ts`, `wck` |
| `tools/ai`, `tools/agents`, `tools/build-model` | model gateway overlay, agent harness (runner, GitHub events, plugins), model build bench |
| `tools/closure.ts`, `tools/extract.ts` | dependency closure and extraction |

## Commands

```sh
bun install
bun test frameworks/ai-os/test          # Bun packages
cargo check --workspace --all-targets   # Rust crates
bun frameworks/ai-os/src/relay/cli.ts serve      # relay on 127.0.0.1:8790
bun frameworks/ai-os/src/relay/cli.ts mcp-stdio  # the same MCP server over stdio
```

## Rebuild from legacy

```sh
git clone https://github.com/aphrody-labs/legacy ../legacy
bun tools/extract.ts [--rev=<sha>]   # rewrites the tree and the rev in extract.toml
bun tools/closure.ts ../legacy <unit>...   # what a unit pulls in, with sizes
```

License: MIT OR Apache-2.0 ([LICENSE.md](LICENSE.md)).
