# Keybinding Assets

This directory owns first-party keybinding preset metadata for Niubash.

These files are declarative metadata for native editor actions. They do
not execute ZLE widgets, do not source shell scripts, and do not create a zsh
runtime layer.

Current bundle-owned metadata:
- `common.toml`
- `emacs.toml`
- `vi.toml`

## How the presets reach the editor

The host's rc-level keybinding surface is the `NIU_BINDKEYS` variable:
newline-separated `keyspec:widget` entries that Niubash parses after
`~/.niubashrc` is sourced and layers over every keymap when it builds the
line editor. There is no host keybinding bridge API.

The `keybindings` plugin (`plugins/keybindings`) translates presets into
`NIU_BINDKEYS` entries at load:

- `common.toml` declares `keymap = "all"`, which is exactly the scope
  `NIU_BINDKEYS` has, so its bindings are installed. They are prepended
  ahead of any entries the user already declared, so user bindings keep
  the final word on a shared key, and entries already present are not
  duplicated on reload. Editing `common.toml` changes what gets
  installed.
- `emacs.toml` and `vi.toml` are mode-scoped, and `NIU_BINDKEYS` has no
  per-keymap scoping: installing them would land their entries in every
  keymap. The vi preset's plain-character motions (`h`, `l`, `0`) would
  break text entry in emacs mode, and its mode-switch actions
  (`vi-normal-mode`, `vi-insert-mode`) are not host widgets at all — the
  editor delivers vi mode switching natively. These two files are
  therefore reference data: they describe the bindings the host's
  default emacs and vi keymaps already deliver, and they are the
  translation source if the host ever grows a scoped rc surface.
