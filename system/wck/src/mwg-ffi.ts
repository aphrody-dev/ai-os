import { CString, FFIType, dlopen, ptr, suffix, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MWG_ABI_VERSION = 1;
export const MWG_LIB_FILE = `${process.platform === "win32" ? "" : "lib"}mwg_capi.${suffix}`;

const symbols = {
  mwg_abi_version: { args: [], returns: FFIType.u32 },
  mwg_free: { args: [FFIType.ptr], returns: FFIType.void },
  mwg_audit_html_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  mwg_audit_css_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  mwg_audit_js_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  mwg_parse_mdx_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  mwg_search_guidance_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.ptr,
  },
  mwg_feature_lookup_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  mwg_hash64: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
} as const;

type MwgLib = ReturnType<typeof dlopen<typeof symbols>>;

const cstr = (s: string) => ptr(Buffer.from(`${s}\0`, "utf8"));

export function mwgLibCandidates(): string[] {
  const pkgRoot = join(import.meta.dir, "..");
  return [
    process.env.APHRODY_MWG_LIB,
    join(pkgRoot, "native", MWG_LIB_FILE),
    join(homedir(), ".local", "bin", MWG_LIB_FILE),
  ].filter((p): p is string => Boolean(p));
}

let cached: { lib: MwgLib; path: string } | null | undefined;

export function loadMwgCore(): { lib: MwgLib; path: string } | null {
  if (cached !== undefined) return cached;
  for (const p of mwgLibCandidates()) {
    if (!existsSync(p)) continue;
    try {
      const lib = dlopen(p, symbols);
      if (lib.symbols.mwg_abi_version() !== MWG_ABI_VERSION) {
        lib.close();
        continue;
      }
      cached = { lib, path: p };
      return cached;
    } catch {
      // try next candidate
    }
  }
  cached = null;
  return null;
}

function takeJson<T>(lib: MwgLib, p: Pointer | bigint | null): T {
  if (!p) throw new Error("mwg_capi returned null pointer");
  const ptrVal = p as Pointer;
  try {
    return JSON.parse(new CString(ptrVal).toString()) as T;
  } finally {
    lib.symbols.mwg_free(ptrVal);
  }
}

export interface MwgHtmlAudit {
  engine: string;
  score: number;
  hasDoctype: boolean;
  hasLang: boolean;
  hasViewport: boolean;
  userScalableNo: boolean;
  hasColorScheme: boolean;
  hasTitle: boolean;
  hasMainLandmark: boolean;
  hasDeprecatedTags: boolean;
  imgCount: number;
  imgMissingAlt: number;
  imgMissingDimensions: number;
}

export interface MwgCssAudit {
  engine: string;
  score: number;
  hasFocusVisible: boolean;
  hasReducedMotion: boolean;
  hasColorScheme: boolean;
  hasModernSizing: boolean;
  hasAnchorPositioning: boolean;
  outlineNoneWithoutFocusVisible: boolean;
  layoutThrashingKeyframes: boolean;
}

export interface MwgJsAudit {
  engine: string;
  score: number;
  usesEval: boolean;
  usesDocumentWrite: boolean;
  usesInnerHtml: boolean;
  usesVar: boolean;
  usesSyncXhr: boolean;
}

export interface MwgMdxParsed {
  frontmatter: Record<string, string>;
  headings: Array<{ level: number; text: string }>;
  wordCount: number;
  codeBlocks: number;
  bodyOffset: number;
}

export interface MwgFeatureLookup {
  found: boolean;
  id: string;
  baseline: string;
  category?: string;
  guidance?: string;
}

export function mwgCapabilities(): {
  native: boolean;
  abi: number;
  engine: string;
  path?: string;
} {
  const loaded = loadMwgCore();
  if (!loaded) {
    return { native: false, abi: MWG_ABI_VERSION, engine: "bun-fallback" };
  }
  return {
    native: true,
    abi: loaded.lib.symbols.mwg_abi_version(),
    engine: "mwg-c23",
    path: loaded.path,
  };
}

