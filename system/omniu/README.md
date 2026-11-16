# @aphrody/omniu

<!-- catalog:begin unit -->
<!-- prettier-ignore-start -->
> oh-my-niu for Bun: plugin bundle as data, validator, packager and scaffolder, and the host that loads the ay plugin into both Bun and niu

| Type | Path |
| :-- | :-- |
| Bun package | `system/omniu` |

**Commands**

```sh
bun run --cwd system/omniu test
bun run --cwd system/omniu validate
```

Part of Aphrody: [aphrody-labs/ay](../../README.md), [Catalog](../../docs/reference/catalog/package.md).
<!-- prettier-ignore-end -->
<!-- catalog:end -->

oh-my-niu (the niu plugin bundle, from unixwin/oh-my-niu) as Bun-native data and tools, plus the host that loads one plugin surface into both Bun and niu. Fusion plan: `docs/native/UNIXWIN.md`.

- Bundle data: `plugins/`, `packs/`, `lib/`, `aliases/`, `completions/`, `prompts/`, `keybindings/`, `themes/`, `envs/`, `templates/`, `docs/`, `bundle.toml`, `index.toml`. The inventory of `plugins/` is `framework-plugins.toml`.
- Tools (Bun, ported from the Python originals): `bun src/cli.ts validate | package [--check] | new-pack add|remove | plugins | convert-jj`.
- Plugin surface: a framework plugin is `plugins/<name>/plugin.toml` (niu: `entry`, sourced by `oh-my-niu.niu`) plus an optional `[bun]` table (`entry`, `module`). `src/host.ts` registers the Bun side with `Bun.plugin`. The `ay` plugin (`plugins/ay`) is the first user: the binary emits its own manifest (`ay plugin manifest`), niu gets `ay_plugin_names`, `ay_plugin_manifest`, `ay_sh` and tab completion, Bun gets `import { run, sh, manifest } from "ay"`.
- Bun preload: `bunfig.toml` (`preload = ["./src/preload.ts"]`) in the package, or the same line in a project `bunfig.toml`.
- Tests: `bun test system/omniu`. End to end with the real binaries: `AY_BIN=<target>/debug/ay NIU_BIN=<target>/debug/niu bun test system/omniu`.
