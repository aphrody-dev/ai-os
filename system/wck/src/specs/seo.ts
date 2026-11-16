import type { SpecCheck, SpecResult, WebFilesContext } from "../types";

export function validateSeoSpec(ctx: WebFilesContext): SpecResult {
  const checks: SpecCheck[] = [];
  const errors: string[] = [];

  const mainHtml = ctx.htmlFiles[0];
  if (!mainHtml) {
    return {
      specId: "seo",
      title: "Spec 1 — Google Search SEO",
      score: 0,
      passed: false,
      checks: [
        {
          id: "seo-html-present",
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

  // 1. <html lang="...">
  const langMatch = html.match(/<html[^>]*\blang=["']([a-zA-Z0-9\-_]+)["']/i);
  if (langMatch && langMatch[1].trim().length >= 2) {
    checks.push({
      id: "seo-lang",
      name: "HTML Lang Attribute",
      description: "Root <html> element declares an ISO language code",
      status: "pass",
      metric: `lang="${langMatch[1]}"`,
    });
  } else {
    const err = "Missing or invalid <html lang='...'> attribute";
    errors.push(err);
    checks.push({
      id: "seo-lang",
      name: "HTML Lang Attribute",
      description: "Root <html> element declares an ISO language code",
      status: "fail",
      details: err,
    });
  }

  // 2. <meta charset="utf-8">
  const charsetMatch =
    html.match(/<meta[^>]*\bcharset=["']?utf-8["']?/i) ||
    html.match(/<meta[^>]*\bcontent=["'][^"']*charset=utf-8["']/i);
  if (charsetMatch) {
    checks.push({
      id: "seo-charset",
      name: "UTF-8 Charset Declaration",
      description: "<meta charset='utf-8'> is declared in <head>",
      status: "pass",
      metric: "charset=utf-8",
    });
  } else {
    const err = "Missing <meta charset='utf-8'> in <head>";
    errors.push(err);
    checks.push({
      id: "seo-charset",
      name: "UTF-8 Charset Declaration",
      description: "<meta charset='utf-8'> is declared in <head>",
      status: "fail",
      details: err,
    });
  }

  // 3. <title> (10..60 chars)
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1].trim() : "";
  if (titleText.length >= 10 && titleText.length <= 60) {
    checks.push({
      id: "seo-title",
      name: "Page Title Optimization",
      description:
        "<title> tag is present with optimal length between 10 and 60 chars",
      status: "pass",
      metric: `${titleText.length} chars ("${titleText}")`,
    });
  } else {
    const err = `<title> tag length (${titleText.length} chars) is outside optimal range 10..60 characters`;
    errors.push(err);
    checks.push({
      id: "seo-title",
      name: "Page Title Optimization",
      description:
        "<title> tag is present with optimal length between 10 and 60 chars",
      status: "fail",
      details: err,
      metric: `${titleText.length} chars`,
    });
  }

  // 4. <meta name="description" content="..."> (50..160 chars)
  const descMatch =
    html.match(
      /<meta[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["']/i,
    ) ||
    html.match(
      /<meta[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']description["']/i,
    );
  const descText = descMatch ? descMatch[1].trim() : "";
  if (descText.length >= 50 && descText.length <= 160) {
    checks.push({
      id: "seo-description",
      name: "Meta Description Optimization",
      description: "<meta name='description'> is between 50 and 160 characters",
      status: "pass",
      metric: `${descText.length} chars`,
    });
  } else {
    const err = `<meta name='description'> length (${descText.length} chars) is outside optimal range 50..160 characters`;
    errors.push(err);
    checks.push({
      id: "seo-description",
      name: "Meta Description Optimization",
      description: "<meta name='description'> is between 50 and 160 characters",
      status: "fail",
      details: err,
      metric: `${descText.length} chars`,
    });
  }

  // 5. <link rel="canonical" href="https://...">
  const canonMatch =
    html.match(
      /<link[^>]*\brel=["']canonical["'][^>]*\bhref=["'](https:\/\/[^"']+)["']/i,
    ) ||
    html.match(
      /<link[^>]*\bhref=["'](https:\/\/[^"']+)["'][^>]*\brel=["']canonical["']/i,
    );
  if (canonMatch) {
    checks.push({
      id: "seo-canonical",
      name: "HTTPS Canonical Link",
      description: "Valid canonical link tag with HTTPS protocol",
      status: "pass",
      metric: canonMatch[1],
    });
  } else {
    const err =
      "Missing or non-HTTPS <link rel='canonical' href='https://...'>";
    errors.push(err);
    checks.push({
      id: "seo-canonical",
      name: "HTTPS Canonical Link",
      description: "Valid canonical link tag with HTTPS protocol",
      status: "fail",
      details: err,
    });
  }

  // 6. OpenGraph meta tags
  const ogTitle =
    html.match(
      /<meta[^>]*\bproperty=["']og:title["'][^>]*\bcontent=["']([^"']+)["']/i,
    ) ||
    html.match(
      /<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:title["']/i,
    );
  const ogDesc =
    html.match(
      /<meta[^>]*\bproperty=["']og:description["'][^>]*\bcontent=["']([^"']+)["']/i,
    ) ||
    html.match(
      /<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:description["']/i,
    );
  const ogUrl =
    html.match(
      /<meta[^>]*\bproperty=["']og:url["'][^>]*\bcontent=["'](https:\/\/[^"']+)["']/i,
    ) ||
    html.match(
      /<meta[^>]*\bcontent=["'](https:\/\/[^"']+)["'][^>]*\bproperty=["']og:url["']/i,
    );
  const ogType =
    html.match(
      /<meta[^>]*\bproperty=["']og:type["'][^>]*\bcontent=["']([^"']+)["']/i,
    ) ||
    html.match(
      /<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:type["']/i,
    );

  if (ogTitle && ogDesc && ogUrl && ogType) {
    checks.push({
      id: "seo-opengraph",
      name: "OpenGraph Metadata",
      description:
        "Complete og:title, og:description, og:url, and og:type tags",
      status: "pass",
      metric: "og:title, og:desc, og:url, og:type verified",
    });
  } else {
    const missing: string[] = [];
    if (!ogTitle) missing.push("og:title");
    if (!ogDesc) missing.push("og:description");
    if (!ogUrl) missing.push("og:url");
    if (!ogType) missing.push("og:type");
    const err = `Missing OpenGraph tags: ${missing.join(", ")}`;
    errors.push(err);
    checks.push({
      id: "seo-opengraph",
      name: "OpenGraph Metadata",
      description:
        "Complete og:title, og:description, og:url, and og:type tags",
      status: "fail",
      details: err,
    });
  }

  // 7. Semantic Landmarks
  const hasHeader =
    /<header\b/i.test(html) || /role=["']banner["']/i.test(html);
  const hasMain = /<main\b/i.test(html) || /role=["']main["']/i.test(html);
  const hasFooter =
    /<footer\b/i.test(html) || /role=["']contentinfo["']/i.test(html);

  if (hasHeader && hasMain && hasFooter) {
    checks.push({
      id: "seo-landmarks",
      name: "HTML5 Semantic Landmarks",
      description:
        "Document contains header/banner, main, and footer/contentinfo",
      status: "pass",
      metric: "header, main, footer present",
    });
  } else {
    const missingLandmarks: string[] = [];
    if (!hasHeader) missingLandmarks.push("<header>/banner");
    if (!hasMain) missingLandmarks.push("<main>");
    if (!hasFooter) missingLandmarks.push("<footer>/contentinfo");
    const err = `Missing semantic landmarks: ${missingLandmarks.join(", ")}`;
    errors.push(err);
    checks.push({
      id: "seo-landmarks",
      name: "HTML5 Semantic Landmarks",
      description:
        "Document contains header/banner, main, and footer/contentinfo",
      status: "fail",
      details: err,
    });
  }

  // 8. Accessible Names on Interactive Elements
  let unlabelledButtons = 0;
  const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let bMatch: RegExpExecArray | null;
  while ((bMatch = buttonRegex.exec(html)) !== null) {
    const attrs = bMatch[1];
    const inner = bMatch[2].replace(/<[^>]+>/g, "").trim();
    const hasAria =
      /aria-label=["'][^"']+["']/i.test(attrs) ||
      /aria-labelledby=["'][^"']+["']/i.test(attrs) ||
      /title=["'][^"']+["']/i.test(attrs);
    if (!inner && !hasAria) {
      unlabelledButtons++;
    }
  }

  let unlabelledInputs = 0;
  const inputRegex = /<input\b([^>]*)>/gi;
  let iMatch: RegExpExecArray | null;
  while ((iMatch = inputRegex.exec(html)) !== null) {
    const attrs = iMatch[1];
    if (
      /type=["']hidden["']/i.test(attrs) ||
      /type=["']submit["']/i.test(attrs)
    ) {
      continue;
    }
    const hasLabel =
      /aria-label=["'][^"']+["']/i.test(attrs) ||
      /aria-labelledby=["'][^"']+["']/i.test(attrs) ||
      /placeholder=["'][^"']+["']/i.test(attrs) ||
      /title=["'][^"']+["']/i.test(attrs) ||
      /id=["'][^"']+["']/i.test(attrs);
    if (!hasLabel) {
      unlabelledInputs++;
    }
  }

  let unlabelledSvgs = 0;
  const svgImgRegex = /<svg\b[^>]*role=["']img["'][^>]*>([\s\S]*?)<\/svg>/gi;
  let sMatch: RegExpExecArray | null;
  while ((sMatch = svgImgRegex.exec(html)) !== null) {
    const full = sMatch[0];
    const hasTitle =
      /<title\b/i.test(full) ||
      /aria-label=["'][^"']+["']/i.test(full) ||
      /aria-labelledby=["'][^"']+["']/i.test(full);
    if (!hasTitle) {
      unlabelledSvgs++;
    }
  }

  if (
    unlabelledButtons === 0 &&
    unlabelledInputs === 0 &&
    unlabelledSvgs === 0
  ) {
    checks.push({
      id: "seo-accessible-names",
      name: "Accessible Interactive Names",
      description:
        "All buttons, inputs, links, and role='img' SVGs have accessible labels",
      status: "pass",
      metric: "100% accessible names",
    });
  } else {
    const err = `Unlabelled elements: ${unlabelledButtons} buttons, ${unlabelledInputs} inputs, ${unlabelledSvgs} role='img' SVGs`;
    errors.push(err);
    checks.push({
      id: "seo-accessible-names",
      name: "Accessible Interactive Names",
      description:
        "All buttons, inputs, links, and role='img' SVGs have accessible labels",
      status: "fail",
      details: err,
    });
  }

  // 9. robots.txt validation
  if (ctx.robotsTxt) {
    const hasUserAgent = /User-agent:\s*\*/i.test(ctx.robotsTxt);
    const hasAllow = /Allow:\s*\//i.test(ctx.robotsTxt);
    const hasSitemap = /Sitemap:\s*https:\/\//i.test(ctx.robotsTxt);
    if (
      hasUserAgent &&
      (hasAllow || /Disallow:/i.test(ctx.robotsTxt)) &&
      hasSitemap
    ) {
      checks.push({
        id: "seo-robots-txt",
        name: "robots.txt Configuration",
        description:
          "Valid robots.txt with User-agent, Allow/Disallow, and HTTPS Sitemap directive",
        status: "pass",
        metric: "robots.txt valid",
      });
    } else {
      const err =
        "robots.txt is missing User-agent, Allow/Disallow, or Sitemap: https:// directive";
      errors.push(err);
      checks.push({
        id: "seo-robots-txt",
        name: "robots.txt Configuration",
        description:
          "Valid robots.txt with User-agent, Allow/Disallow, and HTTPS Sitemap directive",
        status: "fail",
        details: err,
      });
    }
  } else if (!ctx.isSingleFile) {
    const err = "Missing robots.txt in target directory";
    errors.push(err);
    checks.push({
      id: "seo-robots-txt",
      name: "robots.txt Configuration",
      description:
        "Valid robots.txt with User-agent, Allow/Disallow, and HTTPS Sitemap directive",
      status: "fail",
      details: err,
    });
  }

  // 10. sitemap.xml validation (supports both <urlset> and <sitemapindex> per sitemaps.org 0.9)
  if (ctx.sitemapXml) {
    const hasXmlSchema = ctx.sitemapXml.includes(
      "http://www.sitemaps.org/schemas/sitemap/0.9",
    );
    const hasValidRoot =
      /<urlset\b/i.test(ctx.sitemapXml) ||
      /<sitemapindex\b/i.test(ctx.sitemapXml);
    const hasLoc = /<loc>https:\/\/[^<]+<\/loc>/i.test(ctx.sitemapXml);
    if (hasXmlSchema && hasValidRoot && hasLoc) {
      checks.push({
        id: "seo-sitemap-xml",
        name: "sitemap.xml Schema Validation",
        description:
          "Valid sitemap.xml following sitemaps.org 0.9 schema with HTTPS <loc>",
        status: "pass",
        metric: /<sitemapindex\b/i.test(ctx.sitemapXml)
          ? "sitemapindex valid"
          : "urlset valid",
      });
    } else {
      const err =
        "sitemap.xml is missing standard XML schema, <urlset>/<sitemapindex>, or HTTPS <loc> entries";
      errors.push(err);
      checks.push({
        id: "seo-sitemap-xml",
        name: "sitemap.xml Schema Validation",
        description:
          "Valid sitemap.xml following sitemaps.org 0.9 schema with HTTPS <loc>",
        status: "fail",
        details: err,
      });
    }
  } else if (!ctx.isSingleFile) {
    const err = "Missing sitemap.xml in target directory";
    errors.push(err);
    checks.push({
      id: "seo-sitemap-xml",
      name: "sitemap.xml Schema Validation",
      description:
        "Valid sitemap.xml following sitemaps.org 0.9 schema with HTTPS <loc>",
      status: "fail",
      details: err,
    });
  }

  const passedCount = checks.filter((c) => c.status === "pass").length;
  const score = Math.round((passedCount / checks.length) * 100);

  return {
    specId: "seo",
    title: "Spec 1 — Google Search SEO",
    score,
    passed: score === 100,
    checks,
    errors,
  };
}
