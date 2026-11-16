# Historical Oh My Niu Roadmap

Status: historical. This roadmap describes the manifest-first bundle phases that
were implemented before the framework-first direction reset. Keep it for
release archaeology and compatibility context, but do not use it as the active
design source for new plugin-system work.

The active direction is [design.md](design.md): plugin directories first,
themes as plugins, bundled distribution without core-owned builtin plugin
behavior, and manifests as packaging/review metadata over the plugin system.

This roadmap is synchronized with Niubash's plugin-system roadmap. Phase numbers
must stay aligned with `DOCS/plugin-system-roadmap.md` in the Niubash repo.

`oh-my-niu` is the official bundled plugin distribution for Niubash. It is
not an Oh My Zsh fork, not a zsh plugin runtime, and not the legacy `.winsh`
script framework. It can ship reviewed bundle-local `.niu` source packs
through the Niubash manifest/permission model.

## Phase 0 - Repository Reset

Status: done on this branch.

- Preserve the old repository content with a legacy branch/tag.
- Replace the working branch with bundle metadata.
- Remove old `.winsh` script-framework content from the active product surface.
- Document that zsh migration is only an onboarding source.

Done when:

- The branch contains `bundle.toml`, `packs/`, and docs.
- The README no longer instructs users to source `winshrc`.

## Phase 1 - Manifest Baseline

Status: done on this branch.

- Add `bundle.toml`.
- Add `packs/<name>/plugin.toml` for:
  - `git`;
  - `docker`;
  - `kubectl`;
  - `npm`;
  - `zoxide`;
  - `direnv`;
  - `dotenv`;
  - `fzf`;
  - `command-not-found`;
  - `last-working-dir`;
  - `thefuck`;
  - `keybindings`;
  - `prompts`.
- Keep pack names, defaults, categories, permissions, and exports aligned with
  Niubash's builtin registry.

Done when:

- All TOML files parse.
- Every pack in `bundle.toml` has a matching `packs/<name>/plugin.toml`.
- `niubash plugin list` can represent the same pack set.

## Phase 2 - Managed Config Support

Status: done on this branch.

oh-my-niu work:

- Document canonical enable/disable examples:
  - `[plugins]`;
  - `[plugins.<pack>]`;
  - permissions.
- Keep permissions minimal and auditable.
- Add validation for:
  - missing pack directories;
  - missing manifest fields;
  - pack list drift between `bundle.toml` and `packs/`;
  - unknown runtime kind/category.
  - exported asset directory presence.

Niubash dependency:

- Done in the paired Niubash branch:
  - `niubash plugin plan enable/disable <pack>`;
  - `niubash plugin enable/disable <pack>`;
  - managed TOML block writes with backups;
  - refusal to overwrite user-authored `[plugins]`.

Done when:

- Manifest permissions are exactly what Niubash writes into managed TOML.
- Docs tell users to use `niubash plugin ...`, not to edit rc for plugin state.
- `python tools/validate_bundle.py` passes.

## Phase 3 - Runtime Activation Assets

Status: done on this branch.

oh-my-niu work:

- Add asset directories:
  - `aliases/`;
  - `completions/`;
  - `prompts/`;
  - `keybindings/`.
- Split data assets from manifests.
- Mark which packs are pure metadata, which use `.niu` source helpers, and
  which still need Niubash builtin code.
- Add tests that exported assets exist.

Niubash dependency:

- Done in the paired Niubash branch:
  - effective plugin state resolves `[plugins]`, bundle defaults, and legacy
    migration reads;
  - `git` enables/disables the official source/assets pack;
  - `docker`, `kubectl`, and `npm` source/assets packs activate from canonical
    `[plugins]` state with Niubash compiled fallback data where needed;
  - `zoxide` and other existing builtin shims can be activated from
    canonical `[plugins]` state;
  - explicit `keybindings` disable blocks legacy native widget presets and
    imported bindkey suggestions;
  - explicit `prompts` disable prevents Niubash segment prompt presets from
    activating while leaving the core template prompt renderer available.

