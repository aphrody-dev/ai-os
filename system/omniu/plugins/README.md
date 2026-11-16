# Plugin Directories

This directory is the framework-first plugin surface.

Each plugin should own its code and assets under one directory:

```text
plugins/name/
  name.plugin.niu
  plugin.toml
  functions/
  completions/
  themes/
```

The older `packs/`, `aliases/`, `completions/`, `prompts/`, and `themes/`
directories remain transitional bundle assets. New user-visible behavior should
start here first, then expose metadata through `plugin.toml` when packaging,
permission review, or managed updates need it.