export function mwgAuditHtml(html: string): MwgHtmlAudit {
  const loaded = loadMwgCore();
  if (loaded) {
    return takeJson<MwgHtmlAudit>(
      loaded.lib,
      loaded.lib.symbols.mwg_audit_html_json(cstr(html)),
    );
  }
  const lower = html.toLowerCase();
  const hasDoctype = lower.includes("<!doctype html");
  const hasLang = lower.includes("<html") && lower.includes("lang=");
  const hasViewport =
    lower.includes('name="viewport"') || lower.includes("name='viewport'");
  const userScalableNo =
    lower.includes("user-scalable=no") || lower.includes("user-scalable=0");
  const hasColorScheme = lower.includes("color-scheme");
  const hasTitle = lower.includes("<title>") && lower.includes("</title>");
  const hasMainLandmark = lower.includes("<main");
  const hasDeprecatedTags =
    lower.includes("<marquee") ||
    lower.includes("<blink") ||
    lower.includes("<center") ||
    lower.includes("<font");
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  let imgMissingAlt = 0;
  let imgMissingDimensions = 0;
  for (const tag of imgs) {
    if (!/\balt\s*=/i.test(tag)) imgMissingAlt++;
    if (!/\bwidth\s*=/i.test(tag) || !/\bheight\s*=/i.test(tag))
      imgMissingDimensions++;
  }
  let score = 100;
  if (!hasDoctype) score -= 15;
  if (!hasLang) score -= 10;
  if (!hasViewport) score -= 15;
  if (userScalableNo) score -= 20;
  if (!hasTitle) score -= 15;
  if (!hasMainLandmark) score -= 10;
  if (hasDeprecatedTags) score -= 15;
  if (imgMissingAlt > 0) score -= 10;
  if (imgMissingDimensions > 0) score -= 10;
  return {
    engine: "bun-fallback",
    score: Math.max(0, score),
    hasDoctype,
    hasLang,
    hasViewport,
    userScalableNo,
    hasColorScheme,
    hasTitle,
    hasMainLandmark,
    hasDeprecatedTags,
    imgCount: imgs.length,
    imgMissingAlt,
    imgMissingDimensions,
  };
}

export function mwgAuditCss(css: string): MwgCssAudit {
  const loaded = loadMwgCore();
  if (loaded) {
    return takeJson<MwgCssAudit>(
      loaded.lib,
      loaded.lib.symbols.mwg_audit_css_json(cstr(css)),
    );
  }
  const lower = css.toLowerCase();
  const hasFocusVisible = lower.includes(":focus-visible");
  const hasReducedMotion = lower.includes("prefers-reduced-motion");
  const hasColorScheme =
    lower.includes("color-scheme") || lower.includes("light-dark(");
  const hasModernSizing =
    lower.includes("interpolate-size") ||
    lower.includes("calc-size(") ||
    lower.includes("field-sizing");
  const hasAnchorPositioning =
    lower.includes("anchor-name") || lower.includes("position-anchor");
  const hasOutlineNone = /outline\s*:\s*(none|0)\b/i.test(css);
  const outlineNoneWithoutFocusVisible = hasOutlineNone && !hasFocusVisible;
  const kfIdx = lower.indexOf("@keyframes");
  const layoutThrashingKeyframes =
    kfIdx !== -1 && /\b(top|left|width|height)\s*:/i.test(lower.slice(kfIdx));
  let score = 100;
  if (!hasFocusVisible) score -= 15;
  if (!hasReducedMotion) score -= 15;
  if (outlineNoneWithoutFocusVisible) score -= 20;
  if (layoutThrashingKeyframes) score -= 25;
  return {
    engine: "bun-fallback",
    score: Math.max(0, score),
    hasFocusVisible,
    hasReducedMotion,
    hasColorScheme,
    hasModernSizing,
    hasAnchorPositioning,
    outlineNoneWithoutFocusVisible,
    layoutThrashingKeyframes,
  };
}

