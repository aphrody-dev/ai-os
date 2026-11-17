# ai-os-fsindex

Persistent local-filesystem search index on SQLite FTS5. Metadata only, privacy-bounded.

Legacy name: this unit was published on crates.io as `aphrody-fsindex`. It is restored here as `ai-os-fsindex` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `system/fsindex` |

```sh
cargo test -p ai-os-fsindex
cargo clippy -p ai-os-fsindex --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
