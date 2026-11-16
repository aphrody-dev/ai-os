//! Native access to the agent Context store. Same schema as `frameworks/ai-os/src/core/context.ts`
//! (tables `entries`, `entries_fts`, `kv`), so TS (bun:sqlite) and Python (via the `python` feature, module `agent_core`) share one memory.
//! Heads available natively: lexical (FTS5 bm25) and recency, fused with weighted RRF (k = 60) like the TS default.
//! The semantic head stays in TS (embedder providers); entries ingested here get embedded lazily by the TS side.

#[cfg(feature = "python")]
mod python;

use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: String,
    pub source: String,
    pub scope: String,
    pub title: Option<String>,
    pub text: String,
    pub at: i64,
}

#[derive(Debug, Clone)]
pub struct Scored {
    pub entry: Entry,
    pub score: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Select {
    pub k: usize,
    pub sources: Option<Vec<String>>,
    pub scopes: Option<Vec<String>>,
    pub lexical: f64,
    pub recency: f64,
    pub half_life_days: f64,
    pub now_ms: Option<i64>,
}

impl Select {
    pub fn new(k: usize) -> Self {
        Self { k, lexical: 0.8, recency: 0.2, half_life_days: 14.0, ..Default::default() }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

const SCHEMA: &str = "
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS entries(rid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL, title TEXT, text TEXT NOT NULL, symbols TEXT, at INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(title, text, content='entries', content_rowid='rid', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(rowid, title, text) VALUES (new.rid, new.title, new.text); END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN INSERT INTO entries_fts(entries_fts, rowid, title, text) VALUES ('delete', old.rid, old.title, old.text); END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN INSERT INTO entries_fts(entries_fts, rowid, title, text) VALUES ('delete', old.rid, old.title, old.text); INSERT INTO entries_fts(rowid, title, text) VALUES (new.rid, new.title, new.text); END;
CREATE TABLE IF NOT EXISTS kv(embedder TEXT, hash TEXT, vec BLOB, PRIMARY KEY(embedder, hash));
";

pub struct Store {
    conn: Connection,
}

fn visible(e: &Entry, o: &Select) -> bool {
    if let Some(s) = &o.sources {
        if !s.iter().any(|x| x == &e.source) {
            return false;
        }
    }
    if let Some(sc) = &o.scopes {
        if !sc.iter().any(|s| s == "*" || &e.scope == s || e.scope.starts_with(&format!("{s}:"))) {
            return false;
        }
    }
    true
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Entry> {
    Ok(Entry { id: r.get("id")?, source: r.get("source")?, scope: r.get("scope")?, title: r.get("title")?, text: r.get("text")?, at: r.get("at")? })
}

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    pub fn ingest(&self, e: &Entry) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO entries(id, source, scope, title, text, symbols, at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)
             ON CONFLICT(id) DO UPDATE SET source=excluded.source, scope=excluded.scope, title=excluded.title, text=excluded.text, at=excluded.at",
            params![e.id, e.source, e.scope, e.title, e.text, e.at],
        )?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM entries WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<Entry>> {
        let mut st = self.conn.prepare("SELECT * FROM entries WHERE id = ?1")?;
        let mut rows = st.query_map(params![id], row)?;
        rows.next().transpose()
    }

    pub fn list(&self, o: &Select, limit: usize) -> rusqlite::Result<Vec<Entry>> {
        let mut st = self.conn.prepare("SELECT * FROM entries ORDER BY at DESC, rid DESC LIMIT ?1")?;
        let v = st.query_map(params![limit as i64], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v.into_iter().filter(|e| visible(e, o)).collect())
    }

    /// Lexical + recency heads, weighted reciprocal-rank fusion, top-k.
    pub fn select(&self, query: &str, o: &Select) -> rusqlite::Result<Vec<Scored>> {
        let terms: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|t| t.chars().count() > 1)
            .map(|t| format!("\"{}\"", t.replace('"', "")))
            .collect();
        let mut pool: HashMap<String, Entry> = HashMap::new();
        let mut lex: Vec<String> = Vec::new();
        if !terms.is_empty() && o.lexical > 0.0 {
            let mut st = self.conn.prepare(
                "SELECT e.* FROM entries_fts JOIN entries e ON e.rid = entries_fts.rowid WHERE entries_fts MATCH ?1 ORDER BY bm25(entries_fts, 2.0, 1.0) LIMIT 200",
            )?;
            for e in st.query_map(params![terms.join(" OR ")], row)? {
                let e = e?;
                if visible(&e, o) {
                    lex.push(e.id.clone());
                    pool.insert(e.id.clone(), e);
                }
            }
        }
        for e in self.list(o, 200)? {
            pool.entry(e.id.clone()).or_insert(e);
        }
        let now = o.now_ms.unwrap_or_else(now_ms) as f64;
        let hl = o.half_life_days.max(0.001) * 86_400_000.0;
        let mut rec: Vec<(&String, f64)> = pool.values().map(|e| (&e.id, 0.5f64.powf((now - e.at as f64) / hl))).collect();
        rec.sort_by(|a, b| b.1.total_cmp(&a.1));
        let (wl, wr) = (o.lexical.max(0.0), o.recency.max(0.0));
        let wsum = if wl + wr > 0.0 { wl + wr } else { 1.0 };
        let mut fused: HashMap<&String, f64> = HashMap::new();
        for (r, id) in lex.iter().enumerate() {
            *fused.entry(id).or_default() += (wl / wsum) / (61.0 + r as f64);
        }
        for (r, (id, _)) in rec.iter().enumerate() {
            *fused.entry(id).or_default() += (wr / wsum) / (61.0 + r as f64);
        }
        let total: f64 = fused.values().sum::<f64>().max(f64::MIN_POSITIVE);
        let mut out: Vec<Scored> = fused.into_iter().map(|(id, s)| Scored { entry: pool[id].clone(), score: s / total }).collect();
        out.sort_by(|a, b| b.score.total_cmp(&a.score));
        out.truncate(o.k.max(1));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_select_mask_recency() {
        let dir = std::env::temp_dir().join(format!("agent-context-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = Store::open(dir.join("c.sqlite").to_str().unwrap()).unwrap();
        let now = now_ms();
        let mk = |id: &str, scope: &str, text: &str, at: i64| Entry { id: id.into(), source: "memory".into(), scope: scope.into(), title: None, text: text.into(), at };
        s.ingest(&mk("memory:1", "user", "deploy the website with rsync to prd", now - 30 * 86_400_000)).unwrap();
        s.ingest(&mk("memory:2", "user", "the user prefers French answers", now)).unwrap();
        s.ingest(&mk("memory:3", "team", "deploy token rotation", now)).unwrap();
        let mut o = Select::new(3);
        o.scopes = Some(vec!["user".into()]);
        let r = s.select("how to deploy the website", &o).unwrap();
        assert_eq!(r[0].entry.id, "memory:1");
        assert!(r.iter().all(|x| x.entry.scope == "user"));
        s.ingest(&mk("memory:1", "user", "deploy with bun build", now)).unwrap();
        assert_eq!(s.get("memory:1").unwrap().unwrap().text, "deploy with bun build");
        s.remove("memory:1").unwrap();
        assert!(s.get("memory:1").unwrap().is_none());
    }
}