export function mwgAuditJs(js: string): MwgJsAudit {
  const loaded = loadMwgCore();
  if (loaded) {
    return takeJson<MwgJsAudit>(
      loaded.lib,
      loaded.lib.symbols.mwg_audit_js_json(cstr(js)),
    );
  }
  const usesEval = /\beval\s*\(|new\s+Function\s*\(/i.test(js);
  const usesDocumentWrite = /document\.write\s*\(/i.test(js);
  const usesInnerHtml = /\.innerHTML\b/.test(js);
  const usesVar = /\bvar\s+/.test(js);
  const usesSyncXhr = /XMLHttpRequest/.test(js) && /,\s*false\s*\)/.test(js);
  let score = 100;
  if (usesEval) score -= 35;
  if (usesDocumentWrite) score -= 25;
  if (usesInnerHtml) score -= 15;
  if (usesVar) score -= 5;
  if (usesSyncXhr) score -= 20;
  return {
    engine: "bun-fallback",
    score: Math.max(0, score),
    usesEval,
    usesDocumentWrite,
    usesInnerHtml,
    usesVar,
    usesSyncXhr,
  };
}

export function mwgParseMdx(mdx: string): MwgMdxParsed {
  const loaded = loadMwgCore();
  if (loaded) {
    return takeJson<MwgMdxParsed>(
      loaded.lib,
      loaded.lib.symbols.mwg_parse_mdx_json(cstr(mdx)),
    );
  }
  const frontmatter: Record<string, string> = {};
  let body = mdx;
  let bodyOffset = 0;
  if (mdx.startsWith("---\n") || mdx.startsWith("---\r\n")) {
    const end = mdx.indexOf("\n---", 3);
    if (end !== -1) {
      const yaml = mdx.slice(4, end);
      try {
        const parsed = Bun.YAML.parse(yaml);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (v !== undefined && v !== null) frontmatter[k] = String(v);
          }
        }
      } catch {}
      bodyOffset = end + 4;
      while (mdx[bodyOffset] === "\r" || mdx[bodyOffset] === "\n") bodyOffset++;
      body = mdx.slice(bodyOffset);
    }
  }
  const headings: Array<{ level: number; text: string }> = [];
  let inCode = false;
  let codeBlocks = 0;
  let wordCount = 0;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      if (!inCode) codeBlocks++;
      inCode = !inCode;
      continue;
    }
    if (!inCode) {
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) headings.push({ level: m[1].length, text: m[2].trim() });
      const words = line.trim().split(/\s+/).filter(Boolean);
      wordCount += words.length;
    }
  }
  return { frontmatter, headings, wordCount, codeBlocks, bodyOffset };
}

export function mwgSearchGuidanceNative(
  query: string,
  corpus: Array<{ id: string; title?: string; text: string }>,
  topK = 10,
): Array<{ id: string; score: number }> {
  const loaded = loadMwgCore();
  if (loaded) {
    return takeJson<Array<{ id: string; score: number }>>(
      loaded.lib,
      loaded.lib.symbols.mwg_search_guidance_json(
        cstr(query),
        cstr(JSON.stringify(corpus)),
        topK,
      ),
    );
  }
  const qtoks = query
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length >= 2);
  const scored: Array<{ id: string; score: number }> = [];
  for (const doc of corpus) {
    const hay = `${doc.id} ${doc.title ?? ""} ${doc.text}`.toLowerCase();
    let score = 0;
    for (const tok of qtoks) {
      if (hay.includes(tok)) score += 1;
    }
    if (score > 0) scored.push({ id: doc.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function mwgFeatureLookup(featureId: string): MwgFeatureLookup {
  const loaded = loadMwgCore();
  if (loaded) {
    return takeJson<MwgFeatureLookup>(
      loaded.lib,
      loaded.lib.symbols.mwg_feature_lookup_json(cstr(featureId)),
    );
  }
  return { found: false, id: featureId, baseline: "unknown" };
}

export function mwgHash64(input: string | Uint8Array): bigint {
  const buf =
    typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const loaded = loadMwgCore();
  if (loaded) {
    return BigInt(
      loaded.lib.symbols.mwg_hash64(buf.length ? ptr(buf) : null, buf.length),
    );
  }
  let h = 14695981039346656037n;
  for (const b of buf) {
    h ^= BigInt(b);
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  return h;
}
