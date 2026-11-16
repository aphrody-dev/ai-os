//! The one SQLite schema of the monorepo index (WAL, FTS5). The first five tables keep the exact
//! columns of the historical `var/index/core.db` so every existing reader (system/core-ts, ai-os)
//! keeps working; the rest is additive. Binary and IR facts, cross-host `pending` jobs and the
//! `edges` view live in the same file.

use super::facts::Facts;
use rusqlite::{Connection, params};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

pub const SCHEMA_VERSION: &str = "2";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, language TEXT NOT NULL, layer TEXT NOT NULL, feature TEXT NOT NULL,
  hash TEXT NOT NULL, lines INTEGER, bytes INTEGER, parse_errors INTEGER, parsed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS symbols (
  path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL,
  scope TEXT, signature TEXT, doc TEXT);
CREATE TABLE IF NOT EXISTS refs (path TEXT NOT NULL, callee TEXT NOT NULL, scope TEXT, line INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS imports (path TEXT NOT NULL, module TEXT NOT NULL, names TEXT, line INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS files_feature ON files(layer, feature);

CREATE TABLE IF NOT EXISTS fstat (
  path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, hash TEXT NOT NULL,
  kind TEXT NOT NULL, label TEXT NOT NULL, mime TEXT, score REAL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bin (
  path TEXT PRIMARY KEY, hash TEXT NOT NULL, format TEXT NOT NULL, arch TEXT, entry INTEGER,
  sections INTEGER, imports INTEGER, exports INTEGER, entropy REAL, libraries TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS funcs (
  path TEXT NOT NULL, name TEXT NOT NULL, addr INTEGER NOT NULL, size INTEGER, insns INTEGER,
  blocks INTEGER, kind TEXT NOT NULL, pseudo_c TEXT);
CREATE INDEX IF NOT EXISTS funcs_path ON funcs(path);
CREATE INDEX IF NOT EXISTS funcs_name ON funcs(name);
CREATE TABLE IF NOT EXISTS xrefs (path TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS xrefs_path ON xrefs(path);
CREATE INDEX IF NOT EXISTS xrefs_dst ON xrefs(dst);
CREATE TABLE IF NOT EXISTS ir (
  path TEXT PRIMARY KEY, target TEXT, functions INTEGER, insns INTEGER, simd INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pending (
  path TEXT NOT NULL, stage TEXT NOT NULL, ver INTEGER NOT NULL, hash TEXT NOT NULL,
  queued_ns INTEGER NOT NULL, PRIMARY KEY (path, stage)) WITHOUT ROWID;
CREATE VIRTUAL TABLE IF NOT EXISTS sym_name_fts USING fts5(name, content='symbols', content_rowid='rowid', tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5(body, path UNINDEXED);
CREATE VIEW IF NOT EXISTS edges AS
  SELECT path, COALESCE(scope, '') AS src, callee AS dst, 'call' AS kind, line FROM refs
  UNION ALL SELECT path, path, module, 'import', line FROM imports
  UNION ALL SELECT path, src, dst, kind, 0 FROM xrefs;
";

/// The big-table indexes of the historical schema. A cold index drops them during the load and
/// builds them once from sorted data afterwards (several times faster than maintaining them per row).
const BULK_INDEXES: [(&str, &str); 6] = [
    ("symbols_name", "symbols(name)"),
    ("symbols_path", "symbols(path)"),
    ("refs_path", "refs(path)"),
    ("imports_path", "imports(path)"),
    ("refs_callee", "refs(callee)"),
    ("imports_module", "imports(module)"),
];

pub struct Store {
    pub(crate) conn: Connection,
    bulk: std::cell::Cell<bool>,
    /// The trigram index is built and kept in step with `symbols` (see [`Store::ensure_fts`]).
    fts_ready: std::cell::Cell<bool>,
}

#[derive(Debug, Clone)]
pub struct Known {
    pub size: u64,
    pub mtime_ns: i64,
    pub hash: String,
}

/// The per-file row shared by `files` and `fstat`.
#[derive(Debug, Clone)]
pub struct FileRow {
    pub path: String,
    pub layer: String,
    pub feature: String,
    pub hash: String,
    pub size: u64,
    pub mtime_ns: i64,
    pub kind: String,
    pub label: String,
    pub mime: Option<String>,
    pub score: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SymbolHit {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub line: i64,
    pub scope: Option<String>,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Totals {
    pub files: i64,
    pub parsed: i64,
    pub symbols: i64,
    pub calls: i64,
    pub imports: i64,
    pub lines: i64,
    pub binaries: i64,
    pub funcs: i64,
    pub xrefs: i64,
    pub pending: i64,
}

const ORDER: &str = "ORDER BY CASE WHEN s.name = ?2 THEN 0 WHEN s.name LIKE ?3 THEN 1 ELSE 2 END, s.path, s.line LIMIT ?4";

fn e(err: rusqlite::Error) -> String {
    err.to_string()
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|er| format!("mkdir {}: {er}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(e)?;
        conn.busy_timeout(std::time::Duration::from_secs(30)).map_err(e)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -65536; PRAGMA mmap_size = 268435456; PRAGMA wal_autocheckpoint = 20000;",
        )
        .map_err(e)?;
        conn.execute_batch(SCHEMA).map_err(e)?;
        let store = Self { conn, bulk: std::cell::Cell::new(false), fts_ready: std::cell::Cell::new(false) };
        store.create_bulk_indexes()?;
        store
            .conn
            .execute("INSERT OR REPLACE INTO meta VALUES ('schema', ?1)", [SCHEMA_VERSION])
            .map_err(e)?;
        let ready: Option<String> =
            store.conn.query_row("SELECT value FROM meta WHERE key = 'fts_ready'", [], |r| r.get(0)).ok();
        store.fts_ready.set(ready.as_deref() == Some("1"));
        Ok(store)
    }

    /// The trigram index is built on the first substring search (about 1.5 s for 70k symbols), not on
    /// every cold index; once built it is maintained per file. Databases of the old bun indexer, and
    /// cold loads, start without it.
    pub fn ensure_fts(&self) -> Result<(), String> {
        if !self.fts_ready.get() {
            self.rebuild_fts()?;
        }
        Ok(())
    }

    fn create_bulk_indexes(&self) -> Result<(), String> {
        for (name, on) in BULK_INDEXES {
            self.conn.execute_batch(&format!("CREATE INDEX IF NOT EXISTS {name} ON {on}")).map_err(e)?;
        }
        Ok(())
    }

    /// Cold load: nothing indexed yet, so skip per-file resets and FTS upkeep and drop the big indexes.
    /// [`Store::end_bulk`] must follow (a crash in between is repaired by the next `open`).
    pub fn begin_bulk(&self) -> Result<(), String> {
        self.bulk.set(true);
        for (name, _) in BULK_INDEXES {
            self.conn.execute_batch(&format!("DROP INDEX IF EXISTS {name}")).map_err(e)?;
        }
        Ok(())
    }

    pub fn end_bulk(&self) -> Result<(), String> {
        self.bulk.set(false);
        self.create_bulk_indexes()?;
        self.fts_ready.set(false);
        self.set_meta("fts_ready", "0")
    }

    pub fn rebuild_fts(&self) -> Result<(), String> {
        self.conn.execute("INSERT INTO sym_name_fts(sym_name_fts) VALUES('rebuild')", []).map_err(e)?;
        self.fts_ready.set(true);
        self.set_meta("fts_ready", "1")
    }

    pub fn begin(&self) -> Result<(), String> {
        self.conn.execute_batch("BEGIN IMMEDIATE").map_err(e)
    }

    pub fn commit(&self) -> Result<(), String> {
        self.conn.execute_batch("COMMIT").map_err(e)
    }

    /// Every known (size, mtime, hash): the in-memory fast path that skips unchanged files.
    pub fn known(&self) -> Result<HashMap<String, Known>, String> {
        let mut st = self.conn.prepare("SELECT path, size, mtime_ns, hash FROM fstat").map_err(e)?;
        let rows = st
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, Known { size: r.get::<_, i64>(1)? as u64, mtime_ns: r.get(2)?, hash: r.get(3)? }))
            })
            .map_err(e)?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(e)
    }

    /// Drop every derived row of `path` (symbols with their FTS entries, edges, facts) but keep the
    /// `files` row so its rowid, which `text_fts` reuses, stays stable.
    pub fn reset_file(&self, path: &str) -> Result<(), String> {
        if self.bulk.get() {
            return Ok(());
        }
        let c = &self.conn;
        if self.fts_ready.get() {
            c.prepare_cached("INSERT INTO sym_name_fts(sym_name_fts, rowid, name) SELECT 'delete', rowid, name FROM symbols WHERE path = ?1")
                .and_then(|mut s| s.execute([path]))
                .map_err(e)?;
        }
        c.prepare_cached("DELETE FROM text_fts WHERE rowid = (SELECT rowid FROM files WHERE path = ?1)")
            .and_then(|mut s| s.execute([path]))
            .map_err(e)?;
        for t in ["symbols", "refs", "imports", "bin", "funcs", "xrefs", "ir", "pending"] {
            c.prepare_cached(&format!("DELETE FROM {t} WHERE path = ?1"))
                .and_then(|mut s| s.execute([path]))
                .map_err(e)?;
        }
        Ok(())
    }

    pub fn remove(&self, path: &str) -> Result<(), String> {
        self.reset_file(path)?;
        for t in ["files", "fstat"] {
            self.conn
                .prepare_cached(&format!("DELETE FROM {t} WHERE path = ?1"))
                .and_then(|mut s| s.execute([path]))
                .map_err(e)?;
        }
        Ok(())
    }

    pub fn put_file(&self, f: &FileRow) -> Result<(), String> {
        self.conn
            .prepare_cached(
                "INSERT INTO files(path, language, layer, feature, hash, lines, bytes, parse_errors, parsed)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, 0)
                 ON CONFLICT(path) DO UPDATE SET language = ?2, layer = ?3, feature = ?4, hash = ?5,
                   lines = NULL, bytes = ?6, parse_errors = NULL, parsed = 0",
            )
            .and_then(|mut s| s.execute(params![f.path, f.label, f.layer, f.feature, f.hash, f.size as i64]))
            .map_err(e)?;
        self.touch(f)
    }

    /// Update only `fstat` (file touched, content unchanged).
    pub fn touch(&self, f: &FileRow) -> Result<(), String> {
        self.conn
            .prepare_cached("INSERT OR REPLACE INTO fstat VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
            .and_then(|mut s| s.execute(params![f.path, f.size as i64, f.mtime_ns, f.hash, f.kind, f.label, f.mime, f.score]))
            .map_err(e)?;
        Ok(())
    }

    /// Insert the rows of one stage's `facts` for `path` (the file was `reset_file`d on change;
    /// functions and edges of the same kind are replaced so a re-applied deep result never duplicates).
    pub fn apply(&self, path: &str, facts: &Facts) -> Result<(), String> {
        let c = &self.conn;
        if let Some(a) = &facts.ast {
            c.prepare_cached("UPDATE files SET lines = ?2, bytes = ?3, parse_errors = ?4, parsed = 1 WHERE path = ?1")
                .and_then(|mut s| s.execute(params![path, a.line_count as i64, a.byte_count as i64, a.parse_errors as i64]))
                .map_err(e)?;
            let mut ins_s = c
                .prepare_cached("INSERT INTO symbols VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
                .map_err(e)?;
            for y in &a.symbols {
                ins_s
                    .execute(params![path, y.name, y.kind.as_str(), y.span.start_line as i64, y.parent_scope, y.signature, y.doc])
                    .map_err(e)?;
            }
            if !a.symbols.is_empty() && self.fts_ready.get() {
                c.prepare_cached("INSERT INTO sym_name_fts(rowid, name) SELECT rowid, name FROM symbols WHERE path = ?1")
                    .and_then(|mut s| s.execute([path]))
                    .map_err(e)?;
            }
            let mut ins_r = c.prepare_cached("INSERT INTO refs VALUES (?1, ?2, ?3, ?4)").map_err(e)?;
            for r in &a.calls {
                ins_r.execute(params![path, r.callee, r.caller_scope, r.span.start_line as i64]).map_err(e)?;
            }
            let mut ins_i = c.prepare_cached("INSERT INTO imports VALUES (?1, ?2, ?3, ?4)").map_err(e)?;
            for i in &a.imports {
                ins_i
                    .execute(params![path, i.source_module, i.imported_symbols.join(","), i.span.start_line as i64])
                    .map_err(e)?;
            }
        }
        if let Some(b) = &facts.bin {
            let hash: String = c
                .query_row("SELECT hash FROM fstat WHERE path = ?1", [path], |r| r.get(0))
                .unwrap_or_default();
            c.prepare_cached("INSERT OR REPLACE INTO bin VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
                .and_then(|mut s| {
                    s.execute(params![
                        path, hash, b.format, b.arch, b.entry.map(|v| v as i64), b.sections, b.imports, b.exports, b.entropy,
                        b.libraries.join(",")
                    ])
                })
                .map_err(e)?;
        }
        let mut kinds: Vec<&str> = facts.funcs.iter().map(|f| f.kind.as_str()).collect();
        kinds.sort_unstable();
        kinds.dedup();
        for k in kinds {
            c.prepare_cached("DELETE FROM funcs WHERE path = ?1 AND kind = ?2")
                .and_then(|mut s| s.execute(params![path, k]))
                .map_err(e)?;
        }
        if !facts.funcs.is_empty() {
            let mut ins = c.prepare_cached("INSERT INTO funcs VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").map_err(e)?;
            for f in &facts.funcs {
                ins.execute(params![path, f.name, f.addr as i64, f.size, f.insns, f.blocks, f.kind, f.pseudo_c]).map_err(e)?;
            }
        }
        let mut xk: Vec<&str> = facts.xrefs.iter().map(|x| x.kind.as_str()).collect();
        xk.sort_unstable();
        xk.dedup();
        for k in xk {
            c.prepare_cached("DELETE FROM xrefs WHERE path = ?1 AND kind = ?2")
                .and_then(|mut s| s.execute(params![path, k]))
                .map_err(e)?;
        }
        if !facts.xrefs.is_empty() {
            let mut ins = c.prepare_cached("INSERT INTO xrefs VALUES (?1, ?2, ?3, ?4)").map_err(e)?;
            for x in &facts.xrefs {
                ins.execute(params![path, x.src, x.dst, x.kind]).map_err(e)?;
            }
        }
        if let Some(ir) = &facts.ir {
            c.prepare_cached("INSERT OR REPLACE INTO ir VALUES (?1, ?2, ?3, ?4, ?5)")
                .and_then(|mut s| s.execute(params![path, ir.target, ir.functions, ir.insns as i64, ir.simd]))
                .map_err(e)?;
        }
        if let Some(t) = &facts.text {
            c.prepare_cached("DELETE FROM text_fts WHERE rowid = (SELECT rowid FROM files WHERE path = ?1)")
                .and_then(|mut s| s.execute([path]))
                .map_err(e)?;
            c.prepare_cached("INSERT INTO text_fts(rowid, body, path) SELECT rowid, ?2, ?1 FROM files WHERE path = ?1")
                .and_then(|mut s| s.execute(params![path, t]))
                .map_err(e)?;
        }
        Ok(())
    }

    pub fn add_pending(&self, path: &str, stage: &str, ver: u32, hash: &str, now_ns: i64) -> Result<(), String> {
        self.conn
            .prepare_cached("INSERT OR REPLACE INTO pending VALUES (?1, ?2, ?3, ?4, ?5)")
            .and_then(|mut s| s.execute(params![path, stage, ver, hash, now_ns]))
            .map_err(e)?;
        Ok(())
    }

    pub fn clear_pending(&self, path: &str, stage: &str) -> Result<(), String> {
        self.conn
            .prepare_cached("DELETE FROM pending WHERE path = ?1 AND stage = ?2")
            .and_then(|mut s| s.execute(params![path, stage]))
            .map_err(e)?;
        Ok(())
    }

    /// (path, stage, ver, hash) of results still owed by a worker.
    pub fn pending(&self) -> Result<Vec<(String, String, u32, String)>, String> {
        let mut st = self.conn.prepare("SELECT path, stage, ver, hash FROM pending").map_err(e)?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u32, r.get(3)?)))
            .map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    pub fn totals(&self) -> Result<Totals, String> {
        self.conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM files WHERE parsed = 1),
                        (SELECT COUNT(*) FROM symbols), (SELECT COUNT(*) FROM refs), (SELECT COUNT(*) FROM imports),
                        (SELECT COALESCE(SUM(lines), 0) FROM files), (SELECT COUNT(*) FROM bin),
                        (SELECT COUNT(*) FROM funcs), (SELECT COUNT(*) FROM xrefs), (SELECT COUNT(*) FROM pending)",
                [],
                |r| {
                    Ok(Totals {
                        files: r.get(0)?, parsed: r.get(1)?, symbols: r.get(2)?, calls: r.get(3)?, imports: r.get(4)?,
                        lines: r.get(5)?, binaries: r.get(6)?, funcs: r.get(7)?, xrefs: r.get(8)?, pending: r.get(9)?,
                    })
                },
            )
            .map_err(e)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .prepare_cached("INSERT OR REPLACE INTO meta VALUES (?1, ?2)")
            .and_then(|mut s| s.execute([key, value]))
            .map_err(e)?;
        Ok(())
    }

    /// Exact-name lookup (b-tree).
    pub fn lookup(&self, name: &str, limit: usize) -> Result<Vec<SymbolHit>, String> {
        let mut st = self
            .conn
            .prepare_cached("SELECT path, name, kind, line, scope, signature FROM symbols WHERE name = ?1 ORDER BY path, line LIMIT ?2")
            .map_err(e)?;
        let rows = st.query_map(params![name, limit as i64], hit).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    /// Substring search over symbol names and paths: trigram FTS for 3+ characters, LIKE below.
    pub fn search(&self, q: &str, limit: usize) -> Result<Vec<SymbolHit>, String> {
        if q.chars().count() < 3 {
            return self.search_like(q, limit);
        }
        self.ensure_fts()?;
        let prefix = format!("{q}%");
        let m = format!("\"{}\"", q.replace('"', "\"\""));
        let mut st = self
            .conn
            .prepare_cached(&format!(
                "SELECT s.path, s.name, s.kind, s.line, s.scope, s.signature FROM sym_name_fts f JOIN symbols s ON s.rowid = f.rowid
                 WHERE sym_name_fts MATCH ?1 {ORDER}"
            ))
            .map_err(e)?;
        let rows = st.query_map(params![m, q, prefix, limit as i64], hit).map_err(e)?;
        let mut out = rows.collect::<Result<Vec<_>, _>>().map_err(e)?;
        if out.len() < limit {
            // Paths live in `files` (a few thousand rows): scan those, not the symbols.
            let mut st = self
                .conn
                .prepare_cached(&format!(
                    "SELECT s.path, s.name, s.kind, s.line, s.scope, s.signature FROM files f CROSS JOIN symbols s ON s.path = f.path
                     WHERE f.path LIKE ?1 {ORDER}"
                ))
                .map_err(e)?;
            let rows = st.query_map(params![format!("%{q}%"), q, prefix, limit as i64], hit).map_err(e)?;
            for h in rows {
                let h = h.map_err(e)?;
                if out.len() < limit && !out.iter().any(|o| o.path == h.path && o.line == h.line && o.name == h.name) {
                    out.push(h);
                }
            }
        }
        Ok(out)
    }

    /// The historical full-scan substring search (`LIKE '%q%'`), kept for short queries and as the benchmark baseline.
    pub fn search_like(&self, q: &str, limit: usize) -> Result<Vec<SymbolHit>, String> {
        let like = format!("%{q}%");
        let mut st = self
            .conn
            .prepare_cached(&format!(
                "SELECT s.path, s.name, s.kind, s.line, s.scope, s.signature FROM symbols s
                 WHERE s.name LIKE ?1 OR s.path LIKE ?1 {ORDER}"
            ))
            .map_err(e)?;
        let rows = st.query_map(params![like, q, format!("{q}%"), limit as i64], hit).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    /// `n` random symbol names (benchmark workload).
    pub fn sample_names(&self, n: usize) -> Result<Vec<String>, String> {
        let mut st = self.conn.prepare("SELECT name FROM symbols ORDER BY random() LIMIT ?1").map_err(e)?;
        let rows = st.query_map([n as i64], |r| r.get(0)).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }

    /// Full-text search over documents and doc text (`text_fts`).
    pub fn text(&self, q: &str, limit: usize) -> Result<Vec<(String, String)>, String> {
        let m = format!("\"{}\"", q.replace('"', "\"\""));
        let mut st = self
            .conn
            .prepare_cached("SELECT path, snippet(text_fts, 0, '[', ']', '...', 12) FROM text_fts WHERE text_fts MATCH ?1 ORDER BY rank LIMIT ?2")
            .map_err(e)?;
        let rows = st.query_map(params![m, limit as i64], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(e)
    }
}

fn hit(r: &rusqlite::Row<'_>) -> rusqlite::Result<SymbolHit> {
    Ok(SymbolHit { path: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, line: r.get(3)?, scope: r.get(4)?, signature: r.get(5)? })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbols::{AstFileSummary, AstSymbol, Span, SymbolKind};

    fn row(path: &str, hash: &str) -> FileRow {
        FileRow {
            path: path.into(), layer: "src".into(), feature: "x".into(), hash: hash.into(), size: 10, mtime_ns: 1,
            kind: "source".into(), label: "rust".into(), mime: None, score: None,
        }
    }

    fn facts(names: &[&str]) -> Facts {
        let sp = Span::new(1, 1, 1, 2, 0, 1);
        Facts {
            ast: Some(AstFileSummary {
                path: "a.rs".into(), language: "rust".into(),
                symbols: names
                    .iter()
                    .map(|n| AstSymbol { name: (*n).into(), kind: SymbolKind::Function, span: sp, signature: None, doc: None, parent_scope: None })
                    .collect(),
                calls: vec![], imports: vec![], parse_errors: 0, line_count: 3, byte_count: 10,
            }),
            ..Facts::default()
        }
    }

    #[test]
    fn replace_search_and_remove_keep_fts_consistent() {
        let dir = std::env::temp_dir().join(format!("ay-store-{}", std::process::id()));
        let st = Store::open(&dir.join("t.db")).unwrap();
        st.begin().unwrap();
        st.put_file(&row("a.rs", "h1")).unwrap();
        st.apply("a.rs", &facts(&["parse_widget", "render"])).unwrap();
        st.commit().unwrap();
        assert_eq!(st.search("widget", 10).unwrap().len(), 1);
        assert_eq!(st.search("re", 10).unwrap().len(), 1, "short query falls back to LIKE");
        assert_eq!(st.lookup("render", 10).unwrap().len(), 1);

        st.begin().unwrap();
        st.reset_file("a.rs").unwrap();
        st.put_file(&row("a.rs", "h2")).unwrap();
        st.apply("a.rs", &facts(&["gadget"])).unwrap();
        st.commit().unwrap();
        assert!(st.search("widget", 10).unwrap().is_empty(), "old symbol left the trigram index");
        assert_eq!(st.search("gadget", 10).unwrap().len(), 1);
        assert_eq!(st.known().unwrap()["a.rs"].hash, "h2");

        st.remove("a.rs").unwrap();
        assert_eq!(st.totals().unwrap().files, 0);
        assert!(st.search("gadget", 10).unwrap().is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn edges_view_unions_calls_imports_and_xrefs() {
        let st = Store::open(&std::env::temp_dir().join(format!("ay-edges-{}.db", std::process::id()))).unwrap();
        st.conn.execute("INSERT INTO refs VALUES ('a.rs', 'f', 'main', 3)", []).unwrap();
        st.conn.execute("INSERT INTO imports VALUES ('a.rs', 'std::fs', 'read', 1)", []).unwrap();
        st.conn.execute("INSERT INTO xrefs VALUES ('x.exe', 'sub_1', 'CreateFileW', 'import')", []).unwrap();
        let n: i64 = st.conn.query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
    }
}
