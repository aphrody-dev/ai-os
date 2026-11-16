// Live codebase scanner and monorepo metadata collector for programmatic doc generation.
// Uses Tree-sitter FFI (aphrody_core_capi) when available and falls back to a pure-Bun
// Bun.Glob + lightweight AST/symbol/import/call extractor when the native library is absent.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  contentHash,
  indexEach,
  loadCore,
  type AstFileSummary,
  type IndexedFile,
  type Span,
} from "./ffi.ts";
import {
  classification,
  indexCounts,
  writeFiles,
  type Classification,
  type IndexCounts,
} from "./store.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "third_party",
  "vendor",
  ".git",
  "dist",
  ".zig-cache",
  "zig-out",
  "graphify-out",
]);

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  zig: "zig",
};

const ZERO_SPAN: Span = {
  start_line: 1,
  end_line: 1,
  start_col: 0,
  end_col: 0,
  start_byte: 0,
  end_byte: 0,
};

function lineSpan(line: number): Span {
  return { ...ZERO_SPAN, start_line: line, end_line: line };
}

function shouldSkipPath(rel: string): boolean {
  const parts = rel.split("/");
  return parts.some((p) => SKIP_DIRS.has(p));
}

function extractLightweightSummary(
  relPath: string,
  language: string,
  text: string,
): AstFileSummary {
  const lines = text.split(/\r?\n/);
  const symbols: AstFileSummary["symbols"] = [];
  const imports: AstFileSummary["imports"] = [];
  const calls: AstFileSummary["calls"] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const line = lines[idx]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#"))
      continue;

    if (
      language === "typescript" ||
      language === "tsx" ||
      language === "javascript"
    ) {
      const imp = trimmed.match(
        /^import\s+(?:type\s+)?(?:(\{[^}]+\})|\*\s+as\s+(\w+)|(\w+))?\s*(?:from\s+)?["']([^"']+)["']/,
      );
      if (imp) {
        const names = (imp[1] ?? imp[2] ?? imp[3] ?? "")
          .replace(/[{}]/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        imports.push({
          source_module: imp[4]!,
          imported_symbols: names,
          span: lineSpan(lineNo),
        });
      }
      const sym = trimmed.match(
        /^(?:export\s+)?(?:async\s+)?(function|class|interface|type|const|enum)\s+([A-Za-z_]\w*)/,
      );
      if (sym) {
        symbols.push({
          name: sym[2]!,
          kind: sym[1]!,
          span: lineSpan(lineNo),
          signature: trimmed.slice(0, 120),
        });
      }
    } else if (language === "rust") {
      const useM = trimmed.match(/^(?:pub\s+)?use\s+([^;]+);/);
      if (useM) {
        imports.push({
          source_module: useM[1]!.trim(),
          imported_symbols: [],
          span: lineSpan(lineNo),
        });
      }
      const sym = trimmed.match(
        /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|trait|mod|type)\s+([A-Za-z_]\w*)/,
      );
      if (sym) {
        symbols.push({
          name: sym[2]!,
          kind: sym[1] === "mod" ? "module" : sym[1]!,
          span: lineSpan(lineNo),
          signature: trimmed.slice(0, 120),
        });
      }
    } else if (language === "c" || language === "cpp") {
      const inc = trimmed.match(/^#include\s+[<"]([^>"]+)[>"]/);
      if (inc) {
        imports.push({
          source_module: inc[1]!,
          imported_symbols: [],
          span: lineSpan(lineNo),
        });
      }
      const fnM = trimmed.match(
        /^(?:static\s+|inline\s+)?[A-Za-z_][\w\s*]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|;)$/,
      );
      if (
        fnM &&
        !["if", "for", "while", "switch", "return"].includes(fnM[1]!)
      ) {
        symbols.push({
          name: fnM[1]!,
          kind: "function",
          span: lineSpan(lineNo),
          signature: trimmed.slice(0, 120),
        });
      }
    } else if (language === "zig") {
      const imp = trimmed.match(/@import\("([^"]+)"\)/);
      if (imp) {
        imports.push({
          source_module: imp[1]!,
          imported_symbols: [],
          span: lineSpan(lineNo),
        });
      }
      const fnM = trimmed.match(
        /^(?:pub\s+)?(?:export\s+)?fn\s+([A-Za-z_]\w*)/,
      );
      if (fnM) {
        symbols.push({
          name: fnM[1]!,
          kind: "function",
          span: lineSpan(lineNo),
          signature: trimmed.slice(0, 120),
        });
      }
    }

    const callMatches = trimmed.matchAll(/\b([A-Za-z_][\w.:]{1,48})\s*\(/g);
    for (const m of callMatches) {
      const callee = m[1]!;
      if (
        [
          "if",
          "for",
          "while",
          "switch",
          "return",
          "catch",
          "function",
          "sizeof",
          "typeof",
        ].includes(callee)
      )
        continue;
      calls.push({ callee, span: lineSpan(lineNo) });
      if (calls.length >= 200) break;
    }
  }

  return {
    path: relPath,
    language,
    symbols,
    calls,
    imports,
    parse_errors: 0,
    line_count: lines.length,
    byte_count: Buffer.byteLength(text, "utf8"),
  };
}

