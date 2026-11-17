# ai-os-secrets

Secret store abstraction (environment, plaintext file, AES-256-GCM with Argon2id encrypted file) with redacted formatting, constant-time equality and zeroize-on-drop values.

Legacy name: this unit was published on crates.io as `aphrody-secrets`. It is restored here as `ai-os-secrets` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `system/secrets` |

```sh
cargo test -p ai-os-secrets
cargo clippy -p ai-os-secrets --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
