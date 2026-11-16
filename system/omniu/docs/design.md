# Oh My Niu Framework Design

Status: active direction. This replaces the retired manifest-first bundle design
in `docs/design-manifest-first-retired.md`.

## Product Thesis

Oh My Niu should be a shell plugin framework and first-party plugin
distribution, not a thin registry over Niubash builtins.

Niubash may ship the official bundle, but bundled does not mean built in. A
plugin can be present by default, reviewed by default, and installed with the
shell while still being loaded through the same plugin system that third-party
plugins use.

The shell core should provide primitives:

- source code into the current interactive shell;
- register lifecycle hooks;
- register aliases, functions, completions, keybindings, and prompt providers;
- expose safe host helpers for expensive Windows-native work;
- install, update, disable, and roll back plugins.

The plugin framework should provide composition:

- plugin discovery and load order;
- framework libraries;
- official plugin directories;
- theme loading;
- user override paths;
- simple authoring conventions.

## Lessons To Copy

Oh My Zsh's useful idea is not zsh syntax. It is that plugins are directories
loaded into the current shell in a predictable order, and users understand the
model immediately: list plugins, source framework, let the framework load them.

Fish's useful idea is filesystem convention. Functions, completions, and startup
fragments are discoverable by directory layout. Plugin authors should be able to
drop files into known places without writing a host registry integration.

PowerShell/Oh My Posh's useful idea is separation of prompt engine, themes, and
shell profile. Prompt data can use fast native helpers, but themes and prompt
composition should remain plugin-owned and user-overridable.

The thing to avoid is making Niubash core the owner of every high-level feature.
That creates "builtin plugins", which defeats the point of a plugin ecosystem.

## Vocabulary

- `niubash core`: shell host, REPL, config loader, plugin loader, permissions,
  completion frontend, prompt frontend, update/rollback, and host helper APIs.
- `oh-my-niu framework`: the sourced shell framework entry point,
  framework libraries, loader conventions, and default composition.
- `plugin`: a directory that may contain shell code, functions, completions,
  prompt/theme files, metadata, and tests.
- `bundle`: a distributable archive containing many plugins plus index metadata.
  A bundle is packaging, not a runtime kind.
- `theme`: a plugin whose main export is prompt composition and styling.

## Target User Model

The interactive setup should eventually feel like this:

```sh
NIU_PLUGINS=(git docker zoxide)
NIU_THEME=minimal
source "$NIUBASH/oh-my-niu.niu"
```

The structured TOML control plane can still exist for managed installs,
permissions, migration state, tests, and enterprise-safe updates, but it should
map onto the same plugin directories and loader instead of defining a separate
user-facing product model.

```toml
[plugins]
enabled = true
bundles = ["oh-my-niu"]
load = ["prompt-core", "git", "docker", "zoxide"]

[theme]
current_theme = "minimal"
```

Both examples describe the same thing: load plugins through the framework.

## Repository Shape

The target layout is directory-first:

```text
oh-my-niu/
  oh-my-niu.niu
  lib/
    aliases.niu
    git.niu
    prompt.niu
    hooks.niu
  plugins/
    prompt-core/
      prompt-core.plugin.niu
      plugin.toml
    git/
      git.plugin.niu
      functions/
      completions/
      plugin.toml
      README.md
    docker/
      docker.plugin.niu
      completions/
      plugin.toml
    common-aliases/
      common-aliases.plugin.niu
      plugin.toml
    path-tools/
      path-tools.plugin.niu
      plugin.toml
    extract/
      extract.plugin.niu
      plugin.toml
    theme-minimal/
      theme-minimal.plugin.niu
      plugin.toml
    theme-default/
      theme-default.plugin.niu
      plugin.toml
    theme-dark/
      theme-dark.plugin.niu
      plugin.toml
    theme-light/
      theme-light.plugin.niu
      plugin.toml
    theme-colorful/
      theme-colorful.plugin.niu
      plugin.toml
    theme-classic/
      theme-classic.plugin.niu
      plugin.toml
    theme-pure/
      theme-pure.plugin.niu
      plugin.toml
    theme-compact/
      theme-compact.plugin.niu
      plugin.toml
    theme-cyberpunk/
      theme-cyberpunk.plugin.niu
      plugin.toml
    theme-forest/
      theme-forest.plugin.niu
      plugin.toml
    theme-ocean/
      theme-ocean.plugin.niu
      plugin.toml
    theme-p10-lean/
      theme-p10-lean.plugin.niu
      plugin.toml
    theme-p10-classic/
      theme-p10-classic.plugin.niu
      plugin.toml
    theme-p10-rainbow/
      theme-p10-rainbow.plugin.niu
      plugin.toml
    theme-p10-pure/
      theme-p10-pure.plugin.niu
      plugin.toml
    theme-robbyrussell/
      theme-robbyrussell.plugin.niu
      plugin.toml
    keybindings/
      keybindings.plugin.niu
      plugin.toml
    command-not-found/
      command-not-found.plugin.niu
      plugin.toml
  themes/
    default.toml
    dark.toml
    light.toml
    colorful.toml
    minimal.toml
    classic.toml
    pure.toml
    compact.toml
    cyberpunk.toml
    forest.toml
    ocean.toml
    p10-lean.toml
    p10-classic.toml
    p10-rainbow.toml
    p10-pure.toml
    robbyrussell.toml
  bundle.toml
  index.toml
```

