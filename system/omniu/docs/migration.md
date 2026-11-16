# Legacy Migration

This repository previously contained a `.winsh` script framework for an older
WinSH-era shell. That content does not match the current Niubash architecture.

## Preservation

Do not erase history. Preserve the old state with:

```sh
git tag legacy-pre-niubash-plugin-system
git branch legacy-pre-niubash-plugin-system
```

Then rebuild `main` as the official Niubash plugin bundle.

## What Changed

Old model:

- clone into `~/.oh-my-niu`;
- source `winshrc`;
- source theme and plugin scripts;
- configure plugin arrays in rc.

New model:

- clone this repository (or unpack its release zip) anywhere and source
  `oh-my-niu.niu` from `~/.niubashrc`; the bundle is not shipped with
  Niubash releases (the built-in plugin stack was retired, niubash#145);
- describe packs with `bundle.toml` and `packs/*/plugin.toml` as
  bundle-side packaging/review metadata;
- let users enable plugins and themes from `~/.niubashrc` through the
  framework's `NIU_PLUGINS` / `NIU_THEME` variables;
- keep Niubash's own plugin CLI state in `~/.niubash/plugins.json`
  (ecosystem sources; the pre-1.5.0 `plugins.toml` converts once via
  `niu plugin migrate`) — `~/.winshrc.toml` is never read by current
  Niubash and holds no state for either system;
- `~/.winshrc` is not a compatibility fallback: current Niubash never
  reads it (the only rc fallback is an opted-in `~/.bashrc`);
- update the bundle manually (`git pull` or a newer release zip);
  `niu plugin update` / `rollback` apply to ecosystem sources, not to
  this bundle.

## Zsh and Oh My Zsh

This repository is not an Oh My Zsh fork.

Niubash may provide a zsh migration command that detects familiar configuration
intent such as:

```zsh
plugins=(git zoxide)
```

The output should suggest Niubash plugins:

```text
oh-my-niu/git
oh-my-niu/zoxide
```

It should not call those zsh plugins, and it should not execute zsh plugin
source.
