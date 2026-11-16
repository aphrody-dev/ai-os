# @aphrody/identity

<!-- catalog:begin unit -->
> Aphrody product identity for the M3 surfaces: brand emblem and icons, the Aphrody avatar, the animated pet (React component and <aphrody-pet> Custom Element, Codex-composed tracks, 16-way gaze) drawn from crates/ui/identity.

| Type | Path |
| :-- | :-- |
| Bun package | `system/env-kit/identity` |

**Commands**

```sh
bun run --cwd system/env-kit/identity sprite
bun run --cwd system/env-kit/identity prepack
bun run --cwd system/env-kit/identity gen
bun run --cwd system/env-kit/identity typecheck
bun run --cwd system/env-kit/identity test
bun run --cwd system/env-kit/identity demo
bun run --cwd system/env-kit/identity measure
```

Part of Aphrody: [aphrody-labs/ay](../../README.md), [Catalog](../../docs/reference/catalog/package.md).
<!-- catalog:end -->

The Aphrody product identity for React/M3 surfaces, drawn from `crates/ui/identity` of the aphrody
repository.

| Import                      | Contents                                                                                                                                                                                                                                                                                                    | Needs                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@aphrody/identity`         | `AphrodyAvatar`, `AphrodyPet`, `BRAND_ICONS`, `brandIcon`, `brandSrcSet`, pet data                                                                                                                                                                                                                          | the `@aphrody/m3` `?url` loader |
| `@aphrody/identity/brand`   | brand emblem icons (`icon-64/128/192.png`) as URLs                                                                                                                                                                                                                                                          | `?url` loader                   |
| `@aphrody/identity/theme`   | `APHRODY_M3_SEED`: the shared Aphrody/Bun product seed for native and web M3 themes                                                                                                                                                                                                                         | nothing                         |
| `@aphrody/identity/atlas`   | `PET_ATLAS_URL` (sprite sheet)                                                                                                                                                                                                                                                                              | `?url` loader                   |
| `@aphrody/identity/pet`     | `PET`, `frameAt`, `gazeFrame`, `spriteStyle` (timed tracks, 16-way gaze)                                                                                                                                                                                                                                    | nothing                         |
| `@aphrody/identity/runtime` | `PET_WEB`, `resolve`, `currentFrame`, `Ambient`, `gaze`: the crate clock (Codex-composed tracks, state lifetimes), tick for tick                                                                                                                                                                            | nothing                         |
| `@aphrody/identity/element` | `<aphrody-pet>` Custom Element, `defineAphrodyPet()` (16.6 KB minified, 3.6 KB gzip)                                                                                                                                                                                                                        | an atlas URL in `src`           |
| `@aphrody/identity/load`    | `loadIcon(source, { size, scale, tint, fit, output })`: PNG, JPEG, WebP, GIF, SVG, ICO (best entry for `size × scale`) and `symbol:<name>?style=…&fill=…&wght=…&grad=…&opsz=…` from cdn.aphrody.com, to an `ImageBitmap` or SVG markup; the browser side of the crate loader (8.4 KB minified, 3.8 KB gzip) | a browser for bitmaps           |

The brand and atlas modules import the crate assets by relative path, so they resolve in an aphrody
checkout (this repository mounted at `m3/`). `src/animations.generated.ts` is generated from the
crate's `assets/aphrody/animations.json` by `bun run gen`; `bun run test` (`src/pet.test.ts`) fails when
the two disagree. Typecheck: `bun run typecheck`.

`<aphrody-pet src="…/spritesheet.webp" size="104">`: one timer per frame change, `prefers-reduced-motion`
shows the first frame, `setState("running" | "waiting" | "review" | "failed")`, `clearState()`, `play(name | null)`,
gaze follows the pointer at rest (`no-gaze` disables it). `src/web.generated.ts` comes from the crate's
`assets/aphrody/web.json`; `src/runtime.test.ts` replays the crate's `tests/fixtures/parite-web.json`.
`bun run demo` serves a demo with `Bun.serve`, `bun demo/check.ts` drives it in headless Chrome, and
`bun run measure [--wasm file]` prints bundle sizes and timings (choice and figures: crate README).
