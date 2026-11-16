// Generates skills (~/.claude/skills/<name>/SKILL.md), docs/reference/<pillar>.md,
// and programmatic monorepo MDX/Markdown docs from the SQLite index and live graph.
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  collectMonorepoSnapshot,
  liveScanToStore,
  type MonorepoSnapshot,
} from "./scanner.ts";
import { indexCounts, usersOf } from "./store.ts";
import {
  buildModernWebGuidanceMdx,
  buildPlanMdx,
  buildPureCLlvmMdx,
} from "./templates.ts";

export interface Pillar {
  skill: string;
  title: string;
  /** Import/call substrings that mark a file as a user of the pillar. */
  needles: string[];
  /** Upstream sources; [V] = consulted this session, [NV] = not verified. */
  sources: { url: string; verified: boolean }[];
  localClones: string[];
  summary: string;
}

export const PILLARS: Pillar[] = [
  {
    skill: "tree-sitter",
    title: "tree-sitter in src",
    needles: [
      "tree_sitter",
      "aphrody_core",
      "web-tree-sitter",
      "TreeSitterEngine",
    ],
    sources: [
      { url: "https://tree-sitter.github.io/tree-sitter/", verified: true },
      {
        url: "https://tree-sitter.github.io/tree-sitter/using-parsers/queries/",
        verified: false,
      },
    ],
    localClones: ["third_party/tree-sitter", "third_party/tree-sitter-*"],
    summary:
      "Multi-language parsing, symbol/call/import extraction and S-expression queries via system/core (aphrody-core); C ABI core_parse_json/core_query_json; TS @aphrody/core parse()/query().",
  },
  {
    skill: "llvm-toolchain",
    title: "Shared LLVM toolchain (clang/lld/rustc) in src",
    needles: [
      "cc::Build",
      "inkwell",
      "llvm_sys",
      "clang_sys",
      "bindgen::Builder",
      "core-capi",
      "aphrody_core.h",
    ],
    sources: [
      { url: "https://llvm.org/docs/ (LLVM 23/24)", verified: true },
      {
        url: "https://llvm.org/docs/LinkTimeOptimization.html",
        verified: true,
      },
    ],
    localClones: ["third_party/llvm-project"],
    summary:
      "Native C ABI (system/core/capi, cdylib) built with the shared LLVM toolchain for cross-language LTO.",
  },
  {
    skill: "bun-ffi",
    title: "bun:ffi in src",
    needles: ["bun:ffi"],
    sources: [{ url: "https://bun.com/reference/bun/ffi", verified: true }],
    localClones: ["third_party/bun (docs/runtime/ffi.mdx)"],
    summary:
      "TS <-> native bridge: dlopen + typed symbols, CString + core_free, JSCallback for streaming (system/core-ts/src/ffi.ts).",
  },
  {
    skill: "wck-modern-web",
    title: "Modern Web Guidance (@aphrody/wck) in src",
    needles: ["mwg_capi", "aphrody_mwg", "wck", "mwg_audit"],
    sources: [{ url: "https://web.dev/baseline", verified: true }],
    localClones: ["system/wck"],
    summary:
      "Pure Bun Modern Web Guidance validator, hybrid BM25+Int8 RAG, mwg_capi.dll C23 FFI, and agent MCP integration.",
  },
];

interface Cited {
  path: string;
  tests: string[];
}

function testedUsers(db: Database, p: Pillar): Cited[] {
  const users = new Set(p.needles.flatMap((n) => usersOf(db, n)));
  const testsByFeature = db
    .query(
      `SELECT layer, feature, path FROM files
       WHERE path LIKE '%test%' OR path LIKE '%/tests/%' OR path LIKE '%.test.ts' OR path LIKE '%_test.%'`,
    )
    .all() as { layer: string; feature: string; path: string }[];
  const rustTests = new Set(
    (
      db
        .query(
          `SELECT DISTINCT path FROM symbols WHERE name = 'tests' AND kind = 'module'`,
        )
        .all() as { path: string }[]
    ).map((r) => r.path),
  );
  const out: Cited[] = [];
  for (const path of [...users].sort()) {
    if (path.startsWith("third_party/") || path.startsWith("vendor/")) continue;
    const [layer, feature] = path.split("/");
    const tests = testsByFeature
      .filter((t) => t.layer === layer && t.feature === feature)
      .map((t) => t.path);
    if (rustTests.has(path)) tests.unshift(path);
    if (tests.length)
      out.push({ path, tests: [...new Set(tests)].slice(0, 3) });
  }
  return out;
}

function upstreamCount(db: Database, p: Pillar): number {
  const prefixes = p.localClones.map((c) => c.split(" ")[0]!.replace("*", "%"));
  let n = 0;
  for (const pre of prefixes)
    n += (
      db
        .query("SELECT COUNT(*) AS n FROM files WHERE path LIKE ?")
        .get(`${pre}%`) as { n: number }
    ).n;
  return n;
}

