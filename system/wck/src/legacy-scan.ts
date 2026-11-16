import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { mwgAuditCss, mwgAuditHtml, mwgAuditJs } from "./mwg-ffi";

export interface LegacyFinding {
  file: string;
  line: number;
  ruleId: string;
  guideId: string;
  message: string;
  lineContent: string;
}

export interface LegacyScanReport {
  targetDir: string;
  scannedFiles: number;
  totalFindings: number;
  findings: LegacyFinding[];
  guides: Array<{ guideId: string; count: number; retrieveCommand: string }>;
}

interface LegacyPatternRule {
  ruleId: string;
  guideId: string;
  extensions: string[];
  pattern: RegExp;
  message: string;
}

const LEGACY_RULES: LegacyPatternRule[] = [
  {
    ruleId: "legacy-webkit-scrollbar",
    guideId: "scrollbar-color",
    extensions: [".css", ".scss", ".html"],
    pattern: /::-webkit-scrollbar\b/,
    message:
      "Replace ::-webkit-scrollbar vendor pseudo-elements with standard scrollbar-color and scrollbar-width.",
  },
  {
    ruleId: "legacy-max-height-accordion",
    guideId: "animate-to-intrinsic-sizes",
    extensions: [".css", ".scss"],
    pattern: /transition\s*:[^;]*max-height/,
    message:
      "Replace max-height transition hacks with interpolate-size: allow-keywords and block-size: auto.",
  },
  {
    ruleId: "legacy-outline-none",
    guideId: "accessibility",
    extensions: [".css", ".scss"],
    pattern: /outline\s*:\s*(none|0)\b/,
    message:
      "Avoid removing focus outlines without :focus-visible replacement.",
  },
  {
    ruleId: "legacy-user-scalable-no",
    guideId: "respect-os-text-scale",
    extensions: [".html", ".htm", ".tsx", ".jsx"],
    pattern: /user-scalable\s*=\s*(no|0)/i,
    message:
      "Do not disable pinch-to-zoom with user-scalable=no in viewport meta.",
  },
  {
    ruleId: "legacy-innerhtml-sink",
    guideId: "sanitize-untrusted-html",
    extensions: [".js", ".ts", ".jsx", ".tsx", ".mjs"],
    pattern: /\.innerHTML\s*=/,
    message:
      "Avoid raw .innerHTML assignments; use setHTML() or safe DOM text/node APIs.",
  },
  {
    ruleId: "legacy-eval",
    guideId: "security",
    extensions: [".js", ".ts", ".jsx", ".tsx", ".mjs"],
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    message:
      "Avoid eval() and new Function() which violate strict CSP and hurt performance.",
  },
  {
    ruleId: "legacy-document-write",
    guideId: "improve-next-page-load-performance",
    extensions: [".js", ".ts", ".html"],
    pattern: /document\.write\s*\(/,
    message: "Avoid parser-blocking document.write() calls.",
  },
  {
    ruleId: "legacy-keyframes-layout-thrash",
    guideId: "css-layout",
    extensions: [".css", ".scss"],
    pattern: /@keyframes[\s\S]{0,200}?\b(top|left|width|height)\s*:/,
    message:
      "Avoid animating layout properties (top/left/width/height) in @keyframes; prefer transform/opacity.",
  },
];

const DEFAULT_EXTS = new Set([
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".svelte",
  ".vue",
]);

function isDocsOrTest(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__") ||
    lower.startsWith("docs/") ||
    lower.includes("/docs/")
  );
}

export function scanLegacyPatterns(
  targetPath: string,
  options?: {
    guide?: string;
    includeDocsAndTests?: boolean;
    maxFiles?: number;
  },
): LegacyScanReport {
  const abs = resolve(targetPath);
  if (!existsSync(abs)) {
    throw new Error(`Path not found: ${abs}`);
  }

  const files: string[] = [];
  const st = statSync(abs);
  if (st.isFile()) {
    files.push(abs);
  } else {
    const glob = new Bun.Glob("**/*");
    for (const rel of glob.scanSync({ cwd: abs, onlyFiles: true })) {
      if (
        rel.includes("node_modules") ||
        rel.includes(".git/") ||
        rel.includes("dist/")
      ) {
        continue;
      }
      if (!DEFAULT_EXTS.has(extname(rel).toLowerCase())) continue;
      if (!options?.includeDocsAndTests && isDocsOrTest(rel)) continue;
      files.push(join(abs, rel));
      if (options?.maxFiles && files.length >= options.maxFiles) break;
    }
  }

  const findings: LegacyFinding[] = [];
  const baseDir = st.isFile() ? resolve(abs, "..") : abs;

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const rel = relative(baseDir, file).replace(/\\/g, "/");
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // Native C23 pre-filter for fast whole-file gating when available
    if (ext === ".html" || ext === ".htm") {
      mwgAuditHtml(content);
    } else if (ext === ".css" || ext === ".scss") {
      mwgAuditCss(content);
    } else if (ext === ".js" || ext === ".ts" || ext === ".mjs") {
      mwgAuditJs(content);
    }

    const lines = content.split(/\r?\n/);
    for (const rule of LEGACY_RULES) {
      if (options?.guide && rule.guideId !== options.guide) continue;
      if (!rule.extensions.includes(ext)) continue;
      for (let i = 0; i < lines.length; i++) {
        if (rule.pattern.test(lines[i])) {
          findings.push({
            file: rel,
            line: i + 1,
            ruleId: rule.ruleId,
            guideId: rule.guideId,
            message: rule.message,
            lineContent: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
  }

  const guideCounts = new Map<string, number>();
  for (const f of findings) {
    guideCounts.set(f.guideId, (guideCounts.get(f.guideId) ?? 0) + 1);
  }
  const guides = [...guideCounts.entries()]
    .map(([guideId, count]) => ({
      guideId,
      count,
      retrieveCommand: `wck retrieve ${guideId}`,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    targetDir: abs,
    scannedFiles: files.length,
    totalFindings: findings.length,
    findings,
    guides,
  };
}
