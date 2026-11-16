# Alias Assets

This directory owns first-party alias tables for builtin packs. Niubash loads
these files from the active `oh-my-niu` bundle first and falls back to its
compiled alias tables only when the bundle is absent or invalid.

Each file is named after the exporting pack:

```text
aliases/git.toml
aliases/docker.toml
aliases/kubectl.toml
aliases/npm.toml
```

File format:

```toml
[aliases]
gst = 'git status'
```
