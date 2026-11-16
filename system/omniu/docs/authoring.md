# Plugin Authoring

This guide is the public authoring contract for the current Niubash-native
plugin model. The runtime model is directory-first: a plugin is shell code
in a directory that the framework sources into the user's session because
the user selected it in `~/.niubashrc`. The TOML manifests are bundle-side
packaging and review metadata — they document permissions, runtime kind,
and exported surfaces so reviewers can audit a pack before it ships, but
Niubash has no plugin trust system: it does not read, score, or enforce
them, and enabling a plugin is the user's own decision. The only
host-side verification anywhere in the plugin story is one-shot and
user-driven: a checksum the user supplies themselves (`--checksum` /
`--checksum-file`) when installing an external ecosystem source through
the host plugin CLI, verified once at install time.

## Current Scope

- `oh-my-niu` is the official first-party bundle and reference layout. It
  is not the whole future plugin universe; third-party registries should use
  the same manifest/index contract and are validated by this repository's
  bundle validator, not by Niubash host policy.
- Bundle updates are manual — `git pull` in the clone, or unpack a newer
  release zip over the old tree. No host command updates this bundle.
- `source` packs are the Oh My-style shell plugin path. They ship bundle-local
  `.niu` code that the framework sources into the current interactive session
  once the user enables the pack.
- `builtin` packs are first-party fallback/native adapters because the Rust
  implementation lives in Niubash core.
- `process` packs are explicit opt-in adapters for existing native tools.
- `wasm` packs are the preferred third-party direction. Current command modules
  export `niubash_plugin_main() -> i32` and may use the Phase 14-17
  `niubash:plugin/host` stdout/stderr, args, cwd, and env read imports.
- Shell-mutating WASM APIs, arbitrary zsh source, ZLE widgets, and DLL/FFI
  plugin ABIs are outside the current public contract.

## Authoring Loop

1. Copy one of the templates under `templates/`.
2. Add the pack name to `bundle.toml` under `[packs].available`.
3. Put the manifest at `packs/<name>/plugin.toml`.
4. Add any exported assets under `aliases/`, `completions/`, `prompts/`,
   `keybindings/`, `themes/`, or `wasm/`; source packs also add
   `packs/<name>/init.niu`.
5. Run the CI-safe checks:

```sh
python tools/validate_bundle.py
python tools/package_bundle.py --check
```

6. Smoke the result with the framework harness (see Validation in the
   README): `niubash tools/smoke_framework.niu .` against the target
   Niubash build.

There is no host-side review or install step for this bundle. The host
plugin CLI (`niu plugin ...`) manages only the external ecosystem
sources declared in `~/.niubash/plugins.json` (oh-my-bash, bash-it,
bash-completion, wild file sources) — a separate distribution channel
this bundle deliberately does not use; oh-my-niu cannot be installed,
reviewed, or updated through it. When a user installs one of those
ecosystem sources (or any zip) through the host CLI, they may pass
`--checksum` / `--checksum-file` with an expected value they obtained
themselves; the host verifies that one download at install time and
keeps no trust state afterwards.

## Scaffolding a New Pack

A pack is wired into four directories and three registries; missing any of
them fails Bundle CI only after the fact. Use the scaffolder so every piece
lands together and the validator runs before you commit:

```sh
python tools/new_pack.py add mypack --summary "One line."     --required-binary mypack --with-completions
python tools/new_pack.py remove mypack   # reverse everything cleanly
```

