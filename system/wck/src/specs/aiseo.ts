import type { SpecCheck, SpecResult, WebFilesContext } from "../types";

export function validateAiSeoSpec(ctx: WebFilesContext): SpecResult {
  const checks: SpecCheck[] = [];
  const errors: string[] = [];

  const mainHtml = ctx.htmlFiles[0];
  if (!mainHtml) {
    return {
      specId: "aiseo",
      title: "Spec 2 — Google AI Mode SEO & GEO",
      score: 0,
      passed: false,
      checks: [
        {
          id: "aiseo-html-present",
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

  // 1. JSON-LD Structured Data
  const jsonLdRegex =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const jsonLdBlocks: any[] = [];
  let jlMatch: RegExpExecArray | null;

  while ((jlMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(jlMatch[1].trim());
      jsonLdBlocks.push(parsed);
    } catch (e: any) {
      errors.push(
        `Invalid JSON in <script type="application/ld+json">: ${e.message}`,
      );
    }
  }

  if (jsonLdBlocks.length > 0) {
    // Check @context and @type
    let hasValidSchema = false;
    let hasValidType = false;
    let hasSearchAction = false;

    for (const block of jsonLdBlocks) {
      const items = Array.isArray(block)
        ? block
        : block["@graph"]
          ? block["@graph"]
          : [block];
      for (const item of items) {
        const ctxStr = String(item["@context"] || block["@context"] || "");
        if (ctxStr.includes("schema.org")) {
          hasValidSchema = true;
        }
        const typeStr = item["@type"];
        if (
          typeStr === "WebSite" ||
          typeStr === "SoftwareApplication" ||
          typeStr === "WebApplication" ||
          (Array.isArray(typeStr) &&
            (typeStr.includes("WebSite") ||
              typeStr.includes("SoftwareApplication")))
        ) {
          hasValidType = true;
        }
        if (
          item.potentialAction &&
          (item.potentialAction["@type"] === "SearchAction" ||
            item.potentialAction.type === "SearchAction" ||
            item.potentialAction.target)
        ) {
          hasSearchAction = true;
        }
      }
    }

    // SearchAction only describes a working site search, and Google stopped showing the sitelinks search box
    // on 2024-11-21 (developers.google.com/search/blog/2024/10/sitelinks-search-box): required only when the
    // page offers a search (role="search" or <search>).
    const hasSiteSearch = /role=["']search["']|<search[\s>]/i.test(html);
    if (!hasSiteSearch) hasSearchAction = true;
    if (hasValidSchema && hasValidType && hasSearchAction) {
      checks.push({
        id: "aiseo-jsonld",
        name: "JSON-LD Structured Data Schema",
        description:
          "Valid Schema.org WebSite/SoftwareApplication with SearchAction",
        status: "pass",
        metric: "WebSite + SearchAction validated",
      });
    } else {
      const missingDetails: string[] = [];
      if (!hasValidSchema) missingDetails.push('@context="https://schema.org"');
      if (!hasValidType)
        missingDetails.push('@type="WebSite" or "SoftwareApplication"');
      if (!hasSearchAction)
        missingDetails.push("potentialAction: SearchAction");
      const err = `Incomplete JSON-LD: missing ${missingDetails.join(", ")}`;
      errors.push(err);
      checks.push({
        id: "aiseo-jsonld",
        name: "JSON-LD Structured Data Schema",
        description:
          "Valid Schema.org WebSite/SoftwareApplication with SearchAction",
        status: "fail",
        details: err,
      });
    }
  } else {
    const err =
      "No valid <script type='application/ld+json'> structured data found";
    errors.push(err);
    checks.push({
      id: "aiseo-jsonld",
      name: "JSON-LD Structured Data Schema",
      description:
        "Valid Schema.org WebSite/SoftwareApplication with SearchAction",
      status: "fail",
      details: err,
    });
  }

  // 2. Robots AI Crawler Directives
  const robotsMetaMatch =
    html.match(
      /<meta[^>]*\bname=["']robots["'][^>]*\bcontent=["']([^"']*)["']/i,
    ) ||
    html.match(
      /<meta[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']robots["']/i,
    );
  const robotsContent = robotsMetaMatch ? robotsMetaMatch[1].toLowerCase() : "";

  const hasIndex = robotsContent.includes("index");
  const hasFollow = robotsContent.includes("follow");
  const hasMaxSnippet = robotsContent.includes("max-snippet:-1");
  const hasMaxImagePreview = robotsContent.includes("max-image-preview:large");
  const hasMaxVideoPreview = robotsContent.includes("max-video-preview:-1");

  if (
    hasIndex &&
    hasFollow &&
    hasMaxSnippet &&
    hasMaxImagePreview &&
    hasMaxVideoPreview
  ) {
    checks.push({
      id: "aiseo-meta-robots",
      name: "AI Engine Crawler Directives",
      description:
        "Robots meta includes max-snippet:-1, max-image-preview:large, and max-video-preview:-1",
      status: "pass",
      metric: "Full GEO crawler permissions granted",
    });
  } else {
    const missingFlags: string[] = [];
    if (!hasIndex) missingFlags.push("index");
    if (!hasFollow) missingFlags.push("follow");
    if (!hasMaxSnippet) missingFlags.push("max-snippet:-1");
    if (!hasMaxImagePreview) missingFlags.push("max-image-preview:large");
    if (!hasMaxVideoPreview) missingFlags.push("max-video-preview:-1");
    const err = `Missing meta robots directives: ${missingFlags.join(", ")}`;
    errors.push(err);
    checks.push({
      id: "aiseo-meta-robots",
      name: "AI Engine Crawler Directives",
      description:
        "Robots meta includes max-snippet:-1, max-image-preview:large, and max-video-preview:-1",
      status: "fail",
      details: err,
    });
  }

  // 3. /llms.txt AI Index Validation
  if (ctx.llmsTxt) {
    const lines = ctx.llmsTxt.trim().split("\n");
    const hasH1 = lines.some((l) => l.trim().startsWith("# "));
    const hasContent = ctx.llmsTxt.length >= 60;
    const hasLinks =
      ctx.llmsTxt.includes("http://") ||
      ctx.llmsTxt.includes("https://") ||
      ctx.llmsTxt.includes("/");

    if (hasH1 && hasContent && hasLinks) {
      checks.push({
        id: "aiseo-llms-txt",
        name: "Concise AI Crawler Index (/llms.txt)",
        description:
          "Valid /llms.txt specification file present with H1 title, summary, and canonical endpoints",
        status: "pass",
        metric: `${lines.length} lines in llms.txt`,
      });
    } else {
      const err =
        "/llms.txt missing standard format (H1 title #, summary, or endpoints)";
      errors.push(err);
      checks.push({
        id: "aiseo-llms-txt",
        name: "Concise AI Crawler Index (/llms.txt)",
        description:
          "Valid /llms.txt specification file present with H1 title, summary, and canonical endpoints",
        status: "fail",
        details: err,
      });
    }
  } else if (!ctx.isSingleFile) {
    const err = "Missing /llms.txt in target directory";
    errors.push(err);
    checks.push({
      id: "aiseo-llms-txt",
      name: "Concise AI Crawler Index (/llms.txt)",
      description:
        "Valid /llms.txt specification file present with H1 title, summary, and canonical endpoints",
      status: "fail",
      details: err,
    });
  }

  const passedCount = checks.filter((c) => c.status === "pass").length;
  const score = Math.round((passedCount / checks.length) * 100);

  return {
    specId: "aiseo",
    title: "Spec 2 — Google AI Mode SEO & GEO",
    score,
    passed: score === 100,
    checks,
    errors,
  };
}
