// Fuzzy and rg-style search helpers over the SQLite symbol index and monorepo docs.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { searchSymbols, type SymbolMatch } from "./store.ts";

/** Computes a deterministic fuzzy match score (0 = no match, higher = better). */
export function fuzzyScore(query: string, target: string): number {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - Math.min(200, t.length - q.length);
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) return 600 - Math.min(200, subIdx);

  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      score += 10 + consecutive * 5;
    } else {
      consecutive = 0;
    }
  }
  return qi === q.length ? score : 0;
}

export interface DocMatch {
  path: string;
  line: number;
  text: string;
  score: number;
}

export interface SearchDocsOptions {
  limit?: number;
  caseSensitive?: boolean;
}

/** Searches README.md and docs/**\/*.{md,mdx} with rg-style line matching. */
export function searchDocs(
  srcRoot: string,
  query: string,
  options: SearchDocsOptions = {},
): DocMatch[] {
  const limit = options.limit ?? 30;
  const q = options.caseSensitive ? query : query.toLowerCase();
  if (!q) return [];

  const candidates: string[] = [];
  if (existsSync(join(srcRoot, "README.md"))) candidates.push("README.md");
  const docsDir = join(srcRoot, "docs");
  if (existsSync(docsDir)) {
    const glob = new Bun.Glob("**/*.{md,mdx}");
    for (const rel of glob.scanSync({ cwd: docsDir, onlyFiles: true })) {
      candidates.push(`docs/${rel}`.replaceAll("\\", "/"));
    }
  }

  const hits: DocMatch[] = [];
  for (const rel of candidates) {
    let content = "";
    try {
      content = readFileSync(join(srcRoot, rel), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const hay = options.caseSensitive ? raw : raw.toLowerCase();
      const idx = hay.indexOf(q);
      if (idx !== -1) {
        const headingBonus = raw.trimStart().startsWith("#") ? 200 : 0;
        hits.push({
          path: rel,
          line: i + 1,
          text: raw.trim().slice(0, 160),
          score: 500 + headingBonus - Math.min(200, idx),
        });
      }
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export interface CodebaseSearchResult {
  symbols: (SymbolMatch & { score: number })[];
  docs: DocMatch[];
}

/** Combined symbol + doc search across the SQLite index and docs/. */
export function searchCodebase(
  db: Database,
  srcRoot: string,
  query: string,
  limit = 20,
): CodebaseSearchResult {
  const rawSymbols = searchSymbols(db, query, limit * 2);
  const symbols = rawSymbols
    .map((s) => ({
      ...s,
      score: Math.max(fuzzyScore(query, s.name), fuzzyScore(query, s.path)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const docs = searchDocs(srcRoot, query, { limit });
  return { symbols, docs };
}