export interface ScanOptions {
  includes?: string[];
  useFfi?: boolean;
  maxFiles?: number;
}

/** Populates `db` from Tree-sitter FFI if loaded, or via Bun.Glob + lightweight parser fallback. */
export function liveScanToStore(
  db: Database,
  srcRoot: string,
  options: ScanOptions = {},
): { mode: "ffi" | "fallback"; files: number } {
  const includes = options.includes ?? [
    "kernel",
    "hardware",
    "bench",
    "test",
    "frameworks",
    "system",
    "apps",
    "scripts",
  ];
  const core = options.useFfi === false ? null : loadCore();
  if (core) {
    const batch: IndexedFile[] = [];
    const stats = indexEach(
      srcRoot,
      (f) => {
        batch.push(f);
        if (batch.length >= 1000) writeFiles(db, batch.splice(0));
      },
      { includes, followIgnore: true },
    );
    if (batch.length > 0) writeFiles(db, batch);
    return { mode: "ffi", files: stats.files };
  }

  const maxFiles = options.maxFiles ?? 8000;
  const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs,rs,c,h,cpp,hpp,zig}");
  const batch: IndexedFile[] = [];
  let count = 0;

  for (const inc of includes) {
    const base = join(srcRoot, inc);
    if (!existsSync(base)) continue;
    for (const match of glob.scanSync({ cwd: base, onlyFiles: true })) {
      const rel = `${inc}/${match}`.replaceAll("\\", "/");
      if (shouldSkipPath(rel)) continue;
      const ext = rel.split(".").pop()?.toLowerCase() ?? "";
      const language = EXT_LANG[ext];
      if (!language) continue;
      const abs = join(srcRoot, rel);
      let text = "";
      try {
        const st = statSync(abs);
        if (st.size > 512 * 1024) continue;
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const parts = rel.split("/");
      const layer = parts[0] ?? "root";
      const feature = parts[1] ?? "root";
      batch.push({
        path: rel,
        language,
        layer,
        feature,
        hash: contentHash(text).hex,
        summary: extractLightweightSummary(rel, language, text),
      });
      count++;
      if (batch.length >= 500) writeFiles(db, batch.splice(0));
      if (count >= maxFiles) break;
    }
    if (count >= maxFiles) break;
  }
  if (batch.length > 0) writeFiles(db, batch);
  return { mode: "fallback", files: count };
}

export interface CrateInfo {
  name: string;
  dir: string;
  version: string;
  layer: string | null;
  hasDepsRules: boolean;
}

export interface PackageInfo {
  name: string;
  dir: string;
  version: string;
  description: string;
  layer: string | null;
  depsCount: number;
  hasBin: boolean;
}

export interface AppInfo {
  name: string;
  dir: string;
  isSubmodule: boolean;
  kind: "rust" | "bun" | "hybrid" | "other";
}

export interface HeaderInfo {
  file: string;
  defines: string[];
  functions: string[];
}

/** A Bun Rust crate absorbed into src/ (root Cargo.toml [workspace.dependencies] entry `bun_* = { path = ... }`). */
export interface BunCrate {
  name: string;
  path: string;
}

export interface GraphifySummary {
  nodes: number;
  edges: number;
  communities: number;
  godNodes: string[];
  source: string;
}

export interface MonorepoSnapshot {
  root: string;
  collectedAt: string;
  workspace: {
    version: string;
    edition: string;
    rustVersion: string;
    workspaceDepsCount: number;
  };
  crates: CrateInfo[];
  packages: PackageInfo[];
  apps: AppInfo[];
  headers: HeaderInfo[];
  bunCrates: BunCrate[];
  graphify: GraphifySummary | null;
  indexCounts: IndexCounts | null;
  topClasses: Classification[];
}