Done when:

- Enabling a pack through `[plugins]` can activate its existing Niubash builtin
  behavior.
- Static assets can be loaded from the bundle when present.

## Phase 4 - Bundled Release Baseline

Status: done on this branch for deterministic local release artifacts.

oh-my-niu work:

- Produce a deterministic release zip:
  - `bundle.toml`;
  - `packs/`;
  - static asset directories;
  - docs;
  - checksum.
- Keep layout stable so Niubash installers can embed it.
- Provide `tools/package_bundle.py` for deterministic zip and SHA-256 output.

Niubash dependency:

- Bundle install path and `plugin-lock.toml`.
- `niubash plugin bundle status`.
- Installed bundle manifest loading with compiled registry fallback.

Done when:

- A Niubash release can include this bundle and run offline.
- The active bundle version can be inspected.
- `py tools\package_bundle.py --check` passes.

## Phase 5 - Independent Update and Rollback

Status: in progress on the paired Niubash branch.

oh-my-niu work:

- Publish GitHub releases with:
  - `oh-my-niu-{version}.zip`;
  - checksum;
  - changelog;
  - compatibility notes.
- Follow semver:
  - patch: manifest or asset fix;
  - minor: new pack or safe permission expansion;
  - major: breaking manifest/API change.

Niubash dependency:

- `niubash plugin update oh-my-niu --from <bundle-dir-or-zip>`.
- `niubash plugin rollback oh-my-niu`.
- Atomic `plugin-lock.toml` switching with active and previous bundle paths.
- Optional SHA-256 validation through `--checksum` or `--checksum-file`.

Current branch progress:

- `CHANGELOG.md` and `docs/compatibility.md` now document the publishable
  release notes, bundle API, protocol versions, minimum host, and semver policy.
- `tools/validate_bundle.py` requires release notes and compatibility docs, so
  missing publish metadata fails the release gate.
- `tools/package_bundle.py` includes `CHANGELOG.md`; docs already ship through
  the `docs/` release directory.
- `tools/package_bundle.py` emits the zip and `.sha256` artifacts consumed by
  local `niubash plugin update`.
- The paired Niubash branch can install local bundle directories or zips,
  validate bundle API, `min_niubash`, manifests/API, and roll back by
  switching the lock file.
- `bundle.toml` now declares `api = "niubash:plugin-bundle@0.1.0"`
  and `min_niubash = "0.10.0"`; the validator treats both as release
  metadata.
- The paired Niubash branch validates bundle-level API and refuses updates
  whose `min_niubash` is newer than the running host.
- The paired Niubash branch can download `--github-release latest|vX.Y.Z` from
  `unixwin/oh-my-niu`, fetch the matching `.sha256`, and enter the same
  validated local update path.
- GitHub release publishing remains the next layer after local and downloaded
  artifact install/rollback.

Done when:

- Users can update this bundle without updating `niubash.exe`.
- Failed update verification leaves the current bundle active.

## Phase 6 - First-Party Asset Ownership

Status: implemented on this branch.

oh-my-niu work:

- Own first-party alias tables, completion definitions, prompt presets, and
  keybinding metadata where safe.
- Keep changelog entries for changed defaults or aliases.
- Add compatibility tests for exported assets.

Current branch progress:

- `aliases/git.toml`, `aliases/docker.toml`, `aliases/kubectl.toml`, and
  `aliases/npm.toml` now own the first-party alias tables for the devtool
  source/assets packs.
- `tools/validate_bundle.py` checks that every pack with `exports.aliases = true`
  has a parseable non-empty `aliases/<pack>.toml` file.
- The paired Niubash branch loads active bundle aliases before compiled fallback
  aliases, so a bundle release can change aliases without replacing
  `niubash.exe`.
- `completions/git.toml`, `completions/docker.toml`,
  `completions/kubectl.toml`, and `completions/npm.toml` now own first-party
  static completion definitions for the same devtool packs.
