# ai-os-translate-core

Pure stages of the comment rewriter: comment extraction, AI-marker scrubbing, prose style and language detection. No network, no runtime, wasm32-safe.

Legacy name: this unit was published on crates.io as `aphrody-translate-core`. It is restored here as `ai-os-translate-core` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `frameworks/translate-core` |

```sh
cargo test -p ai-os-translate-core
cargo clippy -p ai-os-translate-core --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
