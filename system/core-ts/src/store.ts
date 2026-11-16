// Persists a CoreIndex into bun:sqlite (queryable by brain / vectors) and a compact JSON summary.
import { Database } from "bun:sqlite";
import type { CoreIndex, IndexedFile } from "./ffi.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, language TEXT NOT NULL, layer TEXT NOT NULL, feature TEXT NOT NULL,
  hash TEXT NOT NULL, lines INTEGER, bytes INTEGER, parse_errors INTEGER, parsed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS symbols (
  path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL,
  scope TEXT, signature TEXT, doc TEXT);
CREATE TABLE IF NOT EXISTS refs (path TEXT NOT NULL, callee TEXT NOT NULL, scope TEXT, line INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS imports (path TEXT NOT NULL, module TEXT NOT NULL, names TEXT, line INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
CREATE INDEX IF NOT EXISTS refs_path ON refs(path);
CREATE INDEX IF NOT EXISTS imports_path ON imports(path);
CREATE INDEX IF NOT EXISTS refs_callee ON refs(callee);
CREATE INDEX IF NOT EXISTS imports_module ON imports(module);
CREATE INDEX IF NOT EXISTS files_feature ON files(layer, feature);
`;

export function openStore(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  return db;
}

/** Replaces the rows of every file in `files` (incremental: untouched paths stay). */
export function writeFiles(db: Database, files: Iterable<IndexedFile>): number {
  const del = ["files", "symbols", "refs", "imports"].map((t) =>
    db.prepare(`DELETE FROM ${t} WHERE path = ?`),
  );
  const insF = db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?)");
  const insS = db.prepare("INSERT INTO symbols VALUES (?,?,?,?,?,?,?)");
  const insR = db.prepare("INSERT INTO refs VALUES (?,?,?,?)");
  const insI = db.prepare("INSERT INTO imports VALUES (?,?,?,?)");
  let n = 0;
  db.transaction(() => {
    for (const f of files) {
      for (const d of del) d.run(f.path);
      const s = f.summary;
      insF.run(
        f.path,
        f.language,
        f.layer,
        f.feature,
        f.hash,
        s?.line_count ?? null,
        s?.byte_count ?? null,
        s?.parse_errors ?? null,
        s ? 1 : 0,
      );
      if (s) {
        for (const y of s.symbols)
          insS.run(
            f.path,
            y.name,
            y.kind,
            y.span.start_line,
            y.parent_scope ?? null,
            y.signature ?? null,
            y.doc ?? null,
          );
        for (const c of s.calls)
          insR.run(f.path, c.callee, c.caller_scope ?? null, c.span.start_line);
        for (const i of s.imports)
          insI.run(
            f.path,
            i.source_module,
            i.imported_symbols.join(","),
            i.span.start_line,
          );
      }
      n++;
    }
  })();
  return n;
}

export function writeIndex(db: Database, idx: CoreIndex): void {
  writeFiles(db, idx.files);
  db.prepare(
    "INSERT OR REPLACE INTO meta VALUES ('root', ?), ('stats', ?), ('indexed_at', ?)",
  ).run(idx.root, JSON.stringify(idx.stats), new Date().toISOString());
}

export interface Classification {
  layer: string;
  feature: string;
  language: string;
  files: number;
  symbols: number;
}

/** Files and symbols grouped by layer / feature / language. */
export function classification(db: Database): Classification[] {
  return db
    .query(
      `SELECT f.layer, f.feature, f.language, COUNT(DISTINCT f.path) AS files, COUNT(s.name) AS symbols
       FROM files f LEFT JOIN symbols s ON s.path = f.path
       GROUP BY f.layer, f.feature, f.language ORDER BY files DESC`,
    )
    .all() as Classification[];
}

/** Paths whose imports or calls mention `needle` (e.g. "bun:ffi", "tree_sitter", "llvm"). */
export function usersOf(db: Database, needle: string): string[] {
  const like = `%${needle}%`;
  return (
    db
      .query(
        `SELECT path FROM imports WHERE module LIKE ?1 UNION SELECT path FROM refs WHERE callee LIKE ?1 ORDER BY path`,
      )
      .all(like) as { path: string }[]
  ).map((r) => r.path);
}

export interface IndexCounts {
  files: number;
  symbols: number;
  refs: number;
  imports: number;
}

/** Total row counts across the index tables. */
export function indexCounts(db: Database): IndexCounts {
  const count = (table: string) =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    files: count("files"),
    symbols: count("symbols"),
    refs: count("refs"),
    imports: count("imports"),
  };
}

export interface SymbolMatch {
  path: string;
  name: string;
  kind: string;
  line: number;
  scope: string | null;
  signature: string | null;
}

/** Case-insensitive substring search over indexed symbols. */
export function searchSymbols(
  db: Database,
  query: string,
  limit = 50,
): SymbolMatch[] {
  // The pipeline (ay index) keeps a trigram FTS5 index of symbol names once a substring search has built
  // it (meta fts_ready = 1): no full scan for 3+ chars. Otherwise the LIKE scan below answers.
  if (
    query.length >= 3 &&
    (
      db.query("SELECT value FROM meta WHERE key = 'fts_ready'").get() as {
        value: string;
      } | null
    )?.value === "1"
  ) {
    const order =
      "ORDER BY CASE WHEN s.name = ?2 THEN 0 WHEN s.name LIKE ?3 THEN 1 ELSE 2 END, s.path, s.line LIMIT ?4";
    const hits = db
      .query(
        `SELECT s.path, s.name, s.kind, s.line, s.scope, s.signature
         FROM sym_name_fts f JOIN symbols s ON s.rowid = f.rowid
         WHERE sym_name_fts MATCH ?1 ${order}`,
      )
      .all(
        `"${query.replaceAll('"', '""')}"`,
        query,
        `${query}%`,
        limit,
      ) as SymbolMatch[];
    if (hits.length < limit) {
      // Paths live in `files` (small): scan those, then join their symbols.
      const seen = new Set(hits.map((h) => `${h.path}:${h.line}:${h.name}`));
      const byPath = db
        .query(
          `SELECT s.path, s.name, s.kind, s.line, s.scope, s.signature
           FROM files f CROSS JOIN symbols s ON s.path = f.path
           WHERE f.path LIKE ?1 ${order}`,
        )
        .all(`%${query}%`, query, `${query}%`, limit) as SymbolMatch[];
      for (const h of byPath)
        if (hits.length < limit && !seen.has(`${h.path}:${h.line}:${h.name}`))
          hits.push(h);
    }
    return hits;
  }
  const like = `%${query}%`;
  return db
    .query(
      `SELECT path, name, kind, line, scope, signature
       FROM symbols
       WHERE name LIKE ?1 OR path LIKE ?1
       ORDER BY CASE WHEN name = ?2 THEN 0 WHEN name LIKE ?3 THEN 1 ELSE 2 END, path, line
       LIMIT ?4`,
    )
    .all(like, query, `${query}%`, limit) as SymbolMatch[];
}
