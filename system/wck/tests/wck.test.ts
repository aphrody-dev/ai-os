import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  validateWeb,
  validateSeoSpec,
  validateAiSeoSpec,
  validateModernWebGuidelinesSpec,
  validateCoreWebVitalsSpec,
  validateLighthouseGate,
  validateWasmSpec,
  validateWebGpuSpec,
} from "../src/index";
import type { WebFilesContext } from "../src/types";

const ROOT_DIR = join(import.meta.dir, "..");

describe("WCK Zero-Dependency Architecture", () => {
  it("should have ZERO external dependencies in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT_DIR, "package.json"), "utf-8"),
    );
    expect(Object.keys(pkg.dependencies || {}).length).toBe(0);
    expect(Object.keys(pkg.devDependencies || {}).length).toBe(0);
  });

  it("should not have node_modules directory", () => {
    expect(existsSync(join(ROOT_DIR, "node_modules"))).toBe(false);
  });
});

describe("Spec 1 — Google Search SEO Engine", () => {
  it("should score 100 on fully compliant SEO document with landmarks and robots/sitemap", () => {
    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content: `
            <!doctype html>
            <html lang="fr">
              <head>
                <meta charset="utf-8">
                <title>Aphrody - Moteur de recherche souverain</title>
                <meta name="description" content="Recherchez sur le Web avec Aphrody, le portail et moteur souverain moderne et ultra-performant.">
                <link rel="canonical" href="https://aphrody.com/">
                <meta property="og:title" content="Aphrody - Moteur souverain">
                <meta property="og:description" content="Recherchez sur le Web avec Aphrody, portail moderne.">
                <meta property="og:url" content="https://aphrody.com/">
                <meta property="og:type" content="website">
              </head>
              <body>
                <header><nav><a href="/" aria-label="Accueil">Accueil</a></nav></header>
                <main>
                  <h1>Aphrody</h1>
                  <button aria-label="Rechercher">Rechercher</button>
                  <input type="text" aria-label="Recherche" placeholder="Rechercher">
                  <svg role="img" aria-label="Logo" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>
                </main>
                <footer><p>© 2026 Aphrody</p></footer>
              </body>
            </html>
          `,
        },
      ],
      cssFiles: [],
      jsFiles: [],
      wasmFiles: [],
      wgslFiles: [],
      robotsTxt:
        "User-agent: *\nAllow: /\nSitemap: https://aphrody.com/sitemap.xml",
      sitemapXml: `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://aphrody.com/</loc></url>
        </urlset>`,
    };

    const res = validateSeoSpec(mockCtx);
    expect(res.score).toBe(100);
    expect(res.passed).toBe(true);
    expect(res.errors.length).toBe(0);

    const indexCtx: WebFilesContext = {
      ...mockCtx,
      sitemapXml: `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://aphrody.com/sitemap-core.xml</loc></sitemap>
        </sitemapindex>`,
    };
    const indexRes = validateSeoSpec(indexCtx);
    expect(indexRes.score).toBe(100);
    expect(indexRes.passed).toBe(true);
  });

  it("should fail when title length is outside 10..60 characters", () => {
    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content: `
            <!doctype html>
            <html lang="fr"><head><meta charset="utf-8"><title>Short</title></head><body></body></html>
          `,
        },
      ],
      cssFiles: [],
      jsFiles: [],
      wasmFiles: [],
      wgslFiles: [],
    };

    const res = validateSeoSpec(mockCtx);
    expect(res.score).toBeLessThan(100);
    expect(res.errors.some((e) => e.includes("<title>"))).toBe(true);
  });
});

describe("Spec 2 — Google AI Mode SEO & Generative Engine Optimization", () => {
  it("should score 100 on valid Schema.org JSON-LD, meta robots GEO directives, and /llms.txt", () => {
    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content: `
            <!doctype html>
            <html>
              <head>
                <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
                <script type="application/ld+json">
                {
                  "@context": "https://schema.org",
                  "@type": "WebSite",
                  "name": "Aphrody",
                  "potentialAction": {
                    "@type": "SearchAction",
                    "target": "https://aphrody.com/api/q?q={search_term_string}"
                  }
                }
                </script>
              </head>
              <body></body>
            </html>
          `,
        },
      ],
      cssFiles: [],
      jsFiles: [],
      wasmFiles: [],
      wgslFiles: [],
      llmsTxt: `# Aphrody AI Index\n\nCanonical index and LLM search endpoints for https://aphrody.com/api/q`,
    };

    const res = validateAiSeoSpec(mockCtx);
    expect(res.score).toBe(100);
    expect(res.passed).toBe(true);
  });
});

