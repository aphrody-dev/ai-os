# Authoring Templates

Copy the template that matches the runtime kind you need, then rename the pack
and adjust permissions before adding it to `bundle.toml`.

- `builtin/plugin.toml`: first-party Niubash runtime behavior with bundle-owned
  static assets.
- `source/plugin.toml`: Oh My-style Niubash shell code sourced into the current
  interactive session from a bundle-local `.niu` file.
- `process/plugin.toml`: explicit opt-in adapter around an existing native
  command.
- `wasm/plugin.toml`: explicit opt-in WASM command template for future
  sandboxed packs.

Run `python tools/validate_bundle.py` after copying a template into
`packs/<name>/plugin.toml`.