- `packs/winuxcmd-core/plugin.toml` exports generated static completions for
  WinuxCmd core command links, keeping the large completion asset set in the
  official bundle instead of the shell runtime fallback.
- `tools/validate_bundle.py` checks every exported completion has a matching
  parseable `completions/<name>.toml` file whose `command` matches the export.
- `prompts/segments.toml` now owns first-party prompt segment mappings and the
  `lean`, `classic`, `rainbow`, `pure`, and `robbyrussell` preset layouts.
- `keybindings/common.toml`, `keybindings/emacs.toml`, and
  `keybindings/vi.toml` now own declarative keybinding metadata for native
  Niubash editor actions. They do not execute ZLE widgets or shell scripts.
- `tools/validate_bundle.py` checks exported prompt segments resolve to
  declared assets, preset segment references are valid, and exported
  keybinding metadata has non-empty key/action pairs.
- The paired Niubash branch loads active bundle prompt presets before compiled
  fallback presets while keeping user-authored prompt element overrides
  authoritative.
- The paired Niubash branch surfaces active bundle keybinding metadata through
  `niubash plugin info keybindings`, proving keymap summaries and binding counts
  can update independently from `niubash.exe`.

Niubash dependency:

- Bundle asset loader with compiled fallback and user-visible metadata inspection.

Done when:

- A bundle release can update a first-party completion, prompt preset, or
  keybinding metadata file without replacing Niubash itself.

## Phase 7 - Process Plugin Runtime

Status: host contract documented; no official fixture pack is shipped.

oh-my-niu work:

- Add process plugin examples only when they are real user-facing packs.
- Mark every process pack explicit opt-in.
- Document timeouts and failure behavior.

Current branch progress:

- The official bundle does not ship process-only test packs.
- Niubash host tests keep process command and lifecycle fixtures in generated
  test bundles instead of exposing them as official plugins.
- `tools/validate_bundle.py` now rejects process packs that are default-enabled,
  omit `[process]`, omit `process:run:<command>`, exceed timeout bounds, or
  fail to export at least one command/hook.

Niubash dependency:

- `kind = "process"` backend with permissions and deterministic IO.
- Current Niubash branch validates and surfaces the process manifest contract,
  executes enabled process commands, and runs enabled startup/precmd/preexec/
  chpwd process hooks without allowing shell-state mutation.

Done when:

- Process manifests use the same schema as builtin manifests.
- A failed or timed-out process plugin cannot corrupt shell state.

## Phase 8 - WASM Host Runtime

Status: host contract documented; no official WASM demo pack is shipped.

oh-my-niu work:

- Add a WASM pack only when it provides real sandbox/provider distribution
  value.
- Keep official first-party packs as `source` or `builtin` unless WASM adds
  real sandbox/provider distribution value.
- Document WASM permission requirements.

Current branch progress:

- The official bundle does not ship WASM-only test packs.
- Niubash host tests keep WASM command fixtures in generated test bundles
  instead of exposing them as official plugins.
- The validator rejects WASM packs that are default-enabled, omit `[wasm]`, use
  native `process:run:*` permissions, declare native required binaries, export
  lifecycle hooks, or exceed timeout/memory bounds.

Niubash dependency:

- Stable WASM command host API and sandbox. Current Niubash branch validates and
  surfaces the manifest contract, then executes enabled command modules with
  wasmi, memory caps, fuel metering, deterministic missing-export failure, exit
  code 124 for out-of-fuel modules, and Phase 14-17 `niubash:plugin/host`
  stdout/stderr, command-argument, and permission-gated cwd/env imports backed by
  exported module memory.

Done when:

- A third-party WASM command plugin can be installed and run without
  native-code trust.

## Phase 9 - Public Authoring Model

Status: implemented on this branch.

oh-my-niu work:

- Become the reference bundle layout.
- Add authoring templates.
- Add manifest schema docs.
- Add validation scripts suitable for CI.
- Use `niubash plugin doctor [--json]` as the host-side smoke diagnostic for
  active bundle state, enabled packs, missing required binaries, and permission
  drift while authoring manifests.