describe("Spec 3 — Modern Web Guidelines & WCAG 2.2 AA", () => {
  it("should pass when responsive viewport, color-scheme, focus-visible, and reduced-motion are present", () => {
    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content: `
            <!doctype html>
            <html>
              <head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="color-scheme" content="light dark">
              </head>
              <body></body>
            </html>
          `,
        },
      ],
      cssFiles: [
        {
          path: "/virtual/style.css",
          relPath: "style.css",
          content: `
            :focus-visible { outline: 2px solid blue; }
            @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
          `,
          size: 120,
        },
      ],
      jsFiles: [],
      wasmFiles: [],
      wgslFiles: [],
    };

    const res = validateModernWebGuidelinesSpec(mockCtx);
    expect(res.score).toBe(100);
    expect(res.passed).toBe(true);
  });

  it("should fail when user-scalable=no is declared in viewport", () => {
    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content: `<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">`,
        },
      ],
      cssFiles: [],
      jsFiles: [],
      wasmFiles: [],
      wgslFiles: [],
    };

    const res = validateModernWebGuidelinesSpec(mockCtx);
    expect(res.score).toBeLessThan(100);
    expect(res.errors.some((e) => e.includes("user-scalable=no"))).toBe(true);
  });
});

describe("Spec 4 — Core Web Vitals Static Gate", () => {
  it("LCP budget uses index.html and only the stylesheets that page links", () => {
    // 40 KB of unlinked CSS (used by other pages) must not count against the homepage.
    // Random hex does not compress, so the gzipped size stays far above the 14 KB budget.
    const unlinked = Array.from(
      crypto.getRandomValues(new Uint8Array(20 * 1024)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const ctx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: false,
      htmlFiles: [
        {
          path: "/virtual/en/index.html",
          relPath: "en/index.html",
          content: "<p>" + "x".repeat(20 * 1024) + "</p>",
        },
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content:
            '<!doctype html><html><head><link rel="stylesheet" href="/home.css"></head><body><h1>Home</h1></body></html>',
        },
      ],
      cssFiles: [
        {
          path: "/virtual/home.css",
          relPath: "home.css",
          content: "body{margin:0}",
          size: 14,
        },
        {
          path: "/virtual/style.css",
          relPath: "style.css",
          content: unlinked,
          size: unlinked.length,
        },
      ],
      jsFiles: [],
      wasmFiles: [],
      wgslFiles: [],
    } as WebFilesContext;
    const budget = validateCoreWebVitalsSpec(ctx).checks.find(
      (c) => c.id === "cwv-lcp-budget",
    );
    expect(budget?.status).toBe("pass");
  });

  it("should verify CLS = 0.000 explicit dimensions, compositor keyframes, LCP < 14KB, and INP < 30KB", () => {
    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content: `
            <!doctype html>
            <html>
              <body>
                <img src="/logo.png" width="200" height="100" alt="Logo">
                <canvas width="800" height="600"></canvas>
                <script type="module" src="/app.js"></script>
              </body>
            </html>
          `,
        },
      ],
      cssFiles: [
        {
          path: "/virtual/style.css",
          relPath: "style.css",
          content: `
            @keyframes fadeIn {
              from { opacity: 0; transform: translateY(10px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `,
          size: 200,
        },
      ],
      jsFiles: [
        {
          path: "/virtual/app.js",
          relPath: "app.js",
          content: `console.log("Aphrody ready");`,
          size: 500,
        },
      ],
      wasmFiles: [],
      wgslFiles: [],
    };

    const res = validateCoreWebVitalsSpec(mockCtx);
    expect(res.score).toBe(100);
    expect(res.passed).toBe(true);
  });

  it("should reject layout-thrashing CSS keyframes animating top/left/width/height", () => {
    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content: `<!doctype html><html><body></body></html>`,
        },
      ],
      cssFiles: [
        {
          path: "/virtual/style.css",
          relPath: "style.css",
          content: `@keyframes badAnimation { from { top: 0px; left: 10px; } to { top: 50px; left: 100px; } }`,
          size: 150,
        },
      ],
      jsFiles: [],
      wasmFiles: [],
      wgslFiles: [],
    };

    const res = validateCoreWebVitalsSpec(mockCtx);
    expect(res.score).toBeLessThan(100);
    expect(res.errors.some((e) => e.includes("Layout-thrashing"))).toBe(true);
  });
});

