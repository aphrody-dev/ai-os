# Prompt Assets

This directory owns first-party prompt segment metadata and preset layouts that
Niubash can load from the active `oh-my-niu` bundle.

- `segments.toml` maps exported segment names, such as `cwd` and `git`, to
  native Niubash segment IDs.
- `[presets.<name>]` tables define segment order, right-prompt elements,
  separators, and optional git prompt formatting.
- Niubash keeps compiled fallback presets so offline releases still render
  prompts when no bundle is installed.

## The `git` segment is live (niubash 1.4.1)

`[segments.git] id = "vcs"` resolves to niubash's native `SegmentId::Vcs`
(niubash#331). The host renders it in-process through git2 — branch, `branch*`
when the worktree is dirty, short SHA on a detached HEAD, empty outside a
repository — with **zero child processes** on the prompt path; no `git.exe`
fork per redraw (that is the PS1-embedded `$(...)` pattern niubash#604
retired).

Colours follow the theme contract every first-party theme already declares:
`[git_clean]` cyan, `[git_dirty]` yellow.

**Showcase preset:** `lean` (`[presets.lean]` in `segments.toml`) —
`cwd · git · newline · prompt_char` — is the shipped preset that exercises the
segment end to end. Every shipped preset (`lean`, `classic`, `rainbow`, `pure`,
`robbyrussell`) already carries `git` in its left prompt.
