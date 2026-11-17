# ai-os-jobs

Persistent background job queue on SQLite: submission, leased claims, crash recovery, retries and NDJSON logs.

Legacy name: this unit was published on crates.io as `aphrody-jobs`. It is restored here as `ai-os-jobs` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `system/jobs` |

```sh
cargo test -p ai-os-jobs
cargo clippy -p ai-os-jobs --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