- Use `niubash plugin review <pack> [--json]` as the host-side permission
  review surface for manifest permissions, runtime kind, exported surfaces, and
  required binaries before enabling a pack.

Current branch progress:

- Added `docs/authoring.md` with the public manifest schema, permission token
  table, runtime contracts, asset rules, and release checklist.
- Added copyable `templates/builtin`, `templates/process`, and `templates/wasm`
  manifest templates.
- `tools/validate_bundle.py` now checks that the authoring guide and templates
  exist and that each template parses with the expected runtime kind.
- `tools/package_bundle.py` includes `templates/` in deterministic release
  artifacts.
- `.github/workflows/bundle.yml` runs py_compile, `validate_bundle.py`, and
  deterministic package checks on push and pull requests.
- `tools/validate_bundle.py` validates the CI workflow so release gates stay
  wired into the repository.

- `index.toml` now defines the Phase 9 package discovery index and is
  validated against every pack manifest before packaging.

Niubash dependency:

- Plugin discovery/install, permission review, and compatibility policy. Current
  Niubash branch has `plugin search`, `plugin install`, `plugin doctor`, and
  `plugin review` surfaces.
Done when:

- Third-party authors can build plugins without copying zsh or Oh My Zsh
  conventions.

## Phase 10 - Legacy Cleanup

Status: implemented on this branch.

oh-my-niu work:

- Keep the legacy tag/branch for history.
- Keep docs clear that the active bundle does not source zsh or `.winsh`
  plugins.
- Remove any remaining active-surface references to arbitrary sourced plugin
  scripts; keep only reviewed `.niu` source packs.

Current branch progress:

- `legacy-pre-niubash-plugin-system` exists as both a branch and tag for the old
  `.winsh` script-framework state.
- README, design, authoring, and compatibility docs present the manifest-first
  Niubash plugin model as the active surface.
- Remaining zsh and `.winsh` references are confined to migration, non-goals, or
  legacy preservation notes. First-party shell helpers now use `.niu`.

Niubash dependency:

- `[plugins]` is the primary config path.
- Old zsh-native wording is confined to migration notes.

Done when:

- New users see only the Niubash-native plugin model.

## Phase 11 - Theme Pack Assets

Status: implemented on this branch as the official bundle foundation; third-party
theme marketplace/distribution remains future work.

oh-my-niu work:

- Add a `themes` builtin UX pack with static theme assets.
- Ship official theme style assets such as `themes/minimal.toml`,
  `themes/classic.toml`, `themes/pure.toml`, `themes/compact.toml`,
  `themes/cyberpunk.toml`, `themes/forest.toml`, and `themes/ocean.toml`
  using the same style schema as user themes.
- Validate exported theme files in `tools/validate_bundle.py`.
- Include `themes/` in deterministic release artifacts.

Niubash dependency:

- The paired Niubash branch loads active official bundle themes after built-in
  themes and user theme files, so bundle updates can add or revise official
  themes without replacing `niubash.exe`.

Done when:

- `current_theme = "ocean"` can resolve from the active official bundle.
- Invalid or missing exported theme assets fail bundle validation before install.

## Phase 12 - Registry Trust Policy Foundation
Status: implemented on this branch for the official bundle index policy;
third-party registry signing remains future work.

oh-my-niu work:
- Treat `oh-my-niu` as the official first-party bundle and reference layout,
  not as the only place future plugins can live.
- Require `index.toml` release metadata to declare `checksum_required = true`,
  `checksum_algorithm = "sha256"`, and `signature = "unsupported"` until
  signing support is implemented.
- Validate index bundle/version/API/min-host fields and pack entries against
  `bundle.toml` and every pack manifest before packaging.

Niubash dependency:
- The paired Niubash branch validates installed bundle `index.toml` before
  switching `plugin-lock.toml`.
