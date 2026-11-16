# Externalization Readiness
This document classifies official bundle behavior during the framework-first
migration. The active runtime target is `plugins/<name>/`; old `packs/`
manifests remain a packaging and review surface. Niubash does not load
directory plugins — the host integration this classification was
written against was retired with the built-in plugin stack
(niubash#145) — so the framework entry point is the only loader, and
"missing host API" below means "no host surface exists", not "pending
host work" unless a row says otherwise.

## Current Bundle Facts
- Static bundle assets still cover aliases, completion tables, prompt presets,
  keybinding metadata, and theme style TOML.
- Directory plugins are now the product surface. `plugin.toml` describes
  package/review metadata; `<name>.plugin.niu` owns runtime behavior.
- Source plugins are reviewed bundle-local `.niu` startup and lifecycle
  scripts. They are the Oh My-style path for first-party shell helpers that
  intentionally define aliases, functions, exports, cwd changes, or hook glue
  in the current interactive shell.
- Bridge plugins identify features whose low-level call site is still
  Niubash/Reedline-owned. They are temporary ownership markers, not a final
  runtime kind for third-party behavior.
- WASM packs are command-only today. They can read args, cwd, and explicitly
  allowed env values, but they cannot act as completion, prompt, hook, or
  command-not-found or other providers yet.
- Process packs declare native commands and lifecycle metadata, but
  current Niubash executes neither process packs nor any
  command-not-found provider binding; source plugins are the current
  shell-effect path.
- Shell-mutating WASM/provider packs still need explicit host APIs before they
  can mutate env/cwd/history outside trusted source code.
- The `execution_model`, `externalization_class`, and readiness profile
  values for these rows are this document's own classification. An
  earlier host release derived them on a `niu plugin review` surface;
  that verb is retired and nothing exposes the values today.
- `exports.providers` is a guarded provider marker only. No provider
  binding is implemented in current Niubash — in particular there is
  no command-not-found binding for `command:diagnose` — and the marker
  does not make command-style WASM act as a provider.

## Pack Matrix
| Feature | Current surface | Classification | Target runtime / execution model | Missing host API or decision | Shell-mutating | Fallback needed |
| --- | --- | --- | --- | --- | --- | --- |
| `prompt-core` | `plugins/prompt-core` | Prompt API source plugin | Prompt segment registry, render entry points, framework-maintained `NIU_PROMPT_GIT` snapshot | Richer host prompt call-in | No direct mutation | Yes |
| `git` | `plugins/git` | Source workflow helper plus declarative assets | `.niu` aliases/functions plus alias/completion assets | Remove core fallback alias injection when plugin disabled | Yes, by trusted source | Minimal |
| `common-aliases` | `plugins/common-aliases` | Source alias helper plus declarative asset | Small Oh My-style aliases owned by the plugin directory | None for current first-party helper scope | Yes, by trusted source | Minimal |
| `docker` | `plugins/docker` | Source helper plus declarative assets | `.niu` helpers plus alias/completion assets | None for current first-party helper scope | Yes, by trusted source | Minimal |
| `kubectl` | `plugins/kubectl` | Source helper plus declarative assets | `.niu` helpers plus alias/completion assets | None for current first-party helper scope | Yes, by trusted source | Minimal |
| `npm` | `plugins/npm` | Source helper plus declarative assets | `.niu` helpers plus assets; dynamic completion can move later | Completion/provider ABI | Yes, by trusted source | Yes |
| `path-tools` | `plugins/path-tools` | Source shell-effect helper | PATH list/prepend/append/remove/dedupe functions | Structured env-effect API only if sandboxed provider is needed | Yes, by trusted source | Minimal |
| `extract` | `plugins/extract` | Source external-tool helper | Archive extraction function with explicit tool checks | Optional command/provider ABI for sandboxed archive helpers | Yes, by trusted source | Minimal |
| `zoxide` | `plugins/zoxide` | Source shell-effect helper | `.niu` `z`/`zi` helpers plus startup/precmd/chpwd tracking | Future sandboxed cwd effect API only if needed | Yes, by trusted source | Minimal |
| `direnv` | `plugins/direnv` | Source shell-effect helper | `.niu` lifecycle adapter around `direnv export bash` | Future structured env-effect API only if sandboxed/runtime provider is needed | Yes, by trusted source | Minimal |
| `dotenv` | `plugins/dotenv` | Source shell-effect helper | `.niu` scoped `.env` loader on startup/precmd/chpwd | Future parser hardening and sandboxed file/env effect API | Yes, by trusted source | Minimal |
| `fzf` | `plugins/fzf` | Source shell-effect helper | `.niu` directory selector functions that `cd` in-session | Interactive provider policy only if moving away from source | Yes, by trusted source | Minimal |
| `last-working-dir` | `plugins/last-working-dir` | Source shell-effect helper | `.niu` startup restore plus chpwd cache write | Future structured cache/cwd effect API only if sandboxed runtime is needed | Yes, by trusted source | Minimal |
| `thefuck` | `plugins/thefuck` | Source external-tool helper | `.niu` function that evaluates reviewed `thefuck` output in-session | Better history context/provider API for richer suggestions | Yes, by trusted source | Minimal |
| `theme-*` | `plugins/theme-*` | Source theme plugins plus style assets | Theme plugin selects layout, symbol, colors, prompt template, and true-colour style data | Richer prompt style/render API | No | Minimal |
| `keybindings` | `plugins/keybindings` | Source plugin over keybinding assets | Translates the all-keymap preset into `NIU_BINDKEYS` entries at load; emacs/vi presets are reference data | Per-keymap scoping in the host rc surface before the mode-scoped presets can be installed | No | Minimal |
| `command-not-found` | `plugins/command-not-found` | Bridge over host provider | Directory plugin identity; provider can later move to process/WASM provider ABI | Provider entrypoint and migration decision | No | Yes |
| Old `prompts` pack | `packs/prompts` | Transitional compatibility asset | Fold prompt presets into `prompt-core`/theme plugins | Host prompt API and compatibility migration | No | Yes |
| Old `themes` pack | `packs/themes` | Transitional compatibility asset | Superseded by `theme-*` plugins, including migrated `default`/`dark`/`light`/`colorful` and p10-style themes | Keep as catalog/review metadata | No | Minimal |

## Next Bundle Work
1. (Done/obsolete) Managed-config parity: Niubash's managed config is
   the ecosystem-sources spec in `~/.niubash/plugins.json`, which does
   not describe this bundle; the framework loader is driven by the rc
   arrays only.
2. (Done/obsolete) Host fallback injection: the host no longer injects
   official aliases/completions at all (niubash#145), so there is no
   fallback left to stop.
3. Keep reducing legacy `packs/prompts` and `packs/themes` to package-review
   metadata now that `prompt-core` and `theme-*` plugins own prompt behavior.
4. Broaden framework snapshot coverage around chpwd/git-command
   invalidation, dirty compact coloring, and stale snapshot handling.
5. Use [command-not-found](command-not-found-provider-abi.md) to design the
   first real provider migration if a host ever grows a provider API;
   no such binding exists today.
