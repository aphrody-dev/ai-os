# Plugin Migration Status

Status: living checklist for the framework-first migration. Update this file
whenever a host-owned or manifest-only feature moves toward an Oh My-style
plugin directory.

> Host-integration re-audit, 2026-10-25, against Niubash master
> `b53e6bff` (post-1.4.4): the "host bridge" integration this checklist
> originally tracked was retired with Niubash's built-in plugin/theme
> stack (niubash#145). Niubash no longer reads bundle inventories,
> consumes `NIU_PROMPT_*` variables, gates bundled aliases/completions,
> or ships a gitstatus daemon. The framework now performs those roles
> itself (entry-point sourcing, PROMPT_COMMAND/DEBUG-trap hook wiring,
> prompt-core publishing `PS1`). "Current Cut" below reflects that;
> the coverage table's plugin rows are unchanged because they describe
> bundle-side ownership, not host behavior.

## Goal

Oh My Niu should feel like Oh My Zsh, fish plugin collections, and Oh My
Posh where that helps users:

- plugins are directories;
- themes are plugins;
- prompt support is a plugin API plus official prompt-core plugin;
- bundle metadata packages plugins but does not define all behavior;
- Niubash core exposes stable host APIs instead of owning high-level plugin
  behavior.

## Current Plugin Directory Coverage

| Feature | Directory Plugin | Status | Notes |
| --- | --- | --- | --- |
| Prompt API / Git status prompt | `plugins/prompt-core` | Directory + host bridge + gitstatus helper landed | Owns prompt API and Git prompt entry points; Niubash consumes plugin-selected prompt templates and host-provided Git snapshots when TOML prompt fields are unset. |
| Git workflow | `plugins/git` | Directory landed | Owns aliases/functions/completion metadata reference; no longer claims prompt ownership. |
| Common aliases | `plugins/common-aliases` | Started | Small Oh My-style navigation/listing aliases with matching alias asset metadata. |
| Docker | `plugins/docker` | Started | Loads alias asset and shell helpers. |
| Kubectl | `plugins/kubectl` | Started | Loads alias asset and context helpers. |
| npm | `plugins/npm` | Started | Loads alias asset and run-script helpers. |
| PATH helpers | `plugins/path-tools` | Started | Fish-style PATH inspection/edit helpers in trusted source code. |
| Extract helper | `plugins/extract` | Started | Common archive extraction function with explicit required tool checks. |
| zoxide | `plugins/zoxide` | Started | Registers startup/precmd/chpwd hooks through framework hook API. |
| direnv | `plugins/direnv` | Started | Registers environment apply hooks through framework hook API. |
| dotenv | `plugins/dotenv` | Started | Registers `.env` load hooks through framework hook API. |
| fzf | `plugins/fzf` | Started | Provides current-shell directory selector helpers. |
| last-working-dir | `plugins/last-working-dir` | Started | Registers restore/save hooks through framework hook API. |
| thefuck | `plugins/thefuck` | Started | Provides correction shim function. |
| Default theme | `plugins/theme-default` | Started | Migrates the old core `default` theme into an official plugin asset. |
| Dark theme | `plugins/theme-dark` | Started | Migrates the old core `dark` theme into an official plugin asset. |
| Light theme | `plugins/theme-light` | Started | Migrates the old core `light` theme into an official plugin asset. |
| Colorful theme | `plugins/theme-colorful` | Started | Migrates the old core `colorful` theme into an official plugin asset. |
| Minimal theme | `plugins/theme-minimal` | Started | Theme plugin selects theme asset and prompt template. |
| Classic theme | `plugins/theme-classic` | Started | Two-line user/context theme using prompt-core tokens. |
| Pure theme | `plugins/theme-pure` | Started | Pure-inspired two-line theme using prompt-core tokens. |
| Compact theme | `plugins/theme-compact` | Started | Short cwd-basename prompt for dense terminal sessions. |
| Cyberpunk theme | `plugins/theme-cyberpunk` | Started | Theme plugin selects theme asset and prompt template. |
| Forest theme | `plugins/theme-forest` | Started | Theme plugin selects theme asset and prompt template. |
| Ocean theme | `plugins/theme-ocean` | Started | Theme plugin selects theme asset and prompt template. |
| Powerlevel lean theme | `plugins/theme-p10-lean` | Started | Official p10-style theme plugin using true-colour TOML. |
| Powerlevel classic theme | `plugins/theme-p10-classic` | Started | Official p10-style theme plugin using true-colour TOML. |
| Powerlevel rainbow theme | `plugins/theme-p10-rainbow` | Started | Official p10-style theme plugin using true-colour TOML. |
| Powerlevel pure theme | `plugins/theme-p10-pure` | Started | Official p10-style theme plugin using true-colour TOML. |
| Robby Russell theme | `plugins/theme-robbyrussell` | Started | Oh My-style default-theme analogue as an official plugin. |
| Keybindings | `plugins/keybindings` | Source | Installs the all-keymap preset into the `NIU_BINDKEYS` rc variable at load; the emacs/vi presets are reference data because `NIU_BINDKEYS` has no per-keymap scoping. |
| command-not-found | `plugins/command-not-found` | Bridge | Provider still host-bound; plugin owns feature identity. |
| Completion frontend | none | Host-bound | Keep in Niubash/Reedline until a stable completion-provider plugin API exists. |
| Syntax highlighting | none | Host-bound | Keep in Niubash/Reedline until a stable highlighter plugin API exists. |

## Current Cut

- `oh-my-niu.niu` is now the framework entry point.
- `plugins/` is the active runtime surface for official plugins and themes.
- `plugins/theme-*` replaces the old idea of one `themes` builtin plugin.
- Theme names `default`, `dark`, `light`, and `colorful` are matching official
  theme plugins in the bundle. Niubash core exposes theme APIs and loaders; it
  does not own these themes.
- Theme assets now support true-colour `#RRGGBB`, background colours, and
  additional style flags so theme plugins can be tuned at finer granularity.
- `plugins/git` is workflow-only; prompt Git status belongs to
  `plugins/prompt-core`.
- `plugins/command-not-found` is a bridge plugin so users and docs see
  plugin-owned identity while Niubash still owns the provider call site.
  `plugins/keybindings` stopped being one: no host keybinding bridge
  exists, so the plugin now installs its all-keymap preset through the
  `NIU_BINDKEYS` rc variable instead (see `keybindings/README.md`).
- Directory plugins replaced same-named legacy packs inside this
  bundle: `prompt-core` replaces the old `prompts` pack surface, and
  `theme-*` replaces the old `themes` pack surface in the bundle
  inventory. (An earlier host release also read `plugins/<name>/plugin.toml`
  from the bundle into its own inventory; that host integration is
  retired — `plugin.toml` is bundle-side metadata now.)
- Framework enablement gates what the framework itself loads:
  `NIU_PLUGINS` controls which plugin directories the entry point
  sources, and disabling `git` therefore removes its aliases,
  functions, and hooks from the session. (An earlier host release
  also gated official aliases and completion definitions from the
  host side; that host integration is retired, and host completion
  tables load from user completion directories, not from enablement.)
- `prompt-core` publishes the prompt itself: its precmd hook renders
  `NIU_PROMPT_LEFT` and assigns `PS1`, driven by the framework's
  `PROMPT_COMMAND` dispatch. (The earlier host prompt bridge that
  consumed `NIU_PROMPT_LEFT`, `NIU_PROMPT_RIGHT`, `NIU_ACTIVE_THEME`,
  and `NIU_PROMPT_SYMBOL` was retired with the built-in stack,
  niubash#145. Native TOML prompt configuration on the host side is
  unaffected — it belongs to sessions that do not load prompt-core.)
- The Git prompt snapshot is framework-maintained: `prompt-core`
  consumes `NIU_PROMPT_GIT` for `{git}`/`{git_prompt}`, refreshed by
  its own backends (legacy/shell via `lib/git.niu`, starship via
  Starship modules, native = externally supplied snapshot). No host
  `--gitstatus-daemon` exists on current Niubash; late Git work warms
  a later prompt instead of repainting the active input line because
  rendering only reads the snapshot string.
- The old manifest-first `packs/` tree remains only as compatibility and
  package-review metadata during migration.
- `tools/smoke_framework.niu` verifies the directory loader, official themes,
  devtool aliases/functions, and hook plugins with an installed Niubash binary.
  Runtime findings are tracked in `docs/framework-smoke-notes.md`.

## Next Work

1. Broaden daemon-backed Git snapshot tests around dirty/chpwd/git-command
   invalidation.
2. Move from host template compatibility toward a fuller prompt API renderer
   once segment/provider contracts are stable.
3. Convert bridge plugins to real plugins when Reedline/provider APIs are
   stable enough.
5. Keep reducing `PluginKind::Builtin` for first-party behavior; leave host
   ownership only for Reedline-bound completion/highlighting/keybinding
   frontends until a real provider API exists.
