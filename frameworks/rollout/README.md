# ai-os-rollout

Resilient agent-session recorder: an async actor appends timestamped JSONL items to a rollout file and a prior session is resumed by replaying it.

Legacy name: this unit was published on crates.io as `aphrody-rollout`. It is restored here as `ai-os-rollout` (`publish = false`; nothing is published from this repository by hand).

| Type | Path |
| :-- | :-- |
| Rust crate | `frameworks/rollout` |

```sh
cargo test -p ai-os-rollout
cargo clippy -p ai-os-rollout --all-targets -- -D warnings
```

Rust builds run on the build host or in CI, not on a workstation.

Part of Aphrody: [aphrody-dev/ai-os](../../README.md).
