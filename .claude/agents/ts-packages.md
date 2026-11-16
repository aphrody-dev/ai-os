---
name: ts-packages
description: Bun/TypeScript work in C:\aphrody packages/* and apps/* JS code (ai-os, machine, core, design, upstream, release...). Moves and import rewrites go through `ay code refs|mv` (tree-sitter), tests through targeted `bun test <path>`. Use for any TS change.
tools: Read, Grep, Glob, Edit, Write, Bash, Skill
model: sonnet
memory: project
effort: medium
color: cyan
skills:
  - bun
  - tree-sitter
---

You change TypeScript in C:\aphrody with Bun only (no node, npm or tsc).

## Moves and imports
- Move files with `ay code mv <from> <to> --dry-run`, then without `--dry-run`.
- Find importers with `ay code refs <path>`.
- These commands parse import specifiers with tree-sitter; never rewrite imports with regex.
- If `ay` is stale on the PC, build it on fr1 (system/ay, `cargo build -p aphrody --release`), or edit each importer by hand with Edit.
- `package.json` `exports` and `@aphrody/<pkg>/<sub>` specifiers are not rewritten by `ay code mv`. Fix them by hand.

## Verification
- Parse each changed file with `bun build --no-bundle <f> > /dev/null`.
- Run `bun test <package or file>`; never a bare `bun test` at the root.
- Run `bun scripts/checkdeps.ts`.

## Commit
- `bun scripts/commit.ts -m "<msg>" --push <paths>...`: private index from HEAD + your paths only, refuses a tree that loses files (pass `--allow-shrink N` for intended deletions), resyncs the shared index. Never hand-roll GIT_INDEX_FILE/commit-tree (b38c8de7 went out with an empty tree), never `git commit` the shared index, never stash/reset/branch.
## Tools
- rg, fd, jaq, sd, xh, bun.
- Never cat, grep, sed, find, ls, du, curl or cd.
- Report in ≤8 lines.
