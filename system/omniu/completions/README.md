# Completion Assets

This directory owns first-party static completion definitions in the
TOML schema Niubash's external-definition completer parses
(`command`/`description`/`flags`/`subcommands`). Current Niubash does
not load them from the bundle by itself — the "host loads the active
bundle" path retired with the built-in plugin stack (niubash#145).
To use them, point a completion directory the host does read at this
folder: a `completion_dirs` entry in the host configuration, or the
`NIU_COMPDEFS` environment variable, set in `~/.niubashrc`.

Current bundle-owned definitions:
- `git.toml`
- `docker.toml`
- `kubectl.toml`
- `npm.toml`
- WinuxCmd core command definitions generated from `winuxcmd.exe <command> --help` and exported by `packs/winuxcmd-core/plugin.toml`.

Each file uses the native Niubash TOML completion schema:
- top-level `command = "<name>"`;
- optional `[[flags]]` entries with `short`, `long`, `takes_value`, `values`, or
  `values_from = "path"`;
- optional `[[subcommands]]` entries with their own `[[subcommands.flags]]`.

`tools/validate_bundle.py` checks that every manifest entry in
`exports.completions` has a matching parseable `completions/<name>.toml` asset
whose `command` matches the exported completion name.
