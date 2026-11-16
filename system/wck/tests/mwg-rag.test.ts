import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FeatureGateError,
  OriginTrialGateError,
  VolatileFeatureGateError,
  buildBm25Index,
  listUseCases,
  lookupBaselineStatus,
  mwgAuditCss,
  mwgAuditHtml,
  mwgAuditJs,
  mwgCapabilities,
  mwgFeatureLookup,
  mwgHash64,
  mwgParseMdx,
  mwgSearchGuidanceNative,
  normalizeBaselineTarget,
  rankBm25,
  reciprocalRankFusion,
  retrieveUseCase,
  scanLegacyPatterns,
  searchUseCases,
} from "../src/index";

describe("MWG Pure-C23 LLVM FFI Core (mwg_capi.dll)", () => {
  test("loads mwg_capi.dll with ABI v1", () => {
    const caps = mwgCapabilities();
    expect(caps.abi).toBe(1);
    expect(caps.native).toBe(true);
    expect(caps.engine).toBe("mwg-c23");
  });

  test("mwgAuditHtml, mwgAuditCss, mwgAuditJs, mwgParseMdx, mwgHash64", () => {
    const htmlRes = mwgAuditHtml(
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Test</title></head><body><main>Hi</main></body></html>',
    );
    expect(htmlRes.score).toBe(100);
    expect(htmlRes.hasDoctype).toBe(true);
    expect(htmlRes.userScalableNo).toBe(false);

    const cssRes = mwgAuditCss(
      ":root { color-scheme: light dark; } :focus-visible { outline: 2px solid; } @media (prefers-reduced-motion: reduce) {}",
    );
    expect(cssRes.score).toBe(100);
    expect(cssRes.hasFocusVisible).toBe(true);

    const jsRes = mwgAuditJs("const x = 1; eval('bad()');");
    expect(jsRes.usesEval).toBe(true);
    expect(jsRes.score).toBeLessThan(100);

    const mdxRes = mwgParseMdx(
      "---\ntitle: Hello\ndescription: World\n---\n\n# Heading One\n\n```ts\nconst a = 1;\n```\n",
    );
    expect(mdxRes.frontmatter.title).toBe("Hello");
    expect(mdxRes.headings.length).toBe(1);
    expect(mdxRes.headings[0].text).toBe("Heading One");
    expect(mdxRes.codeBlocks).toBe(1);

    const h1 = mwgHash64("aphrody");
    const h2 = mwgHash64("aphrody");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(0n);
  });

  test("mwgSearchGuidanceNative and mwgFeatureLookup", () => {
    const hits = mwgSearchGuidanceNative(
      "popover",
      [
        { id: "popover-guide", text: "Use native popover attribute" },
        { id: "grid-guide", text: "CSS grid layout" },
      ],
      5,
    );
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("popover-guide");

    const feat = mwgFeatureLookup("popover");
    expect(feat.found).toBe(true);
    expect(feat.baseline).toBe("newly");
  });
});

describe("MWG RAG Hybrid Search & Baseline Gates", () => {
  test("BM25 + RRF ranking works deterministically", () => {
    const idx = buildBm25Index([
      { id: "a", text: "animate height auto with interpolate-size" },
      { id: "b", text: "css grid subgrid layout alignment" },
    ]);
    const bm = rankBm25(idx, "interpolate-size height");
    expect(bm[0].id).toBe("a");

    const fused = reciprocalRankFusion([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(fused.length).toBe(2);
  });

  test("hybrid searchUseCases returns relevant guides from bundled data", async () => {
    const results = await searchUseCases("animate height auto accordion", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === "animate-to-intrinsic-sizes")).toBe(
      true,
    );
  });

  test("listUseCases, retrieveUseCase, and .mwgrc gates", async () => {
    const all = listUseCases();
    expect(all.length).toBeGreaterThan(200);

    const dir = mkdtempSync(join(tmpdir(), "wck-mwgrc-"));
    try {
      writeFileSync(join(dir, ".mwgrc"), JSON.stringify({ baseline: "newly" }));
      const guide = await retrieveUseCase("animate-to-intrinsic-sizes", {
        cwd: dir,
      });
      expect(guide).toContain("Project Baseline Target");
      expect(guide).toContain("interpolate-size");

      await expect(
        retrieveUseCase("agentic-forms", { cwd: dir }),
      ).rejects.toThrow(OriginTrialGateError);

      await expect(
        retrieveUseCase("language-model", { cwd: dir }),
      ).rejects.toThrow(VolatileFeatureGateError);

      writeFileSync(
        join(dir, ".mwgrc"),
        JSON.stringify({
          allowOriginTrials: true,
          allowVolatileFeatures: true,
        }),
      );
      const otGuide = await retrieveUseCase("agentic-forms", { cwd: dir });
      expect(otGuide.length).toBeGreaterThan(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(FeatureGateError.name).toBe("FeatureGateError");
    expect(normalizeBaselineTarget("Baseline 2024")).toBe("2024");
  });

  test("lookupBaselineStatus & scanLegacyPatterns", () => {
    const rows = lookupBaselineStatus("popover");
    expect(rows.length).toBeGreaterThan(0);

    const dir = mkdtempSync(join(tmpdir(), "wck-scan-"));
    try {
      writeFileSync(
        join(dir, "legacy.css"),
        "::-webkit-scrollbar { width: 8px; }\n.box { outline: none; }\n",
      );
      const report = scanLegacyPatterns(dir);
      expect(report.totalFindings).toBe(2);
      expect(report.guides.some((g) => g.guideId === "scrollbar-color")).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
