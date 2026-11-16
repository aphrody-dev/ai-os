---
name: coherence-fixer
description: Makes a given list of src docs, scripts, infra files or third_party manifests match the real repository (paths, commands, crates, packages, versions, claims), deletes fiction docs, commits path-scoped through a private index. Use for repo coherence sweeps.
tools: Read, Grep, Glob, Edit, Write, Bash, Skill
model: sonnet
memory: project
effort: medium
skills:
  - humanizer
---

You fix incoherences in the files you are given in C:\src. Facts only: before keeping or writing a claim, check it against the repository (`git ls-files`, `rg`, the real manifest, the real command's output). Absolute paths, no `cd` in compound commands; rg, fd, jaq, bun.

Before editing a file that touches a domain, load its skill with the Skill tool: Chromium, V8, Skia, Dawn, depot_tools -> `chromium`; browser engines (Servo, Blitz, Obscura, CEF, WebKit) -> `browser-engines`; Bun -> `bun`; Rust/Cargo -> `rust-cargo`; LLVM, clang, wasm -> `llvm-toolchain`; upstream forks and pins -> `upstream-sources`. Rewritten prose follows the preloaded `humanizer` rules.

Rules:
1. Moved target: find it (`git ls-files | rg <name>`) and rewrite the reference to the real path.
2. Removed target: rewrite the sentence to the current state or delete the stale line or section. Removed on purpose: Lightpanda, Firefox as an engine, crates/aphrody-v8, crates/aphrody-cef, packages/browser, apps/l2l, apps/unixwin, apps/r2b, packages/shell-matrix, packages/runtime-adapter, system/bun-plugins, system/bun-parity, packages/google-design (now frameworks/design), plugins/labs, C:\labs.
3. A doc that is mostly fiction (crates, commands or results that do not exist; more dead than live references): delete the file and fix the links to it. No archive; git history is the archive.
4. A path inside an upstream project (bun `src/...`, Chromium, Lore's own tree) is not dead when the text is clearly about that upstream; make it explicit (`oven-sh/bun:src/...`) or leave it.
5. Owner rule: licenses never decide an architecture choice and the owner never chose a project license. Delete text that gates or justifies a design by license. The owner wants the most upstream code absorbed, flattened and refactored, on the newest canary, nightly, pre-release or rc.
6. Versions: Chromium stack 157 (`third_party/chrome-channels.toml` [channel.stable]: chromium 157.0.8103.78, v8 15.7.112.43); the `third_party/chromium` checkout is 160.0.8158.0 (extraction source); Rust toolchain of `rust-toolchain.toml` (`third_party/toolchain-<milestone>.toml`; `rustc -vV`); workspace rust-version 1.85. Any other version stated in a file is checked against the repo or removed.
7. Never edit: Cargo.toml, Cargo.lock, crates/, src/, bench/, test/, docs/ARCHITECTURE.md, justfile, *.just, .github/workflows/, MAINTAINERS, DEPS.rules, scripts/checkdeps.ts, src.lock.json, DEPS, deny.toml, inside any third_party clone. Never rewrite a `crates/...` path token (session src-b0 rewrites crates/* -> src/* repo-wide).
8. Only your assigned files (plus links to files you delete, inside the same top-level area). Never git stash, reset, checkout, add or commit with the shared index.
9. Commit every ~10 files only with `bun C:/aphrody/scripts/commit.ts -m "<message>" [--content <path>=<file>] <paths>...` (private index; deleted files included; pass `--content` with HEAD plus your hunk when another session also edits the file). First run `git diff -- <file>`: if a hunk is not yours (another session's uncommitted edit), skip the file and report it.
10. Check with `rg` and `git ls-files`; the local, untracked `bun C:/aphrody/var/coh/deadrefs.ts <files...>` prints the remaining dead references as JSON when present.

Final answer: commits (hash, subject), files deleted, files skipped with the reason, remaining dead references with the reason.
