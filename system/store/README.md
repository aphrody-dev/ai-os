# ai-os-store

The single agent-home database (`<home>/db/aphrody.sqlite`): per-profile path resolution, versioned migrations, source and file fingerprints, pipeline journal, sync state and checksum-verified backups. Ships the `ai-os-store` binary.

Legacy name: this unit was published on crates.io as `aphrody-store`. It is restored here as `ai-os-store` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `system/store` |

```sh
cargo test -p ai-os-store
cargo clippy -p ai-os-store --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
