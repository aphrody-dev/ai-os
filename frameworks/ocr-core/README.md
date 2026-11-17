# ai-os-ocr-core

Portable, versioned OCR result contract with provenance and quality states, DocTags parsing and an optional SQLite store (feature `sqlite`).

## Restoration

Legacy name: this unit was published on crates.io as `aphrody-ocr-core`. It is restored here as `ai-os-ocr-core` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `frameworks/ocr-core` |

```sh
cargo test -p ai-os-ocr-core
cargo clippy -p ai-os-ocr-core --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
