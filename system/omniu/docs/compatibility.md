# Compatibility

This document defines the release compatibility contract for the official
oh-my-niu bundle.

## Current Release

- Bundle name: `oh-my-niu`
- Bundle version: `2.1.0`
- Release channel: `stable`
- Minimum host: `min_niubash = "1.0.0"`
- Bundle API: `niubash:plugin-bundle@0.1.0`
- Pack manifest API: `niubash:plugin@0.1.0`
- Source plugin script suffix: `.niu`
- Process plugin protocol: `niubash:process-plugin@0.1.0`
- WASM plugin protocol: `niubash:wasm-plugin@0.1.0`

`min_niubash` is bundle-internal metadata today: current Niubash does
not install or update this bundle (the host-side bundle updater was
retired with the built-in plugin stack, niubash#145), so nothing on
the host compares it against the running version. Keep this field at
the oldest host version that can run the framework scripts safely;
the bundle validator keeps it consistent across `bundle.toml`,
`index.toml`, and the pack manifests.

## Host Baseline

This contract was last audited on 2026-10-25 against Niubash master
`b53e6bff` (after the 1.4.4 release of 2026-10-22), and re-audited on
2026-11-01 against Niubash master `7e13829` (pre-1.5.0). The 1.5.0
host changes that touch this contract: the plugin spec and source
registry are JSON (`~/.niubash/plugins.json`,
`~/.niubash/sources/registry.json`); the pre-1.5.0 TOML files are
converted exactly once by `niu plugin migrate` and no runtime path
reads them (`niu plugin list`/`sync` do not convert implicitly).
None of this affects the framework itself, which is cloned and
sourced, never installed through the spec. Salient host facts
the bundle relies on:

- The host fires the bash prompt surface: `PROMPT_COMMAND` (after
  setting `NIU_LAST_EXIT_CODE`), `PS1`/`PS2`/`PS0` assignments, and
  traps. It does not call plugin lifecycle hooks, consume
  `NIU_PROMPT_LEFT`/`NIU_THEME`, or load bundle inventories.
- The prompt segment contract in `prompts/segments.toml` is still
  mirrored by the host (`prompt_segments.rs` pins the same segment ids
  and presets, with a test resolving this repository's file).
- `$HOME` deliberately stays in Windows form (`C:/Users/you`) while
  `$PWD` is POSIX form (niubash#522); framework code must not assume
  the two share a form. On POSIX hosts, `HOME` may be entirely unset
  (niubash#546).

## Runtime Surface

- `source` packs load bundle-local `.niu` scripts into the current
  interactive Niubash session. Their lifecycle is the framework's own
  hook registry (see `lib/hooks.niu`): `startup` runs synchronously
  from the entry point, `precmd`/`chpwd` are dispatched from
  `PROMPT_COMMAND`, and `preexec` from the DEBUG trap. They are active
  for the interactive REPL and `-C`; ordinary `-c`, script-file, and
  stdin execution stay clean by default.
- `builtin` packs are metadata-only on current hosts: the first-party
  behaviors they named (keybindings, prompt presets, themes,
  command-not-found hints) are host features configured through host
  configuration, not behavior loaded from this bundle. Official
  prompt and theme behavior belongs to source plugins.
- `process` packs are explicit opt-in adapters for native commands. They must
  declare `required_binaries`, `process:run:<command>` permission, protocol,
  command, arguments, and timeout. Current Niubash does not execute
  them; the manifests are packaging/review metadata.
- `wasm` packs are explicit opt-in command modules by manifest shape.
  Current Niubash does not execute them either (no host loader for
  `niubash_plugin_main` or the `niubash:plugin/host` imports remains);
  the validator's artifact/digest checks are bundle-side only.
- `exports.providers` is an optional compatibility marker, not a runtime. The
  current bundle may mark `command-not-found` as the first provider ABI
  candidate, but no provider binding is implemented in current
  Niubash — the host's missing-command surface is its own
  `command-not-found-hint` policy. WASM packs cannot
  export providers until Niubash defines a separate WASM provider contract.
- Shell-mutating WASM host APIs, arbitrary zsh source, WASI, unrestricted files,
  unrestricted processes, ZLE widgets, DLL plugins, and unbounded native process bridges
  are outside the current compatibility contract.

## Semver Policy

- Patch releases fix manifests, static assets, checksums, docs, or validation
  rules without requiring new permissions or a newer Niubash host.
- Minor releases may add packs, add static assets, or expand permissions when
  the permission review surface makes the change explicit.
- Major releases are reserved for breaking manifest/API changes, removed packs,
  incompatible asset layout changes, or a new minimum host that older supported
  Niubash releases cannot install.

## Release Artifacts

Every published release must include:

- `oh-my-niu-{version}.zip`
- `oh-my-niu-{version}.zip.sha256`
- `index.toml` with `checksum_required = true` and `signature = "unsupported"`
- `CHANGELOG.md`
- `docs/compatibility.md`

The zip must be produced by `tools/package_bundle.py` so file ordering,
timestamps, and permissions stay deterministic. Consistency of
`index.toml` with the bundle and pack manifests is enforced by this
repository's own validator (`tools/validate_bundle.py`); the SHA-256
checksum is for manual verification of downloaded release zips, since
current Niubash performs no host-side bundle install or lock switch.