The existing `packs/`, `aliases/`, `completions/`, `prompts/`, and `themes/`
directories are transitional compatibility surfaces. New work should move
toward plugin directories that own their own code and assets.

## No Builtin Plugin Behavior

Niubash core may ship host primitives, but high-level plugin behavior must not
be implemented as a permanent core-owned pack. Missing official bundles or
theme plugins should be diagnosed loudly instead of silently falling back to a
different built-in theme.

Allowed in core:

- the plugin loader;
- the hook dispatcher;
- prompt and completion host interfaces;
- fast host helpers such as cached Git status;
- sandbox/process execution machinery;
- bundled plugin archive discovery.

Not allowed as the long-term model:

- `git` aliases owned by core;
- `zoxide` commands owned by core;
- themes owned by core;
- prompt presets owned by core;
- first-party completion definitions owned by core.

If a feature is user-visible as a plugin, it should be represented by a plugin
directory. A plugin may call a native helper, but the helper is not the plugin.

## Prompt And Theme Model

Prompt rendering must be stable and plugin-owned.

- The default prompt should be simple, one-line, and ASCII-safe.
- Prompt content should not pop into an already-rendered input line because a
  background worker finished late.
- Expensive prompt data can be cached by core helpers, but each prompt render
  should use a coherent snapshot.
- Git prompt should be a prompt-service capability owned by the official
  `prompt-core` plugin. The `git` plugin owns Git aliases, completions, and
  workflow helpers; it does not own prompt rendering.
- Themes are plugins. A bundled theme is still a plugin, not core behavior.
- Theme names such as `default`, `dark`, `light`, and `colorful` are official
  `theme-*` plugins in the bundle, not Niubash core themes. Missing bundle
  themes are installation/package errors.
- Theme style TOML supports named colours, 256-colour indexes, and true-colour
  `#RRGGBB` foreground/background values, plus bold/italic/underline/dimmed
  flags.
- The prompt subsystem needs a standard API surface so third-party themes can
  register segments, select renderers, and ask for cached status without
  depending on Niubash internals.

Target split:

```text
core helper       optional native prompt helper API
prompt-core       prompt API, prompt lifecycle, gitstatus client/cache
git plugin        aliases, completion, Git workflow helpers
theme plugin      prompt layout, colors, selected segments
user config       chooses plugins and theme
```

This matches the Oh My Zsh mental model while allowing Niubash to keep native
Windows performance optimizations behind helper commands.

## Prompt API Direction

Niubash should expose a small stable prompt API to plugins. The API belongs to
the shell/plugin boundary, not to any specific theme:

- `NIU_PROMPT_LEFT` and `NIU_PROMPT_RIGHT` hold the active prompt
  templates or function names.
- `niubash_prompt_use_template <left> [right]` selects a simple template prompt.
- `niubash_prompt_register_segment <name> <function>` registers a segment
  provider.
- Built-in template tokens include `{cwd}`, `{cwd_base}`, `{user_host}`,
  `{git}`, `{status}`, `{time}`, `{command_execution_time}`, `{newline}`, and
  `{prompt_char}`.
- `niubash_prompt_render_left` and `niubash_prompt_render_right` are the
  standard render entry points that the shell can call before drawing a prompt.
- Renderers should evaluate only the segments present in the active template.
  Late or unused segment work must not print into the terminal.
- Prompt plugins may use native helpers, but shell core should treat those
  helpers as implementation details behind the API.

