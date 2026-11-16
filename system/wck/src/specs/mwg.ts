import type { SpecCheck, SpecResult, WebFilesContext } from "../types";

export function validateModernWebGuidelinesSpec(
  ctx: WebFilesContext,
): SpecResult {
  const checks: SpecCheck[] = [];
  const errors: string[] = [];

  const mainHtml = ctx.htmlFiles[0];
  if (!mainHtml) {
    return {
      specId: "mwg",
      title: "Spec 3 — Modern Web Guidelines & WCAG 2.2 AA",
      score: 0,
      passed: false,
      checks: [
        {
          id: "mwg-html-present",
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

  // 1. Viewport Meta & WCAG Zoomability
  const vpMatch =
    html.match(
      /<meta[^>]*\bname=["']viewport["'][^>]*\bcontent=["']([^"']*)["']/i,
    ) ||
    html.match(
      /<meta[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']viewport["']/i,
    );
  const vpContent = vpMatch ? vpMatch[1] : "";

  const hasWidth = /width=device-width/i.test(vpContent);
  const hasScale = /initial-scale=1/i.test(vpContent);
  const disablesZoom =
    /user-scalable\s*=\s*(no|0)/i.test(vpContent) ||
    /maximum-scale\s*=\s*1(\.0)?/i.test(vpContent);

  if (hasWidth && hasScale && !disablesZoom) {
    checks.push({
      id: "mwg-viewport",
      name: "Responsive & Scalable Viewport",
      description:
        "Declares width=device-width, initial-scale=1 without disabling zoom",
      status: "pass",
      metric: "WCAG 1.4.4 Compliant",
    });
  } else {
    let err = "";
    if (disablesZoom) {
      err =
        "Viewport disables user zoom (user-scalable=no or maximum-scale=1 violates WCAG 1.4.4)";
    } else {
      err =
        "Missing width=device-width or initial-scale=1 in viewport meta tag";
    }
    errors.push(err);
    checks.push({
      id: "mwg-viewport",
      name: "Responsive & Scalable Viewport",
      description:
        "Declares width=device-width, initial-scale=1 without disabling zoom",
      status: "fail",
      details: err,
    });
  }

  // 2. Color-Scheme Light/Dark Support
  const hasMetaColorScheme =
    /<meta[^>]*\bname=["']color-scheme["'][^>]*\bcontent=["'][^"']*light dark[^"']*["']/i.test(
      html,
    ) ||
    /<meta[^>]*\bcontent=["'][^"']*light dark[^"']*["'][^>]*\bname=["']color-scheme["']/i.test(
      html,
    );
  const hasCssColorScheme =
    /color-scheme\s*:\s*light\s+dark/i.test(allCss) ||
    (/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i.test(allCss) &&
      /@media\s*\(\s*prefers-color-scheme\s*:\s*light\s*\)/i.test(allCss)) ||
    (/data-theme=["']dark["']/i.test(allCss) &&
      /data-theme=["']light["']/i.test(allCss)) ||
    /color-scheme:\s*(light|dark)/i.test(allCss);

  if (hasMetaColorScheme || hasCssColorScheme) {
    checks.push({
      id: "mwg-color-scheme",
      name: "System Color-Scheme (Light/Dark)",
      description: "Explicit color-scheme light dark support in meta or CSS",
      status: "pass",
      metric: "Light & Dark supported",
    });
  } else {
    const err =
      "Missing color-scheme light dark declaration in HTML meta or CSS stylesheet";
    errors.push(err);
    checks.push({
      id: "mwg-color-scheme",
      name: "System Color-Scheme (Light/Dark)",
      description: "Explicit color-scheme light dark support in meta or CSS",
      status: "fail",
      details: err,
    });
  }

  // 3. :focus-visible Keyboard Accessibility
  const hasFocusVisible =
    /:focus-visible/i.test(allCss) || /:focus/i.test(allCss);
  if (hasFocusVisible) {
    checks.push({
      id: "mwg-focus-visible",
      name: "Keyboard Focus Navigation (:focus-visible)",
      description:
        "CSS contains :focus-visible or accessible keyboard focus outlines",
      status: "pass",
      metric: ":focus-visible present",
    });
  } else {
    const err =
      "Missing :focus-visible styling in CSS for accessible keyboard navigation";
    errors.push(err);
    checks.push({
      id: "mwg-focus-visible",
      name: "Keyboard Focus Navigation (:focus-visible)",
      description:
        "CSS contains :focus-visible or accessible keyboard focus outlines",
      status: "fail",
      details: err,
    });
  }

  // 4. prefers-reduced-motion Vestibular Support
  const hasReducedMotion = /@media\s*\(\s*prefers-reduced-motion/i.test(allCss);
  if (hasReducedMotion) {
    checks.push({
      id: "mwg-reduced-motion",
      name: "Vestibular Reduced Motion Support",
      description: "CSS declares @media (prefers-reduced-motion: reduce) query",
      status: "pass",
      metric: "prefers-reduced-motion verified",
    });
  } else {
    const err = "Missing @media (prefers-reduced-motion: reduce) in CSS";
    errors.push(err);
    checks.push({
      id: "mwg-reduced-motion",
      name: "Vestibular Reduced Motion Support",
      description: "CSS declares @media (prefers-reduced-motion: reduce) query",
      status: "fail",
      details: err,
    });
  }

  // 5. Zero Deprecated HTML Tags
  const deprecatedTags = [
    "center",
    "font",
    "marquee",
    "blink",
    "frameset",
    "frame",
    "big",
    "strike",
    "tt",
  ];
  const foundDeprecated: string[] = [];
  for (const tag of deprecatedTags) {
    const r = new RegExp(`<${tag}\\b`, "i");
    if (r.test(html)) {
      foundDeprecated.push(`<${tag}>`);
    }
  }

  if (foundDeprecated.length === 0) {
    checks.push({
      id: "mwg-deprecated-tags",
      name: "HTML5 Semantic Purity",
      description: "Zero obsolete or deprecated HTML tags",
      status: "pass",
      metric: "0 deprecated tags",
    });
  } else {
    const err = `Found deprecated HTML tags: ${foundDeprecated.join(", ")}`;
    errors.push(err);
    checks.push({
      id: "mwg-deprecated-tags",
      name: "HTML5 Semantic Purity",
      description: "Zero obsolete or deprecated HTML tags",
      status: "fail",
      details: err,
    });
  }

  // 6. Zero Inline javascript: Pseudo-Protocols
  const hasJavascriptUrl =
    /href=["']\s*javascript:/i.test(html) ||
    /src=["']\s*javascript:/i.test(html);
  if (!hasJavascriptUrl) {
    checks.push({
      id: "mwg-zero-javascript-url",
      name: "Zero Inline javascript: URLs",
      description: "No inline javascript: pseudo-protocol URLs in href or src",
      status: "pass",
      metric: "Clean URLs",
    });
  } else {
    const err =
      "Found inline javascript: pseudo-protocol URL (security & CSP violation)";
    errors.push(err);
    checks.push({
      id: "mwg-zero-javascript-url",
      name: "Zero Inline javascript: URLs",
      description: "No inline javascript: pseudo-protocol URLs in href or src",
      status: "fail",
      details: err,
    });
  }

  const passedCount = checks.filter((c) => c.status === "pass").length;
  const score = Math.round((passedCount / checks.length) * 100);

  return {
    specId: "mwg",
    title: "Spec 3 — Modern Web Guidelines & WCAG 2.2 AA",
    score,
    passed: score === 100,
    checks,
    errors,
  };
}