- Zip updates with checksum-required indexes must pass `--checksum` or
  `--checksum-file`; index drift leaves the existing active bundle untouched.

Done when:
- A release index cannot silently drift from shipped manifests.
- Missing checksum verification blocks zip install/update.
- Unsupported signatures are explicit rather than implied.

## Phase 13 - Theme Market Discovery Surface

Status: implemented on the paired Niubash branch as a read-only catalog
foundation; theme install/apply marketplace commands remain future work.

oh-my-niu work:
- Keep official `themes/*` assets under the `themes` pack as the first bundle
  catalog data source.
- Document `niubash plugin themes` as the read-only bridge from the official
  bundle into future third-party theme distribution.

Niubash dependency:
- The paired Niubash branch exposes `niubash plugin themes [--json]` for
  built-in, user, and active bundle theme sources.
- The catalog preserves built-in > user > active bundle resolution order and
  does not install or select themes automatically.

Done when:
- Text and JSON theme catalog commands list active bundle theme metadata.
- Existing bundle validation continues to reject missing or invalid exported
  theme assets.
## Future Direction - Code-Bearing Packs
Status: proposed direction; this describes where the bundle should go after the
current TOML-first foundation.
The active bundle is not meant to stay limited to aliases and static metadata.
It is still TOML-heavy today because static assets and host-owned behavior are
kept declarative, but first-party shell helper behavior can now move into
`kind = "source"` packs with bundle-local `.niu` code. That is a transitional
shape, not the final definition of a plugin ecosystem.
The immediate gate is [Externalization Readiness](externalization-readiness.md):
classify every pack before changing manifest schema or moving behavior into
WASM/process artifacts.
oh-my-niu work:
- Keep static assets in TOML where TOML is enough:
  - aliases;
  - completion definitions;
  - prompt presets;
  - keybinding metadata;
  - themes.
- Treat these asset/declarative packs separately from host-owned builtin
  behavior even while manifests still use today's schema.
- Add code-bearing pack artifacts only through explicit runtime contracts:
  - `.niu` source scripts for reviewed shell helpers;
  - WASM modules for sandboxed providers and commands;
  - process manifests for adapters around existing native tools.
- Do not add arbitrary zsh, legacy `.winsh`, or user-discovered rc source
  plugins, and do not require users to source bundle files from `~/.winshrc`.
- Document every code-bearing pack's permissions, host API surface, timeout,
  resource limit, and rollback behavior before making it a normal pack.
Niubash dependency:
- WASM host APIs for more than command modules:
  - completion/provider output;
  - prompt segment output;
  - scoped file reads;
  - env writes;
  - cwd writes;
  - lifecycle hook context.
- Source lifecycle hooks for current-shell helpers that need aliases,
  functions, env writes, cwd writes, or hook effects.
- Process plugin behavior for tools where native process execution is the
  point and no current-shell mutation is required.
- Permission review that clearly distinguishes static assets, builtin host
  behavior, process execution, and sandboxed WASM execution.
Candidate migration order:
- Move simple shell helper packs through `source` when the desired behavior is
  aliases, functions, startup glue, or lifecycle effects in the current
  interactive shell.
- Keep the implemented Niubash process binding for the
  [command-not-found provider](command-not-found-provider-abi.md), and migrate
  the official pack only when the provider behavior is deliberate.
- Expand next to prompt segment calculators, completion providers, and
  formatting/suggestion helpers after that provider shape is proven.
Done when:
- First-party shell-effect packs ship as `source` instead of
  `builtin`.
- Users can still put personal bash-like customization in `~/.winshrc`.
- Distributed plugin code remains manifest-reviewed and does not become an
  arbitrary rc/source mechanism.
## Sync Policy
Every pack change must update:

- `bundle.toml`;
- `packs/<name>/plugin.toml`;
- README pack table;
- this roadmap if it changes phase scope;
- Niubash registry/tests if the pack is builtin.

Every release must include:

- bundle version;
- minimum Niubash version;
- checksum;
- changelog;
- rollback-safe artifact layout.