function readLayerFromRules(dirPath: string): string | null {
  const p = join(dirPath, "DEPS.rules");
  if (!existsSync(p)) return null;
  const txt = readFileSync(p, "utf8");
  const m = txt.match(/^\s*layer\s*=\s*(\d+)/m);
  return m ? `L${m[1]}` : null;
}

function parseCargoWorkspace(srcRoot: string) {
  const p = join(srcRoot, "Cargo.toml");
  if (!existsSync(p)) {
    return {
      version: "0.0.0",
      edition: "2024",
      rustVersion: "1.85",
      workspaceDepsCount: 0,
    };
  }
  const txt = readFileSync(p, "utf8");
  const version =
    txt.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)?.[1] ??
    "0.4.0";
  const edition =
    txt.match(/\[workspace\.package\][\s\S]*?edition\s*=\s*"([^"]+)"/)?.[1] ??
    "2024";
  const rustVersion =
    txt.match(
      /\[workspace\.package\][\s\S]*?rust-version\s*=\s*"([^"]+)"/,
    )?.[1] ?? "1.85";
  const depsSection =
    txt.split("[workspace.dependencies]")[1]?.split(/^\[/m)[0] ?? "";
  const workspaceDepsCount = depsSection
    .split(/\r?\n/)
    .filter((l) => /^\s*[A-Za-z0-9_-]+\s*=/.test(l)).length;
  return { version, edition, rustVersion, workspaceDepsCount };
}

