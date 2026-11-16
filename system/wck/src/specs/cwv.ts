import type { SpecCheck, SpecResult, WebFilesContext } from "../types";

export function validateCoreWebVitalsSpec(ctx: WebFilesContext): SpecResult {
  const checks: SpecCheck[] = [];
  const errors: string[] = [];

  // The entry document, not whichever HTML file the directory walk found first.
  const mainHtml =
    ctx.htmlFiles.find((f) => f.relPath === "index.html") ?? ctx.htmlFiles[0];
  if (!mainHtml) {
    return {
      specId: "cwv",
      title: "Spec 4 — Core Web Vitals Static Gate",
      score: 0,
      passed: false,
      checks: [
        {
          id: "cwv-html-present",
          name: "HTML Document Presence",
          description: "Target contains at least one HTML document",
          status: "fail",
          details: "No HTML document found in target directory",
        },
      ],
      errors: ["No HTML document found in target directory"],
    };
  }

  const html = mainHtml.content;
  const allCss =
    ctx.cssFiles.map((f) => f.content).join("\n") +
    (html
      .match(/<style[^>]*>([\s\S]*?)<\/style>/gi)
      ?.map((s) => s.replace(/<\/?style[^>]*>/gi, ""))
      .join("\n") || "");

  // 1. CLS = 0.000 Gate: Explicit Dimensions on Media Elements
  const mediaElements: Array<{ tag: string; match: string; hasDim: boolean }> =
    [];

  // <img> tags
  const imgRegex = /<img\b([^>]*)>/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const attrs = imgMatch[1];
    const hasW = /width=["']?\d+/i.test(attrs);
    const hasH = /height=["']?\d+/i.test(attrs);
    const hasAspectRatio = /aspect-ratio\s*:/i.test(attrs);
    mediaElements.push({
      tag: "img",
      match: imgMatch[0].slice(0, 40),
      hasDim: (hasW && hasH) || hasAspectRatio,
    });
  }

  // <svg> tags (root SVGs)
  const svgRegex = /<svg\b([^>]*)>/gi;
  let svgMatch: RegExpExecArray | null;
  while ((svgMatch = svgRegex.exec(html)) !== null) {
    const attrs = svgMatch[1];
    const hasW = /width=["']?\d+/i.test(attrs);
    const hasH = /height=["']?\d+/i.test(attrs);
    const hasViewbox =
      /viewBox=["']\s*[\d\.\-]+\s+[\d\.\-]+\s+(\d+)\s+(\d+)/i.test(attrs);
    const hasAspectRatio = /aspect-ratio\s*:/i.test(attrs);
    mediaElements.push({
      tag: "svg",
      match: svgMatch[0].slice(0, 40),
      hasDim:
        (hasW && hasH) || (hasViewbox && (hasW || hasH)) || hasAspectRatio,
    });
  }

  // <canvas> tags
  const canvasRegex = /<canvas\b([^>]*)>/gi;
  let canvasMatch: RegExpExecArray | null;
  while ((canvasMatch = canvasRegex.exec(html)) !== null) {
    const attrs = canvasMatch[1];
    const hasW = /width=["']?\d+/i.test(attrs);
    const hasH = /height=["']?\d+/i.test(attrs);
    const hasAspectRatio = /aspect-ratio\s*:/i.test(attrs);
    mediaElements.push({
      tag: "canvas",
      match: canvasMatch[0].slice(0, 40),
      hasDim: (hasW && hasH) || hasAspectRatio,
    });
  }

  // <video> tags
  const videoRegex = /<video\b([^>]*)>/gi;
  let videoMatch: RegExpExecArray | null;
  while ((videoMatch = videoRegex.exec(html)) !== null) {
    const attrs = videoMatch[1];
    const hasW = /width=["']?\d+/i.test(attrs);
    const hasH = /height=["']?\d+/i.test(attrs);
    const hasAspectRatio = /aspect-ratio\s*:/i.test(attrs);
    mediaElements.push({
      tag: "video",
      match: videoMatch[0].slice(0, 40),
      hasDim: (hasW && hasH) || hasAspectRatio,
    });
  }

  const unconstrainedMedia = mediaElements.filter((m) => !m.hasDim);
  if (unconstrainedMedia.length === 0) {
    checks.push({
      id: "cwv-cls-media",
      name: "CLS = 0.000: Media Explicit Dimensions",
      description:
        "All <img>, <svg>, <canvas>, and <video> elements declare explicit width & height",
      status: "pass",
      metric: `${mediaElements.length} media elements zero-shift verified`,
    });
  } else {
    const err = `Found ${unconstrainedMedia.length} media elements without width/height dimensions: ${unconstrainedMedia.map((m) => m.match).join(", ")}`;
    errors.push(err);
    checks.push({
      id: "cwv-cls-media",
      name: "CLS = 0.000: Media Explicit Dimensions",
      description:
        "All <img>, <svg>, <canvas>, and <video> elements declare explicit width & height",
      status: "fail",
      details: err,
    });
  }

  // 2. CLS = 0.000 Gate: Compositor-Only CSS Keyframe Animations
  const keyframesRegex = /@keyframes\s+([a-zA-Z0-9\-_]+)\s*\{([\s\S]*?)\}/gi;
  let kMatch: RegExpExecArray | null;
  const layoutThrashingKeyframes: string[] = [];

  while ((kMatch = keyframesRegex.exec(allCss)) !== null) {
    const name = kMatch[1];
    const body = kMatch[2];
    const layoutProps = [
      /\btop\s*:/i,
      /\bleft\s*:/i,
      /\bright\s*:/i,
      /\bbottom\s*:/i,
      /\bwidth\s*:/i,
      /\bheight\s*:/i,
      /\bmargin/i,
      /\bpadding/i,
    ];
    for (const prop of layoutProps) {
      if (prop.test(body)) {
        layoutThrashingKeyframes.push(`${name} (${prop.source})`);
        break;
      }
    }
  }

  if (layoutThrashingKeyframes.length === 0) {
    checks.push({
      id: "cwv-cls-keyframes",
      name: "CLS = 0.000: Compositor-Only Animations",
      description:
        "CSS keyframes use transform/opacity without layout-thrashing properties",
      status: "pass",
      metric: "Compositor-only keyframes",
    });
  } else {
    const err = `Layout-thrashing CSS keyframes detected: ${layoutThrashingKeyframes.join(", ")}`;
    errors.push(err);
    checks.push({
      id: "cwv-cls-keyframes",
      name: "CLS = 0.000: Compositor-Only Animations",
      description:
        "CSS keyframes use transform/opacity without layout-thrashing properties",
      status: "fail",
      details: err,
    });
  }

  // 3. LCP Budget Gate: Initial HTML + Gzipped CSS < 14 KB (TCP IW10 Congestion Window)
  const htmlRawBytes = Buffer.byteLength(html, "utf-8");
  // Only stylesheets this document actually links block its first render.
  let cssGzBytes = 0;
  for (const cssFile of linkedStylesheets(html, ctx.cssFiles)) {
    const gz = Bun.gzipSync(Buffer.from(cssFile.content, "utf-8"));
    cssGzBytes += gz.length;
  }
  const lcpTotalBytes = htmlRawBytes + cssGzBytes;
  const lcpBudget = 14 * 1024; // 14,336 bytes

  if (lcpTotalBytes <= lcpBudget) {
    checks.push({
      id: "cwv-lcp-budget",
      name: "LCP Initial TCP Window Budget (< 14 KB)",
      description:
        "Initial HTML + gzipped CSS fits inside single TCP IW10 congestion window (< 14 KB)",
      status: "pass",
      metric: `${(lcpTotalBytes / 1024).toFixed(2)} KB / 14 KB (${(htmlRawBytes / 1024).toFixed(2)} KB HTML + ${(cssGzBytes / 1024).toFixed(2)} KB CSS.gz)`,
    });
  } else {
    const err = `Initial payload (${(lcpTotalBytes / 1024).toFixed(2)} KB) exceeds 14 KB TCP IW10 budget`;
    errors.push(err);
    checks.push({
      id: "cwv-lcp-budget",
      name: "LCP Initial TCP Window Budget (< 14 KB)",
      description:
        "Initial HTML + gzipped CSS fits inside single TCP IW10 congestion window (< 14 KB)",
      status: "fail",
      details: err,
      metric: `${(lcpTotalBytes / 1024).toFixed(2)} KB`,
    });
  }

  // 4. Critical Render Path: Zero Render-Blocking Third-Party Scripts
  const scriptRegex = /<script\b([^>]*)>/gi;
  let scMatch: RegExpExecArray | null;
  const renderBlockingScripts: string[] = [];

  while ((scMatch = scriptRegex.exec(html)) !== null) {
    const attrs = scMatch[1];
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (srcMatch) {
      const src = srcMatch[1];
      const isAsync = /\basync\b/i.test(attrs);
      const isDefer = /\bdefer\b/i.test(attrs);
      const isModule = /type=["']module["']/i.test(attrs);
      if (!isAsync && !isDefer && !isModule) {
        renderBlockingScripts.push(src);
      }
    }
  }

  if (renderBlockingScripts.length === 0) {
    checks.push({
      id: "cwv-render-blocking",
      name: "Critical Render Path Optimization",
      description:
        "No synchronous render-blocking external scripts in critical path",
      status: "pass",
      metric: "0 render-blocking scripts",
    });
  } else {
    const err = `Found render-blocking external scripts: ${renderBlockingScripts.join(", ")}`;
    errors.push(err);
    checks.push({
      id: "cwv-render-blocking",
      name: "Critical Render Path Optimization",
      description:
        "No synchronous render-blocking external scripts in critical path",
      status: "fail",
      details: err,
    });
  }

  // 5. INP Budget Gate: Initial JS Bundle Gzipped Size < 30 KB
  let maxJsGzBytes = 0;
  for (const jsFile of ctx.jsFiles) {
    const gz = Bun.gzipSync(Buffer.from(jsFile.content, "utf-8"));
    if (gz.length > maxJsGzBytes) {
      maxJsGzBytes = gz.length;
    }
  }
  const inpBudget = 30 * 1024; // 30,720 bytes
  if (maxJsGzBytes <= inpBudget) {
    checks.push({
      id: "cwv-inp-budget",
      name: "INP Parse & Execution Budget (< 30 KB)",
      description:
        "Initial client JS bundle gzipped size < 30 KB ensuring < 15 ms parse and < 50 ms INP",
      status: "pass",
      metric: `${(maxJsGzBytes / 1024).toFixed(2)} KB / 30 KB (gz)`,
    });
  } else {
    const err = `JS bundle gzipped size (${(maxJsGzBytes / 1024).toFixed(2)} KB) exceeds 30 KB INP budget`;
    errors.push(err);
    checks.push({
      id: "cwv-inp-budget",
      name: "INP Parse & Execution Budget (< 30 KB)",
      description:
        "Initial client JS bundle gzipped size < 30 KB ensuring < 15 ms parse and < 50 ms INP",
      status: "fail",
      details: err,
      metric: `${(maxJsGzBytes / 1024).toFixed(2)} KB`,
    });
  }

  const passedCount = checks.filter((c) => c.status === "pass").length;
  const score = Math.round((passedCount / checks.length) * 100);

  return {
    specId: "cwv",
    title: "Spec 4 — Core Web Vitals Static Gate",
    score,
    passed: score === 100,
    checks,
    errors,
  };
}

/** CSS files referenced by `<link rel="stylesheet" href>` in the document, matched by path. */
export function linkedStylesheets<T extends { relPath: string }>(
  html: string,
  cssFiles: T[],
): T[] {
  const hrefs: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel=["']?stylesheet\b/i.test(tag)) continue;
    const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (href) hrefs.push(href.split(/[?#]/)[0].replace(/^\.?\//, ""));
  }
  return cssFiles.filter((f) =>
    hrefs.some(
      (h) =>
        f.relPath === h ||
        f.relPath.endsWith("/" + h) ||
        h.endsWith("/" + f.relPath),
    ),
  );
}
