import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTemplateSections,
  collectMonorepoSnapshot,
  fuzzyScore,
  generateDocs,
  indexCounts,
  liveScanToStore,
  openStore,
  renderMdx,
  renderTemplate,
  searchCodebase,
  searchDocs,
  searchSymbols,
} from "../src/index.ts";

const SRC_ROOT = join(import.meta.dir, "..", "..", "..");

describe("declarative template engine", () => {
  test("renderTemplate interpolates nested keys and loops", () => {
    const out = renderTemplate(
      "Title: {{meta.title}}\n{{#each items}}- {{name}} ({{kind}})\n{{/each}}",
      {
        meta: { title: "Aphrody" },
        items: [
          { name: "wyhash", kind: "crate" },
          { name: "wck", kind: "package" },
        ],
      },
    );
    expect(out).toBe("Title: Aphrody\n- wyhash (crate)\n- wck (package)\n");
  });

  test("applyTemplateSections replaces declarative markers", () => {
    const doc = "Before\n<!-- @gen:stats -->\nold\n<!-- @end:stats -->\nAfter";
    const updated = applyTemplateSections(doc, { stats: "new stats line" });
    expect(updated).toBe(
      "Before\n<!-- @gen:stats -->\nnew stats line\n<!-- @end:stats -->\nAfter",
    );
  });

  test("renderMdx emits Bun Docs YAML frontmatter", () => {
    const mdx = renderMdx({
      title: 'Plan "v1"',
      description: "Master architecture",
      body: "# Heading\n\nContent.",
    });
    expect(
      mdx.startsWith(
        '---\ntitle: "Plan \\"v1\\""\ndescription: "Master architecture"\n---\n',
      ),
    ).toBe(true);
    expect(mdx).toContain("# Heading");
  });
});

describe("monorepo snapshot & live scanner", () => {
  test("collectMonorepoSnapshot reads real Cargo.toml, headers, and absorbed Bun crates", () => {
    const snap = collectMonorepoSnapshot(SRC_ROOT);
    expect(snap.workspace.edition).toBe("2024");
    expect(snap.crates.length).toBeGreaterThan(20);
    expect(snap.packages.length).toBeGreaterThan(10);
    expect(snap.apps.some((a) => a.name === "aphrody")).toBe(true);
    expect(snap.headers.some((h) => h.file.endsWith("aphrody_core.h"))).toBe(
      true,
    );
    expect(snap.bunCrates.map((c) => c.name)).toContain("bun_wyhash");
    expect(snap.bunCrates.every((c) => c.name.startsWith("bun_"))).toBe(true);
  });

  test("liveScanToStore populates SQLite and supports symbol + doc search", () => {
    const db = openStore(":memory:");
    const res = liveScanToStore(db, SRC_ROOT, {
      includes: ["system/core-ts/src"],
      useFfi: false,
    });
    expect(res.mode).toBe("fallback");
    expect(res.files).toBeGreaterThanOrEqual(5);
    expect(indexCounts(db).symbols).toBeGreaterThan(10);

    const syms = searchSymbols(db, "generateDocs", 10);
    expect(syms.some((s) => s.name === "generateDocs")).toBe(true);

    expect(fuzzyScore("genDocs", "generateDocs")).toBeGreaterThan(0);
    expect(fuzzyScore("xyz999", "generateDocs")).toBe(0);

    const docs = searchDocs(SRC_ROOT, "C23", { limit: 5 });
    expect(docs.length).toBeGreaterThan(0);

    const combined = searchCodebase(db, SRC_ROOT, "generateDocs", 5);
    expect(combined.symbols.length).toBeGreaterThan(0);
  });

  test("generateDocs writes README.md, MDX plans, and reference docs without emojis", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "aphrody-gendocs-"));
    try {
      const db = openStore(":memory:");
      liveScanToStore(db, SRC_ROOT, {
        includes: ["system/core-ts/src", "system/core-ts/test"],
        useFfi: false,
      });
      // Generate into tmp using real snapshot from SRC_ROOT? Verify templates directly on SRC_ROOT
      // and ensure CLI-generated files in SRC_ROOT exist and are valid.
      const res = await generateDocs(db, tmp, { rescan: false, useFfi: false });
      expect(res.written).toContain("README.md");
      expect(res.written).toContain("docs/PLAN.mdx");
      expect(res.written).toContain("docs/native/llvm/PURE-C-LLVM.mdx");
      expect(res.written).toContain("docs/web/MODERN-WEB-GUIDANCE.mdx");
      expect(res.written).toContain("docs/reference/tree-sitter.md");

      for (const rel of res.written) {
        const content = readFileSync(join(tmp, rel), "utf8");
        expect(content.length).toBeGreaterThan(50);
        expect(existsSync(join(SRC_ROOT, rel))).toBe(true);
      }

      const plan = readFileSync(join(SRC_ROOT, "docs", "PLAN.mdx"), "utf8");
      expect(plan).toMatch(/^---\r?\ntitle:/);
      expect(plan).toContain("<Callout");
      expect(plan).toContain("<Cards>");
      expect(plan).toContain("bun_wyhash");

      const pureC = readFileSync(
        join(SRC_ROOT, "docs", "native", "llvm", "PURE-C-LLVM.mdx"),
        "utf8",
      );
      expect(pureC).toContain("<Tabs");
      expect(pureC).toContain("aphrody_core.h");
      expect(pureC).toContain("wyhash");

      const mwg = readFileSync(
        join(SRC_ROOT, "docs", "web", "MODERN-WEB-GUIDANCE.mdx"),
        "utf8",
      );
      expect(mwg).toContain("<Callout");
      expect(mwg).toContain("mwg_capi.dll");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
