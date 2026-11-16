# `@aphrody/wck`

<!-- catalog:begin unit -->
<!-- prettier-ignore-start -->
> Compile-Time Web Validator (Google SEO + AI Mode SEO + Modern Web Guidelines + Core Web Vitals + Lighthouse 100 + WASM + WebGPU Chromium Spec)

| Type | Path |
| :-- | :-- |
| Bun package | `system/wck` |

**Commands**

```sh
bun run --cwd system/wck build
bun run --cwd system/wck test
bun run --cwd system/wck check
bun run --cwd system/wck fmt
```

Part of Aphrody: [aphrody-labs/ay](../../README.md), [Catalog](../../docs/reference/catalog/package.md).
<!-- prettier-ignore-end -->
<!-- catalog:end -->

Compile-Time Web Validator and Modern Web Guidance (MWG) RAG engine for the `src` monorepo.
100% pure Bun (`zero` external npm dependencies) paired with a Pure C23 LLVM native core (`system/core/capi/c/mwg_core.c` -> `native/mwg_capi.dll`) via `bun:ffi`.

## Capabilities

1. **7 Compile-Time Web Specs** (`wck [<path>] [--spec=<name>] [--json] [--quiet]`):
   - `seo`: Google Search SEO (title, description, canonical, OpenGraph, landmarks, `robots.txt`, `sitemap.xml`)
   - `aiseo`: Google AI Mode SEO / GEO (JSON-LD `WebSite` + `SearchAction`, `/llms.txt`)
   - `mwg`: Modern Web Guidelines (responsive viewport, `color-scheme`, `:focus-visible`, `prefers-reduced-motion`, zero deprecated tags)
   - `cwv`: Core Web Vitals static gate (CLS = 0.000, compositor keyframes, LCP < 14KB, INP < 30KB)
   - `lh`: Lighthouse 100/100/100/100 static gate
   - `wasm`: WebAssembly binary validation
   - `webgpu`: WebGPU & Chromium Dawn WGSL validation
2. **RAG Hybrid Search** (`wck search <query>`, `wck retrieve <id>`, `wck list [category]`):
   - Okapi BM25 + Lucene S-Stemmer (`src/rag/bm25.ts`)
   - Int8 quantized 256d static embeddings (`src/rag/static-embedder.ts`, `data/gen/query-words.*`)
   - Reciprocal Rank Fusion (RRF) over `data/gen/guide-chunks.*` and 252 compressed guides (`data/gen/guides.json.gz`)
3. **Baseline & Feature Gates** (`.mwgrc`, `wck baselinestatus <query>`, `wck set-allow-origin-trials`, `wck set-allow-volatile-features`, `wck set-baseline <target>`)
4. **Legacy Pattern Scanner** (`wck legacy-scan [<path>] [--json] [--guide=<id>]`)
5. **MDX & Native C23 FFI** (`wck mdx <file>`, `src/mwg-ffi.ts` -> `mwg_capi.dll` with deterministic Bun fallback)

## Verification

```sh
bun fmt
bun check
bun test system/wck
```