function collectCrates(srcRoot: string): CrateInfo[] {
  // Explicit `[workspace] members` of the root Cargo.toml (src/*, bench, test/*: oven-sh/bun layout).
  const rootCargo = join(srcRoot, "Cargo.toml");
  if (!existsSync(rootCargo)) return [];
  const members: string[] =
    (Bun.TOML.parse(readFileSync(rootCargo, "utf8")) as any).workspace
      ?.members ?? [];
  const out: CrateInfo[] = [];
  for (const member of members) {
    const dir = join(srcRoot, member);
    const cargoPath = join(dir, "Cargo.toml");
    if (!existsSync(cargoPath)) continue;
    const ent = { name: member.split("/").at(-1)! };
    let name = ent.name;
    let version = "workspace";
    if (existsSync(cargoPath)) {
      const txt = readFileSync(cargoPath, "utf8");
      name = txt.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? ent.name;
      version = txt.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? "workspace";
    }
    const layer = readLayerFromRules(dir);
    out.push({
      name,
      dir: member,
      version,
      layer,
      hasDepsRules: existsSync(join(dir, "DEPS.rules")),
    });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function collectPackages(srcRoot: string): PackageInfo[] {
  const out: PackageInfo[] = [];
  for (const top of ["frameworks", "system"]) {
  const pkgsDir = join(srcRoot, top);
  if (!existsSync(pkgsDir)) continue;
  for (const ent of readdirSync(pkgsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(pkgsDir, ent.name);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: string;
        version?: string;
        description?: string;
        dependencies?: Record<string, string>;
        bin?: unknown;
      };
      out.push({
        name: pkg.name ?? `@aphrody/${ent.name}`,
        dir: `${top}/${ent.name}`,
        version: pkg.version ?? "0.0.0",
        description: (pkg.description ?? "").trim(),
        layer: readLayerFromRules(dir),
        depsCount: Object.keys(pkg.dependencies ?? {}).length,
        hasBin: Boolean(pkg.bin),
      });
    } catch {
      // Skip malformed package.json
    }
  }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function collectApps(srcRoot: string): AppInfo[] {
  const appsDir = join(srcRoot, "apps");
  if (!existsSync(appsDir)) return [];
  const gitmodulesPath = join(srcRoot, ".gitmodules");
  const gitmodules = existsSync(gitmodulesPath)
    ? readFileSync(gitmodulesPath, "utf8")
    : "";
  const out: AppInfo[] = [];
  for (const ent of readdirSync(appsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(appsDir, ent.name);
    const hasCargo = existsSync(join(dir, "Cargo.toml"));
    const hasPkg = existsSync(join(dir, "package.json"));
    const kind =
      hasCargo && hasPkg
        ? "hybrid"
        : hasCargo
          ? "rust"
          : hasPkg
            ? "bun"
            : "other";
    out.push({
      name: ent.name,
      dir: `apps/${ent.name}`,
      isSubmodule: gitmodules.includes(`apps/${ent.name}`),
      kind,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function collectHeaders(srcRoot: string): HeaderInfo[] {
  const incDir = join(srcRoot, "system", "core", "capi", "include");
  if (!existsSync(incDir)) return [];
  const out: HeaderInfo[] = [];
  for (const ent of readdirSync(incDir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".h")) continue;
    const txt = readFileSync(join(incDir, ent.name), "utf8");
    const defines: string[] = [];
    const functions: string[] = [];
    for (const m of txt.matchAll(/^#define\s+([A-Z0-9_]+)\b/gm)) {
      if (!m[1]!.endsWith("_H")) defines.push(m[1]!);
    }
    const normalized = txt
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\r?\n\s+/g, " ");
    for (const m of normalized.matchAll(
      /^(?:const\s+)?(?:uint32_t|int32_t|void|char\s*\*|void\s*\*)\s*\*?\s*([a-z_][a-z0-9_]*)\s*\([^)]*\)\s*;/gm,
    )) {
      functions.push(m[1]!);
    }
    out.push({
      file: relative(srcRoot, join(incDir, ent.name)).replaceAll("\\", "/"),
      defines: [...new Set(defines)],
      functions: [...new Set(functions)],
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function collectBunCrates(srcRoot: string): BunCrate[] {
  const p = join(srcRoot, "Cargo.toml");
  if (!existsSync(p)) return [];
  const deps = (Bun.TOML.parse(readFileSync(p, "utf8")) as any).workspace?.dependencies ?? {};
  return Object.entries(deps)
    .filter(([n, v]: [string, any]) => n.startsWith("bun_") && typeof v?.path === "string")
    .map(([name, v]: [string, any]) => ({ name, path: v.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function collectGraphify(srcRoot: string): GraphifySummary | null {
  const reportPath = join(srcRoot, "graphify-out", "GRAPH_REPORT.md");
  if (existsSync(reportPath)) {
    const txt = readFileSync(reportPath, "utf8");
    const m = txt.match(
      /\*\*Nodes:\*\*\s*(\d+)\s*·\s*\*\*Edges:\*\*\s*(\d+)\s*·\s*\*\*Communities:\*\*\s*(\d+)/,
    );
    const godNodes = [
      ...txt.matchAll(
        /^\d+\.\s+`([^`]+)`\s+\[([^\]]+)\]\s+-\s+(\d+)\s+connections/gm,
      ),
    ]
      .slice(0, 8)
      .map((g) => `${g[1]} (${g[2]}, ${g[3]} edges)`);
    if (m) {
      return {
        nodes: Number(m[1]),
        edges: Number(m[2]),
        communities: Number(m[3]),
        godNodes,
        source: "graphify-out/GRAPH_REPORT.md",
      };
    }
  }
  const jsonPath = join(srcRoot, "graphify-out", "graph.json");
  if (existsSync(jsonPath)) {
    const st = statSync(jsonPath);
    if (st.size < 16 * 1024 * 1024) {
      try {
        const g = JSON.parse(readFileSync(jsonPath, "utf8")) as {
          nodes?: unknown[];
          links?: unknown[];
          edges?: unknown[];
        };
        return {
          nodes: Array.isArray(g.nodes) ? g.nodes.length : 0,
          edges: Array.isArray(g.links)
            ? g.links.length
            : Array.isArray(g.edges)
              ? g.edges.length
              : 0,
          communities: 0,
          godNodes: [],
          source: "graphify-out/graph.json",
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Collects live monorepo metadata from Cargo.toml, DEPS.rules, package.json, C headers, graphify, and SQLite. */
export function collectMonorepoSnapshot(
  srcRoot: string,
  db?: Database,
): MonorepoSnapshot {
  return {
    root: srcRoot,
    collectedAt: new Date().toISOString().slice(0, 10),
    workspace: parseCargoWorkspace(srcRoot),
    crates: collectCrates(srcRoot),
    packages: collectPackages(srcRoot),
    apps: collectApps(srcRoot),
    headers: collectHeaders(srcRoot),
    bunCrates: collectBunCrates(srcRoot),
    graphify: collectGraphify(srcRoot),
    indexCounts: db ? indexCounts(db) : null,
    topClasses: db ? classification(db).slice(0, 20) : [],
  };
}