Host bridge status (re-audited 2026-10-25 against Niubash master
`b53e6bff`): the bridge described below was retired with the built-in
plugin stack (niubash#145). Current Niubash consumes none of
`NIU_PROMPT_LEFT`, `NIU_PROMPT_RIGHT`, `NIU_ACTIVE_THEME`, or
`NIU_PROMPT_GIT`. The framework therefore closes the circuit itself:
`prompt-core`'s precmd hook renders the active template and assigns
`PS1`, driven by the framework's `PROMPT_COMMAND` dispatch
(`lib/hooks.niu`). The bridge design is kept here as history:

- When the user has not set explicit TOML prompt fields, Niubash consumes
  `NIU_PROMPT_LEFT`, `NIU_PROMPT_RIGHT`, `NIU_ACTIVE_THEME`, and
  `NIU_PROMPT_SYMBOL` from `prompt-core` and the active theme plugin after
  startup/precmd hooks run. It also consumes `NIU_PROMPT_GIT` as the
  current complete Git prompt snapshot for `{git}`/`{git_prompt}` tokens.
- Explicit TOML prompt configuration stays authoritative. A user-set
  `prompt_format`, `right_prompt_format`, prompt style, or segment preset must
  not be replaced by plugin defaults.
- The bridge renders the shared prompt-core token names through the host
  template backend today. A later prompt API can call richer plugin renderers or
  segment providers directly without moving prompt ownership back into core.

The default prompt path should come from official plugins:

- `prompt-core`: installs the prompt API, segment registry, stable rendering
  contract, and prompt data helpers.
- `theme-minimal`, `theme-classic`, etc.: select layouts and colors.
- `git`: installs Git commands and workflow helpers, not the Git prompt owner.

## Gitstatus Service Direction

Status (2026-10-25): no `--gitstatus-daemon` exists in current
Niubash, and the host side of this design was retired with the
built-in stack (niubash#145). The snapshot half of the design is
live and owned by the framework: `prompt-core` renders only the
`NIU_PROMPT_GIT` snapshot string, refreshed by its own backends.
The daemon below remains an unbuilt design option, kept for the
record.

The current prompt rendering feels wrong when asynchronous Git status finishes
after the prompt has already been drawn and then causes visible redraw churn.
Reducing latency is not enough; the render model must be visually stable.

The Powerlevel10k lesson is that Git status should be served by a persistent
service with a coherent snapshot model:

- Niubash starts a long-lived hidden `--gitstatus-daemon` helper so Git work is
  outside the prompt draw path;
- `prompt-core` consumes `NIU_PROMPT_GIT` as the stable snapshot string
  instead of launching Git during prompt rendering;
- the host talks to that helper through a stable request/response API;
- each prompt render uses the latest complete snapshot available at render
  start;
- late results warm the next prompt, not mutate the prompt the user is typing
  into;
- repositories can have layered caches keyed by worktree, HEAD, index mtime,
  and status generation.

This can be bundled and official without becoming a shell builtin. The daemon
or helper may ship with Niubash for performance, but the behavior is owned by
the `prompt-core` plugin and consumed through the prompt API.

## Loading Order

The framework loader should be predictable:

1. Start from user `~/.niubashrc`, which sets plugin/theme variables and
   sources `oh-my-niu.niu`.
2. Establish `NIUBASH`, `NIU_CUSTOM`, and plugin search paths.
3. Source framework libraries from `lib/*.niu`.
4. Resolve enabled plugins from the rc shell arrays (`NIU_PLUGINS`).
5. Source each plugin's `*.plugin.niu` in user-declared order.
6. Register plugin-local functions, completions, hooks, and prompt providers.
7. Source the selected theme plugin through `NIU_THEME_PLUGIN`.
8. Return to `~/.niubashrc`; user code after the framework source overrides
   plugin defaults. `~/.niubashrc` is the only rc the host reads for
   this: current Niubash never reads `~/.winshrc` or `~/.winuxshrc`,
   so there is no host-level legacy fallback to keep.

Disable must mean disable. If `git` is absent from `NIU_PLUGINS`, the Git plugin's
aliases, functions, completion exports, prompt segment, and theme hooks must all
be absent unless the user re-adds them manually.

This includes compatibility bridge behavior. Official compiled aliases and
command completion definitions may only support enabled official plugins during
migration; they must not form a second hidden plugin system. External bundles
must provide their own assets instead of silently borrowing official compiled
behavior, and disabling a plugin must disable its bridge behavior too.

## Authoring Rule

A useful third-party plugin should start with a directory and one shell file,
not a manifest ceremony:

```text
plugins/example/example.plugin.niu
```

`plugin.toml` remains valuable for package metadata, permissions, review, and
updates, but a missing manifest should not block a local trusted source plugin.

The manifest should answer install-time questions:

- name, version, description, author;
- required host capabilities;
- external commands used;
- lifecycle hooks exported;
- files or env variables touched;
- update source and checksum policy.

It should not be the only way to express shell behavior.

## Migration Plan

1. Add the framework entry point `oh-my-niu.niu`.
2. Add directory-first plugin loading beside the current manifest loader.
3. Move official `git` behavior into `plugins/git/`.
4. Move official themes into `theme-*` plugins and make `themes` only a
   transitional asset/catalog surface.
5. Make Git prompt rendering opt-in through `prompt-core` and theme
   plugin ownership.
6. Keep existing manifest/bundle update commands as packaging and permission
   surfaces over plugin directories.
7. Keep prompt late-redraw behavior out of the render path with
   `prompt-core` snapshot rendering and the persistent gitstatus helper.
8. Retire core-owned `PluginKind::Builtin` behavior for first-party plugins once
   each plugin has an equivalent directory implementation or an explicit bridge
   plugin.

## Compatibility

The existing manifest-first bundle should continue to load during migration, but
new feature work should not add more core-owned builtin packs. Add new behavior
as framework/plugin code first. Add native helpers only when shell code needs a
fast, stable, Windows-native primitive.

The direction is framework-first, directory-first, and plugin-owned.
