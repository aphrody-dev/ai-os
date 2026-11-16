# aphrody-config

<!-- catalog:begin unit -->
<!-- prettier-ignore-start -->
> Codex-compatible config.toml model for aphrody: ConfigToml, model providers (managed llama-server, Ollama, LM Studio, vLLM, Antigravity, OpenAI, Anthropic, ChatGPT), layered merge (built-ins < Codex-compat < user < project < profile < -c overrides < CLI flags), dotted -c override parsing, and the No-Human-In-The-Loop policy defaults. Pure, no filesystem access in the core, wasm32-safe.

| Type | Path |
| :-- | :-- |
| Rust crate | `system/config` |

**Commands**

```sh
cargo test -p aphrody-config
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-labs/ay](../../README.md), [Catalog](../../docs/reference/catalog/crate.md).
<!-- prettier-ignore-end -->
<!-- catalog:end -->