describe("Spec 5 — Lighthouse 100/100/100/100 Gate", () => {
  it("should score 100 when standards doctype, HTTPS, and zero eval are satisfied", () => {
    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [
        {
          path: "/virtual/index.html",
          relPath: "index.html",
          content: `
            <!doctype html>
            <html lang="fr">
              <head>
                <title>Test Page Title Valid</title>
                <meta name="description" content="Valid meta description for Lighthouse audit 100/100/100/100 compliance testing.">
                <link rel="canonical" href="https://aphrody.com/">
              </head>
              <body>
                <button aria-label="Click">Click</button>
              </body>
            </html>
          `,
        },
      ],
      cssFiles: [],
      jsFiles: [
        {
          path: "/virtual/app.js",
          relPath: "app.js",
          content: `const a = 1;`,
          size: 20,
        },
      ],
      wasmFiles: [],
      wgslFiles: [],
    };

    const res = validateLighthouseGate(mockCtx);
    expect(res.score).toBe(100);
    expect(res.passed).toBe(true);
  });
});

describe("Spec 6 — WebAssembly Spec Gate", () => {
  it("should validate and compile valid WebAssembly bytecode module", () => {
    // Minimal valid WASM binary: \0asm\x01\x00\x00\x00
    const validWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ]);

    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [],
      cssFiles: [],
      jsFiles: [],
      wasmFiles: [
        {
          path: "/virtual/module.wasm",
          relPath: "module.wasm",
          bytes: validWasm,
        },
      ],
      wgslFiles: [],
    };

    const res = validateWasmSpec(mockCtx);
    expect(res.score).toBe(100);
    expect(res.passed).toBe(true);
  });

  it("should fail when WASM magic bytes are corrupted", () => {
    const badWasm = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    ]);

    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [],
      cssFiles: [],
      jsFiles: [],
      wasmFiles: [
        {
          path: "/virtual/bad.wasm",
          relPath: "bad.wasm",
          bytes: badWasm,
        },
      ],
      wgslFiles: [],
    };

    const res = validateWasmSpec(mockCtx);
    expect(res.score).toBeLessThan(100);
    expect(res.passed).toBe(false);
  });
});

describe("Spec 7 — WebGPU & Chromium Dawn Spec Gate", () => {
  it("should validate valid WGSL compute shader with workgroup <= 256 and aligned uniform struct", () => {
    const validWgsl = `
      struct Uniforms {
        screen_size: vec2<f32>,
        scale: f32,
        pad: f32,
      };

      @group(0) @binding(0) var<uniform> u: Uniforms;

      @compute @workgroup_size(16, 16)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      }
    `;

    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [],
      cssFiles: [],
      jsFiles: [
        {
          path: "/virtual/app.js",
          relPath: "app.js",
          content: `if (!navigator.gpu) { console.warn("No WebGPU"); }`,
          size: 100,
        },
      ],
      wasmFiles: [],
      wgslFiles: [
        {
          path: "/virtual/shader.wgsl",
          relPath: "shader.wgsl",
          content: validWgsl,
        },
      ],
    };

    const res = validateWebGpuSpec(mockCtx);
    expect(res.score).toBe(100);
    expect(res.passed).toBe(true);
  });

  it("should reject workgroup_size exceeding universal Dawn limit of 256 invocations", () => {
    const badWgsl = `
      @compute @workgroup_size(32, 16)
      fn main() {}
    `; // 32 * 16 = 512 > 256!

    const mockCtx: WebFilesContext = {
      targetPath: "/virtual",
      isSingleFile: true,
      htmlFiles: [],
      cssFiles: [],
      jsFiles: [],
      wasmFiles: [],
      wgslFiles: [
        {
          path: "/virtual/bad.wgsl",
          relPath: "bad.wgsl",
          content: badWgsl,
        },
      ],
    };

    const res = validateWebGpuSpec(mockCtx);
    expect(res.score).toBeLessThan(100);
    expect(res.passed).toBe(false);
    expect(
      res.errors.some((e) => e.includes("exceeds Dawn/Chromium 256")),
    ).toBe(true);
  });
});
