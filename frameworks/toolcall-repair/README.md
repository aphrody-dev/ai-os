# ai-os-toolcall-repair

Tool-calling robustness for weak open models: tolerant JSON repair, inline tool-call extraction, argument validation and coercion, patch normalisation and prompt profiles.

Legacy name: this unit was published on crates.io as `aphrody-toolcall-repair`. It is restored here as `ai-os-toolcall-repair` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `frameworks/toolcall-repair` |

```sh
cargo test -p ai-os-toolcall-repair
cargo clippy -p ai-os-toolcall-repair --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
