// Declarative template engine and programmatic Bun Docs MDX builders driven by MonorepoSnapshot.
import type { MonorepoSnapshot } from "./scanner.ts";

export interface MdxFrontmatter {
  title: string;
  description: string;
  body: string;
}

/** Wraps markdown/MDX body with Bun Docs YAML frontmatter. */
export function renderMdx(doc: MdxFrontmatter): string {
  const safeTitle = doc.title.replace(/"/g, '\\"');
  const safeDesc = doc.description.replace(/"/g, '\\"');
  return [
    "---",
    `title: "${safeTitle}"`,
    `description: "${safeDesc}"`,
    "---",
    "",
    doc.body.trimEnd(),
    "",
  ].join("\n");
}

function lookupPath(ctx: Record<string, unknown>, path: string): unknown {
  const parts = path.trim().split(".");
  let cur: unknown = ctx;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? "";
}

/** Renders `{{path}}` placeholders and `{{#each list}}...{{/each}}` blocks against `ctx`. */
export function renderTemplate(
  template: string,
  ctx: Record<string, unknown>,
): string {
  const withLoops = template.replace(
    /\{\{#each\s+([A-Za-z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_, listKey: string, block: string) => {
      const items = lookupPath(ctx, listKey);
      if (!Array.isArray(items)) return "";
      return items
        .map((item) => {
          if (item !== null && typeof item === "object") {
            return renderTemplate(block, {
              ...ctx,
              ...(item as Record<string, unknown>),
            });
          }
          return block.replace(/\{\{this\}\}/g, String(item ?? ""));
        })
        .join("");
    },
  );
  return withLoops.replace(/\{\{([A-Za-z0-9_.]+)\}\}/g, (_, key: string) => {
    const val = lookupPath(ctx, key);
    return val === undefined || val === null ? "" : String(val);
  });
}

/** Replaces `<!-- @gen:id -->...<!-- @end:id -->` regions in an existing document. */
export function applyTemplateSections(
  doc: string,
  sections: Record<string, string>,
): string {
  return doc.replace(
    /<!--\s*@gen:([A-Za-z0-9_-]+)\s*-->[\s\S]*?<!--\s*@end:\1\s*-->/g,
    (full, id: string) => {
      if (!(id in sections)) return full;
      return `<!-- @gen:${id} -->\n${sections[id]!.trimEnd()}\n<!-- @end:${id} -->`;
    },
  );
}

function formatLayerSummary(snap: MonorepoSnapshot): string {
  const counts = new Map<string, number>();
  for (const c of snap.crates) {
    const key = c.layer ?? "unlayered";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const p of snap.packages) {
    const key = p.layer ?? "unlayered";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([layer, n]) => `| ${layer} | ${n} |`)
    .join("\n");
}

function formatHeadersTable(snap: MonorepoSnapshot): string {
  if (snap.headers.length === 0) return "_No C ABI headers found._";
  const rows = snap.headers.map(
    (h) =>
      `| \`${h.file}\` | ${h.defines.length} | ${h.functions.length} | ${h.functions
        .slice(0, 6)
        .map((f) => `\`${f}\``)
        .join(", ")} |`,
  );
  return [
    "| Header | Defines | Exports | Sample Symbols |",
    "| :--- | ---: | ---: | :--- |",
    ...rows,
  ].join("\n");
}

function formatBunCratesTable(snap: MonorepoSnapshot): string {
  if (!snap.bunCrates.length) return "_No bun_* crate in the root Cargo.toml [workspace.dependencies]._";
  return [
    `${snap.bunCrates.length} Bun Rust crates absorbed into \`src/\` (root \`Cargo.toml\` [workspace.dependencies]).`,
    "",
    "| Crate | Path |",
    "| :--- | :--- |",
    ...snap.bunCrates.map((c) => `| \`${c.name}\` | \`${c.path}\` |`),
  ].join("\n");
}

/** Generates docs/PLAN.mdx in Bun Docs MDX format. */
export function buildPlanMdx(snap: MonorepoSnapshot): string {
  const layerTable = formatLayerSummary(snap);
  const headersTable = formatHeadersTable(snap);
  const bunCratesTable = formatBunCratesTable(snap);
  const topLangs = snap.topClasses
    .slice(0, 8)
    .map(
      (c) =>
        `| \`${c.layer}/${c.feature}\` | ${c.language} | ${c.files} | ${c.symbols} |`,
    )
    .join("\n");

  const body = `# Aphrody Master Architectural Plan

<Callout type="info" title="Live Snapshot">
Generated from live monorepo metadata on \`${snap.collectedAt}\` (${snap.crates.length} crates, ${snap.packages.length} packages, ${snap.apps.length} apps).
</Callout>

<Cards>
  <Card title="Pure C23 LLVM Core" href="/docs/llvm/PURE-C-LLVM" description="C23/C++23 ABI headers, ThinLTO, DEPS.rules layers, and absorbed Bun crates." />
  <Card title="Modern Web Guidance" href="/docs/web/MODERN-WEB-GUIDANCE" description="@aphrody/wck hybrid BM25+Int8 RAG, mwg_capi.dll, and agent MCP." />
</Cards>

## 1. Monorepo Topology

- **Rust Workspace**: edition \`${snap.workspace.edition}\`, MSRV \`${snap.workspace.rustVersion}\`, \`${snap.crates.length}\` crates in \`frameworks/*\`, \`system/*\` and \`hardware/*\`, \`${snap.workspace.workspaceDepsCount}\` workspace dependencies in \`Cargo.toml\`.
- **Bun Packages**: \`${snap.packages.length}\` zero-dependency \`@aphrody/*\` packages in \`packages/*\` on Bun.
- **Applications**: \`${snap.apps.length}\` directories in \`apps/*\`.
${snap.graphify ? `- **Code Graph**: \`${snap.graphify.nodes}\` nodes, \`${snap.graphify.edges}\` edges, \`${snap.graphify.communities}\` communities (\`${snap.graphify.source}\`).` : ""}
${snap.indexCounts ? `- **SQLite Index**: \`${snap.indexCounts.files}\` files, \`${snap.indexCounts.symbols}\` symbols, \`${snap.indexCounts.imports}\` imports, \`${snap.indexCounts.refs}\` calls.` : ""}

## 2. Layered Dependency Architecture (\`DEPS.rules\`)

Every unit declares its layer (\`L0\` toolchain through \`L5\` surfaces) enforced by \`bun scripts/checkdeps.ts\`.

| Layer | Units |
| :--- | ---: |
${layerTable}

## 3. Pure C23 LLVM ABI Core

All native cross-language boundaries converge on C ABI headers in \`system/core/capi/include/\` consumed by Bun (\`bun:ffi\`), Rust (\`system/core/capi\`), and Zig.

${headersTable}

## 4. Absorbed Bun Crates

${bunCratesTable}

## 5. Modern Web Guidance & Agent Tooling

\`@aphrody/wck\` (\`system/wck\`) combines pure Bun RAG hybrid search (BM25 + Int8 quantized embeddings + RRF), \`.mwgrc\` Baseline gates, and \`mwg_capi.dll\` (\`aphrody_mwg.h\`) with \`frameworks/ai-os\` MCP tools.

## 6. Top Indexed Codebase Clusters

${topLangs ? `| Cluster | Language | Files | Symbols |\n| :--- | :--- | ---: | ---: |\n${topLangs}` : "_Run `bun system/core-ts/src/cli.ts index` or `gen-docs --scan` to populate cluster metrics._"}
`;

  return renderMdx({
    title: "Aphrody Master Architectural Plan",
    description:
      "Live monorepo architecture: Pure C23 LLVM ABI core, Bun, Rust, Zig, DEPS.rules layers, and @aphrody/wck.",
    body,
  });
}

/** Generates docs/native/llvm/PURE-C-LLVM.mdx in Bun Docs MDX format. */
export function buildPureCLlvmMdx(snap: MonorepoSnapshot): string {
  const headersTable = formatHeadersTable(snap);
  const bunCratesTable = formatBunCratesTable(snap);
  const l0l1 = snap.crates
    .filter((c) => c.layer === "L0" || c.layer === "L1")
    .map((c) => `- \`${c.dir}\` (\`${c.name}\`, ${c.layer})`)
    .join("\n");

  const body = `# Pure C23 LLVM Core and C ABI

<Callout type="warn" title="Compiler & ABI Contract">
Every header in \`system/core/capi/include/*.h\` must pass \`clang -std=c23 -Wall -Wextra -Wpedantic -Werror -fsyntax-only\` and \`clang++ -std=c++23 -Wall -Wextra -Werror -fno-exceptions -fno-rtti -fsyntax-only\` with zero warnings.
</Callout>

Generated from \`system/core/capi/include/*.h\`, \`system/*/DEPS.rules\` and the root \`Cargo.toml\`.

## 1. Compiler and ABI Rigor

- **C Standard**: C23 (\`-std=c23 -Wall -Wextra -Wpedantic -Werror\`) with C++23 header compatibility (\`-fno-exceptions -fno-rtti\`).
- **Linker & LTO**: shared LLVM toolchain (\`clang\` / \`clang-cl\`, \`lld\` / \`lld-link\`) with ThinLTO (\`-flto=thin\`, \`-Clinker-plugin-lto\`) across C, Rust, and Zig.
- **Memory Ownership**: caller frees returned strings via the matching \`*_free(char *p)\` function; ABI version is queried via \`*_abi_version()\`.

## 2. Exported C ABI Headers

${headersTable}

## 3. Base Layers (\`L0\` / \`L1\` in \`DEPS.rules\`)

${l0l1 || "_No L0/L1 crates found._"}

## 4. Absorbed Bun Crates

${bunCratesTable}

## 5. Verification Commands

<Tabs items={["C23", "C++23", "Bun"]}>
<Tab value="C23">

\`\`\`sh
clang -std=c23 -Wall -Wextra -Wpedantic -Werror -fsyntax-only -x c system/core/capi/include/aphrody_core.h system/core/capi/include/aphrody_zig.h system/core/capi/include/aphrody_mwg.h
\`\`\`

</Tab>
<Tab value="C++23">

\`\`\`sh
clang++ -std=c++23 -Wall -Wextra -Werror -fno-exceptions -fno-rtti -fsyntax-only -x c++ system/core/capi/include/aphrody_zig.h system/core/capi/include/aphrody_mwg.h
\`\`\`

</Tab>
<Tab value="Bun">

\`\`\`sh
bun test ./system/core-ts/test/
\`\`\`

</Tab>
</Tabs>
`;

  return renderMdx({
    title: "Pure C23 LLVM Core and C ABI",
    description:
      "C23/C++23 ABI headers, -Wall -Wextra -Wpedantic -Werror, ThinLTO, DEPS.rules base layers, and absorbed Bun crates.",
    body,
  });
}

/** Generates docs/web/MODERN-WEB-GUIDANCE.mdx in Bun Docs MDX format. */
export function buildModernWebGuidanceMdx(snap: MonorepoSnapshot): string {
  const wckPkg = snap.packages.find((p) => p.dir === "system/wck");
  const mwgHeader = snap.headers.find((h) => h.file.endsWith("aphrody_mwg.h"));

  const body = `# Modern Web Guidance, RAG, and @aphrody/wck

<Callout type="info" title="Zero-Dependency Pure Bun + C23 Native Core">
\`@aphrody/wck\` runs with zero external npm dependencies on Bun, pairing \`mwg_capi.dll\` (\`bun:ffi\`) with a deterministic pure-Bun fallback.
</Callout>

Generated from \`system/wck\`, \`system/core/capi/include/\`, and \`frameworks/ai-os\`.

## 1. Package Overview

- **Package**: \`${wckPkg?.name ?? "@aphrody/wck"}\` v${wckPkg?.version ?? "1.0.0"} (${wckPkg?.depsCount ?? 0} external npm dependencies).
- **Description**: ${wckPkg?.description ?? "Compile-Time Web Validator (Google SEO + AI Mode SEO + Modern Web Guidelines + Core Web Vitals + Lighthouse 100 + WASM + WebGPU Chromium Spec)"}.
- **Native Core**: \`mwg_capi.dll\` compiled from \`system/core/capi/c/mwg_core.c\` with C23 strict flags and \`bun:ffi\` bridge (\`system/wck/src/mwg-ffi.ts\`) plus deterministic pure-Bun fallback.

## 2. C ABI Surface (\`aphrody_mwg.h\`)

${
  mwgHeader
    ? `- **Defines (${mwgHeader.defines.length})**: ${mwgHeader.defines.map((d) => `\`${d}\``).join(", ")}\n- **Functions (${mwgHeader.functions.length})**: ${mwgHeader.functions.map((f) => `\`${f}\``).join(", ")}`
    : "- Expected exports: `mwg_abi_version`, `mwg_free`, `mwg_audit_html_json`, `mwg_audit_css_json`, `mwg_audit_js_json`, `mwg_parse_mdx_json`, `mwg_search_guidance_json`, `mwg_feature_lookup_json`, `mwg_hash64`."
}

## 3. Hybrid RAG Search and Baseline Gates

<Cards>
  <Card title="Hybrid Retrieval" description="Okapi BM25 lexical scoring + Int8 quantized 256d static embeddings fused via Reciprocal Rank Fusion (RRF) over system/wck/data/." />
  <Card title="Baseline Gates & MCP" description=".mwgrc configuration, legacy-scan/search/retrieve/list/baselinestatus/mdx CLI subcommands, and frameworks/ai-os MCP tool integration." />
</Cards>

## 4. Verification

\`\`\`sh
bun test ./system/wck
bun check system/wck
\`\`\`
`;

  return renderMdx({
    title: "Modern Web Guidance and @aphrody/wck",
    description:
      "Pure Bun Modern Web Guidance validator, hybrid BM25+Int8 RAG, mwg_capi.dll C23 FFI, and agent MCP integration.",
    body,
  });
}