Both commands run `tools/validate_bundle.py` at the end and fail loudly if
a registration anchor drifted. The jj pack (PR #10) landed with exactly the
wiring mistakes this tool now prevents.

## Bundle Metadata

`bundle.toml` must declare `api = "niubash:plugin-bundle@0.1.0"` and
`min_niubash` as a semantic version. `min_niubash` is advisory packaging
metadata for reviewers: the host does not gate this bundle against it,
because the bundle is cloned and sourced manually.

`index.toml` is the registry-facing release index. It must match `bundle.toml`
and every pack manifest, set `release.checksum_required = true`, use
`release.checksum_algorithm = "sha256"`, and set `release.signature =
"unsupported"` until signing support exists. Those fields state the
bundle's own release policy, enforced by the bundle validator: a release
zip is always published with its `.sha256`, and a user installing any zip
through a host CLI supplies the expected value with `--checksum` or
`--checksum-file` and has it verified once, at install time. No signature
or trust mechanism stands behind it.

## Manifest Schema

Every `packs/<name>/plugin.toml` must include:

```toml
name = "example"
bundle = "oh-my-niu"
version = "1.0.1"
kind = "source" # asset/static data may still use builtin fallback; runtime kinds include source | builtin | process | wasm
api = "niubash:plugin@0.1.0"
category = "workflow" # devtools | environment | workflow | hints | ux
summary = "Short user-facing summary."
default = false
permissions = ["shell:source"]
required_binaries = []

[exports]
aliases = false
completions = []
prompt_segments = []
hooks = []
commands = []
keybindings = []
themes = []
providers = []
```

Field rules:

- `name` must match the directory under `packs/` and the entry in
  `bundle.toml`.
- `bundle` must match `bundle.toml` while this repository is the active
  reference bundle.
- `api` must be `niubash:plugin@0.1.0` until the host bumps the contract.
- `default = true` is only allowed for first-party packs that are safe without
  surprising startup side effects.
- `permissions` must exactly describe pack behavior.
- `required_binaries` lists native commands the user must have in `PATH`.
- `exports` declares the surfaces Niubash may load. Declaring an export also
  requires the matching asset or runtime contract.
- `exports.providers` is optional and currently limited to
  `command-not-found`. Builtin packs may use it as a readiness marker, and
  process packs may use the implemented Niubash command-not-found provider
  binding when `command:diagnose` is declared. WASM packs must not export
  providers until a separate WASM provider ABI exists.

## Runtime Contracts

The contracts in this section govern the transitional `packs/` manifests
and are enforced by this repository's bundle validator, not by the host.
Two of the runtime kinds describe the retired built-in stack
(niubash#145): current Niubash does not execute `process` or `wasm`
plugin modules, so those manifests are archival packaging metadata. The
live runtime surface is the directory plugin model —
`plugins/<name>/<name>.plugin.niu` files the framework sources for the
plugins selected in `NIU_PLUGINS` — with `source` packs as their
transitional equivalent.

### Source

Use `kind = "source"` when a pack should behave like a traditional shell
plugin. Niubash sources the declared `.niu` file into the current interactive
session during REPL startup and declared lifecycle hooks. Ordinary `-c`,
script-file, and stdin execution stay clean unless a future explicit opt-in is
added; the `-C` one-shot REPL path loads the same interactive startup surface
when the host supports it.

```toml
[source]
entry = "packs/example/init.niu"
```

Rules:

- `permissions` must include `shell:source`.
- `source.entry` must be a bundle-local relative path ending in `.niu`.
- `exports.hooks` may contain `startup`, `precmd`, `preexec`, and `chpwd`.
- Source plugins may define aliases, functions, exports, cwd-changing helpers,
  and shell lifecycle glue. Normal user-authored plugin lists and shell code
  belong in `~/.niubashrc`; permissions in `plugin.toml` are bundle-side
  review metadata (current Niubash does not read them), and Niubash's
  own plugin CLI state lives in `~/.niubash/plugins.json` (the
  pre-1.5.0 `plugins.toml` converts once via `niu plugin migrate`).
- User `~/.niubashrc` is the only framework entry point. Current
  Niubash never reads `~/.winshrc`, so it cannot act as a fallback
  for older setups.

### Builtin

Use `kind = "builtin"` only when Niubash core already owns the runtime behavior.
The bundle may own static data such as aliases, completions, prompt presets, or
keybinding metadata, but it does not ship Rust code.

### Process

Process packs must be explicit opt-in:

```toml
[process]
protocol = "niubash:process-plugin@0.1.0"
command = "example-tool"
args = ["--json"]
timeout_millis = 1000
```

Rules:

- `default` must be `false`.
- `permissions` must include `process:run:<command>`.
- `required_binaries` must include the same command.
- At least one command or hook must be exported.
- Timeout must be between `1` and `30000` milliseconds.
- Process plugins cannot mutate shell parser or executor internals.

### WASM

WASM packs must also be explicit opt-in:

```toml
[wasm]
protocol = "niubash:wasm-plugin@0.1.0"
module = "wasm/example.wasm"
sha256 = "<64 lowercase hex chars>"
wit_world = "niubash:plugin/example"
timeout_millis = 1000
max_memory_pages = 16
```

Rules:

- `default` must be `false`.
- `required_binaries` must be empty.
- `permissions` must not include `process:run:*`.
- The module path must stay bundle-local and end in `.wasm`.
- The SHA-256 must match the checked-in artifact.
- Command modules must export `niubash_plugin_main() -> i32`.
- Current host imports are limited to:
  - `niubash:plugin/host.stdout_write(ptr: i32, len: i32) -> i32`;
  - `niubash:plugin/host.stderr_write(ptr: i32, len: i32) -> i32`;
  - `niubash:plugin/host.arg_count() -> i32`;
  - `niubash:plugin/host.arg_len(index: i32) -> i32`;
  - `niubash:plugin/host.arg_read(index: i32, ptr: i32) -> i32`;
  - `niubash:plugin/host.cwd_len() -> i32`;
  - `niubash:plugin/host.cwd_read(ptr: i32) -> i32`;
  - `niubash:plugin/host.env_len(name_ptr: i32, name_len: i32) -> i32`;
  - `niubash:plugin/host.env_read(name_ptr: i32, name_len: i32, value_ptr: i32) -> i32`.
- Host imports read from or write to exported module memory and return `-1` for
  missing memory, invalid indexes, invalid pointers, out-of-bounds memory access,
  values over the host cap, cwd reads without `cwd:read`, or env reads without a
  matching `env:read:<NAME>` permission.
- Lifecycle hooks, completions, prompt segments, keybindings, WASI, files,
  processes, env mutation, and shell mutation are not part of the current WASM
  public contract.

## Permission Tokens

Permissions are bundle-side review metadata: they document what a pack
does so a reviewer can audit it before it ships. Current Niubash does
not read or enforce them, and plugin code runs with the user's full
shell privileges once the user enables it — the risk column is a
review aid, not a host guarantee.

| Token | Risk | Meaning |
| --- | --- | --- |
| `cwd:read` | low | Reads the current working directory or path context. |
| `env:read:<NAME>` | low | Reads one explicitly named environment variable. |
| `shell:source` | high | Sources bundle-owned `.niu` code into the current interactive session and lifecycle hooks. |
| `process:run:<cmd>` | high | Runs a native command such as `git` or `zoxide`. |
| `shell:cwd:write` | medium | Requests a native cwd change through a host-owned shim. |
| `env:write` | high | Requests environment variable changes. |
| `fs:read:<path>` | medium | Reads files below a declared path. |
| `fs:write:<path>` | high | Writes files below a declared path. |
| `command:diagnose` | low | Reads command metadata for diagnostics. |

Unknown tokens are treated as manual-review permissions by bundle
reviewers.

## Asset Rules

- `exports.aliases = true` requires `aliases/<pack>.toml` with a non-empty
  `[aliases]` table.
- `exports.completions = ["tool"]` requires `completions/tool.toml` whose
  `command` field is `tool`.
- `exports.prompt_segments` requires matching segment definitions in
  `prompts/segments.toml`.
- `exports.keybindings` requires matching files in `keybindings/<name>.toml`.
- `exports.themes = ["ocean"]` requires `themes/ocean.toml` using the Niubash
  theme style schema.
- `exports.providers = ["command-not-found"]` is a guarded marker for the first
  provider ABI candidate and requires `command:diagnose`.
- WASM modules live under `wasm/` and must match their manifest checksum.

## Release Checklist

- `python tools/validate_bundle.py`
- `python tools/package_bundle.py --check`
- `niubash tools/smoke_framework.niu .` against the target Niubash build
- Changelog entry for any permission, default, runtime, or exported asset
  change.
- Compatibility note when a pack requires a newer Niubash host API.