function renderPillar(
  p: Pillar,
  cited: Cited[],
  upstream: number,
  forSkill: boolean,
): string {
  const lines = [
    ...(forSkill
      ? [
          "---",
          `name: ${p.skill}`,
          `description: ${p.title}. ${p.summary} Use before writing or modifying ${p.skill} code in C:\\src.`,
          "---",
          "",
        ]
      : []),
    `# ${p.title}`,
    "",
    p.summary,
    "",
    "Sources:",
    ...p.sources.map((s) => `- ${s.verified ? "[V]" : "[NV]"} ${s.url}`),
    ...p.localClones.map(
      (c) => `- local clone: ${c} (${upstream} indexed files)`,
    ),
    "",
    `Tested code that uses it (${cited.length}, generated by \`bun system/core-ts/src/cli.ts gen-docs\`):`,
    ...cited.map(
      (c) =>
        `- \`${c.path}\` — tests: ${c.tests.map((t) => `\`${t}\``).join(", ")}`,
    ),
    "",
    "Scripts:",
    "- `bun system/core-ts/src/cli.ts index . --all`: reindexes (sqlite var/index/core.db + JSON).",
    `- \`bun system/core-ts/src/cli.ts users ${p.needles[0]}\`: lists the files that import/call it.`,
    "- `bun system/core-ts/src/cli.ts gen-docs`: regenerates the MDX plans and docs/reference/*.md (READMEs: `bun scripts/catalog.ts`).",
    "- `bun test ./system/core-ts/test/`: round-trip bun:ffi <-> core-capi and doc generator tests.",
    "",
  ];
  return lines.join("\n");
}

export interface GenerateResult {
  skill: string;
  cited: number;
  skillPath: string;
  docPath: string;
}

export async function generate(
  db: Database,
  srcRoot: string,
  skillsRoot = join(homedir(), ".claude", "skills"),
) {
  const results: GenerateResult[] = [];
  mkdirSync(join(srcRoot, "docs", "reference"), { recursive: true });
  for (const p of PILLARS) {
    const cited = testedUsers(db, p);
    const up = upstreamCount(db, p);
    const skillDir = join(skillsRoot, p.skill);
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const docPath = join(srcRoot, "docs", "reference", `${p.skill}.md`);
    await Bun.write(skillPath, renderPillar(p, cited, up, true));
    await Bun.write(docPath, renderPillar(p, cited, up, false));
    results.push({ skill: p.skill, cited: cited.length, skillPath, docPath });
  }
  return results;
}

export interface GenDocsOptions {
  rescan?: boolean;
  useFfi?: boolean;
  only?: string[];
}

export interface GenDocsResult {
  written: string[];
  scanMode: "cached" | "ffi" | "fallback";
  snapshot: MonorepoSnapshot;
}

/** Regenerates PLAN.mdx, PURE-C-LLVM.mdx, MODERN-WEB-GUIDANCE.mdx, and docs/reference/*.md. */
export async function generateDocs(
  db: Database,
  srcRoot: string,
  options: GenDocsOptions = {},
): Promise<GenDocsResult> {
  let scanMode: "cached" | "ffi" | "fallback" = "cached";
  if (options.rescan || indexCounts(db).files === 0) {
    const res = liveScanToStore(db, srcRoot, { useFfi: options.useFfi });
    scanMode = res.mode;
  }

  const snapshot = collectMonorepoSnapshot(srcRoot, db);
  const only = options.only ? new Set(options.only) : null;
  const written: string[] = [];

  const targets: { key: string; relPath: string; content: () => string }[] = [
    {
      key: "plan",
      relPath: "docs/PLAN.mdx",
      content: () => buildPlanMdx(snapshot),
    },
    {
      key: "llvm",
      relPath: "docs/native/llvm/PURE-C-LLVM.mdx",
      content: () => buildPureCLlvmMdx(snapshot),
    },
    {
      key: "mwg",
      relPath: "docs/web/MODERN-WEB-GUIDANCE.mdx",
      content: () => buildModernWebGuidanceMdx(snapshot),
    },
  ];

  for (const t of targets) {
    if (only && !only.has(t.key)) continue;
    const abs = join(srcRoot, t.relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    await Bun.write(abs, t.content());
    written.push(t.relPath);
  }

  if (!only || only.has("reference")) {
    mkdirSync(join(srcRoot, "docs", "reference"), { recursive: true });
    for (const p of PILLARS) {
      const cited = testedUsers(db, p);
      const up = upstreamCount(db, p);
      const rel = `docs/reference/${p.skill}.md`;
      await Bun.write(join(srcRoot, rel), renderPillar(p, cited, up, false));
      written.push(rel);
    }
  }

  return { written, scanMode, snapshot };
}
