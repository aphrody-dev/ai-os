//! Unified C ABI for `@aphrody/ai-os`: Unix/GNU-like Agent OS distribution,
//! LLM standard contract, RAG (SQLite FTS5 + RRF), World Model, and System 1 Decision.

use crate::cabi::{APHRODY_ABI_VERSION, c_str, free_c_string, json_err, json_ok};
use agent_core::{Entry, Select, Store, now_ms};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::ffi::c_char;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

const AI_OS_SCHEMA: &str = "
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS world_entities(
  entity TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_transitions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  predicted_json TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  surprise REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sys1_decisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  risk REAL NOT NULL,
  confidence REAL NOT NULL,
  surprise REAL NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  latency_us INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
";

#[derive(Serialize)]
struct UnameInfo<'a> {
    os: &'a str,
    release: &'a str,
    kernel: &'a str,
    arch: &'a str,
    abi_version: u32,
    standards: &'a [&'a str],
    fhs: FhsLayout<'a>,
}

#[derive(Serialize)]
struct FhsLayout<'a> {
    etc: &'a str,
    var: &'a str,
    home: &'a str,
    proc: &'a str,
    tmp: &'a str,
    dev: &'a [&'a str],
}

#[derive(Serialize)]
struct VfsResolved {
    vpath: String,
    host_path: String,
    device: String,
    readonly: bool,
}

#[derive(Deserialize)]
struct RagUpsertReq {
    id: String,
    source: String,
    scope: String,
    #[serde(default)]
    title: Option<String>,
    text: String,
    #[serde(default)]
    at: Option<i64>,
}

#[derive(Deserialize)]
struct RagQueryReq {
    query: String,
    #[serde(default = "default_k")]
    k: usize,
    #[serde(default)]
    sources: Option<Vec<String>>,
    #[serde(default)]
    scopes: Option<Vec<String>>,
}

fn default_k() -> usize {
    8
}

#[derive(Serialize)]
struct RagHit {
    id: String,
    source: String,
    scope: String,
    title: Option<String>,
    text: String,
    at: i64,
    score: f64,
}

#[derive(Deserialize)]
struct WorldStepReq {
    actor: String,
    action: String,
    target: String,
    predicted: serde_json::Value,
    observed: serde_json::Value,
    #[serde(default)]
    ts: Option<i64>,
}

#[derive(Serialize)]
struct WorldStepRes {
    entity: String,
    surprise: f64,
    escalate_sys2: bool,
    state: serde_json::Value,
}

#[derive(Deserialize)]
struct Sys1DecideReq {
    action: String,
    risk: f64,
    confidence: f64,
    #[serde(default)]
    world_surprise: f64,
    #[serde(default)]
    latency_budget_ms: Option<u64>,
}

#[derive(Serialize)]
struct Sys1DecideRes {
    decision: &'static str,
    reason: String,
    latency_us: u64,
}

fn open_os_db(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(AI_OS_SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn normalize_vpath(vpath: &str) -> Result<Vec<String>, String> {
    let trimmed = vpath.trim();
    if trimmed.is_empty() {
        return Err("empty virtual path".into());
    }
    let mut parts = Vec::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(s) => {
                if let Some(st) = s.to_str() {
                    parts.push(st.to_owned());
                }
            }
            Component::ParentDir => return Err("parent traversal '..' forbidden in VFS".into()),
            Component::RootDir | Component::CurDir => {}
            Component::Prefix(_) => return Err("host drive prefix forbidden in VFS".into()),
        }
    }
    Ok(parts)
}

/// AI OS C ABI version.
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_abi_version() -> u32 {
    APHRODY_ABI_VERSION
}

/// Release a string returned by any `ai_os_*` function. Null is a no-op.
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_free(p: *mut c_char) {
    // SAFETY: `p` is null or was produced by `into_c_string` in this library.
    unsafe { free_c_string(p) };
}

/// Unix/GNU-like Agent OS descriptor (`uname` + FHS layout + supported standards).
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_uname_json() -> *mut c_char {
    json_ok(&UnameInfo {
        os: "aphrody-ai-os",
        release: env!("CARGO_PKG_VERSION"),
        kernel: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        abi_version: APHRODY_ABI_VERSION,
        standards: &[
            "posix-vfs-fhs",
            "openapi-3.2.1",
            "openai-chat-v1",
            "anthropic-messages-v1",
            "gemini-generate-v1",
            "vercel-ai-sdk-7.0",
            "cloudflare-agents-0.33",
            "mcp-2026-07-28",
            "a2a-1.0.1",
            "acp-1.31.0",
            "sqlite-fts5-rrf",
            "world-model-v1",
            "system1-policy-v1",
        ],
        fhs: FhsLayout {
            etc: "/etc/ai-os",
            var: "/var/lib/ai-os",
            home: "/home/agent",
            proc: "/proc/agent",
            tmp: "/tmp",
            dev: &["/dev/llm", "/dev/rag", "/dev/world", "/dev/sys1"],
        },
    })
}

/// Resolve a Unix/GNU virtual path (`/etc/ai-os/...`, `/var/lib/ai-os/...`, `/dev/llm`, ...)
/// safely inside `home` without directory traversal.
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_vfs_resolve_json(
    home: *const c_char,
    vpath: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let home_str = unsafe { c_str(home) };
    let vpath_str = unsafe { c_str(vpath) };
    if home_str.is_empty() {
        return json_err("home path must not be empty");
    }
    let parts = match normalize_vpath(vpath_str) {
        Ok(p) => p,
        Err(e) => return json_err(e),
    };
    let head = parts.first().map(|s| s.as_str()).unwrap_or("");
    let (device, readonly, rel): (&str, bool, PathBuf) = match head {
        "dev" => {
            let sub = parts.get(1).map(|s| s.as_str()).unwrap_or("null");
            (sub, false, PathBuf::from("dev").join(sub))
        }
        "proc" => ("proc", true, parts.iter().collect()),
        "etc" | "var" | "tmp" | "home" => ("fs", false, parts.iter().collect()),
        _ => ("fs", false, parts.iter().collect()),
    };
    let host_path = Path::new(home_str).join(rel);
    json_ok(&VfsResolved {
        vpath: format!("/{}", parts.join("/")),
        host_path: host_path.to_string_lossy().into_owned(),
        device: device.to_owned(),
        readonly,
    })
}

/// Unified LLM ecosystem standard contract (runtime-discovered providers, zero hardcoded models).
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_llm_spec_json() -> *mut c_char {
    json_ok(&serde_json::json!({
        "discovery": "runtime",
        "hardcoded_models": false,
        "wire_protocols": ["openai-chat-completions", "anthropic-messages", "google-genai", "ollama"],
        "sdks": ["vercel-ai-v7", "rig-core", "mistralrs"],
        "device": "/dev/llm"
    }))
}

/// Upsert a document/memory/skill into the unified RAG SQLite store (`agent-context`).
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_rag_upsert_json(
    db_path: *const c_char,
    entry_json: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let db = unsafe { c_str(db_path) };
    let raw = unsafe { c_str(entry_json) };
    let req: RagUpsertReq = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(e) => return json_err(format!("invalid entry_json: {e}")),
    };
    let store = match Store::open(db) {
        Ok(s) => s,
        Err(e) => return json_err(format!("sqlite open failed: {e}")),
    };
    let entry = Entry {
        id: req.id.clone(),
        source: req.source,
        scope: req.scope,
        title: req.title,
        text: req.text,
        at: req.at.unwrap_or_else(now_ms),
    };
    if let Err(e) = store.ingest(&entry) {
        return json_err(format!("rag upsert failed: {e}"));
    }
    json_ok(&serde_json::json!({ "ok": true, "id": req.id }))
}

/// Query the unified RAG SQLite store (FTS5 BM25 + recency RRF).
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_rag_query_json(
    db_path: *const c_char,
    query_json: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let db = unsafe { c_str(db_path) };
    let raw = unsafe { c_str(query_json) };
    let req: RagQueryReq = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(e) => return json_err(format!("invalid query_json: {e}")),
    };
    let store = match Store::open(db) {
        Ok(s) => s,
        Err(e) => return json_err(format!("sqlite open failed: {e}")),
    };
    let mut sel = Select::new(req.k.max(1));
    sel.sources = req.sources;
    sel.scopes = req.scopes;
    match store.select(&req.query, &sel) {
        Ok(hits) => {
            let out: Vec<RagHit> = hits
                .into_iter()
                .map(|h| RagHit {
                    id: h.entry.id,
                    source: h.entry.source,
                    scope: h.entry.scope,
                    title: h.entry.title,
                    text: h.entry.text,
                    at: h.entry.at,
                    score: h.score,
                })
                .collect();
            json_ok(&out)
        }
        Err(e) => json_err(format!("rag query failed: {e}")),
    }
}

/// Record a World Model state transition, compute prediction error (surprise), and persist entity state.
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_world_step_json(
    db_path: *const c_char,
    step_json: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let db = unsafe { c_str(db_path) };
    let raw = unsafe { c_str(step_json) };
    let req: WorldStepReq = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(e) => return json_err(format!("invalid step_json: {e}")),
    };
    let conn = match open_os_db(db) {
        Ok(c) => c,
        Err(e) => return json_err(e),
    };
    let surprise = if req.predicted == req.observed { 0.0 } else { 1.0 };
    let ts = req.ts.unwrap_or_else(now_ms);
    let pred_str = req.predicted.to_string();
    let obs_str = req.observed.to_string();
    if let Err(e) = conn.execute(
        "INSERT INTO world_transitions(actor, action, target, predicted_json, observed_json, surprise, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![req.actor, req.action, req.target, pred_str, obs_str, surprise, ts],
    ) {
        return json_err(format!("world_transitions insert failed: {e}"));
    }
    if let Err(e) = conn.execute(
        "INSERT INTO world_entities(entity, state_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(entity) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at",
        params![req.target, obs_str, ts],
    ) {
        return json_err(format!("world_entities upsert failed: {e}"));
    }
    json_ok(&WorldStepRes {
        entity: req.target,
        surprise,
        escalate_sys2: surprise >= 0.5,
        state: req.observed,
    })
}

/// Read current World Model state for an entity (or all entities when `entity` is empty).
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_world_state_json(
    db_path: *const c_char,
    entity: *const c_char,
) -> *mut c_char {
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let db = unsafe { c_str(db_path) };
    let ent = unsafe { c_str(entity) };
    let conn = match open_os_db(db) {
        Ok(c) => c,
        Err(e) => return json_err(e),
    };
    if !ent.is_empty() {
        let res: Result<(String, i64), _> = conn.query_row(
            "SELECT state_json, updated_at FROM world_entities WHERE entity = ?1",
            params![ent],
            |r| Ok((r.get(0)?, r.get(1)?)),
        );
        return match res {
            Ok((state_raw, updated_at)) => {
                let state: serde_json::Value =
                    serde_json::from_str(&state_raw).unwrap_or(serde_json::Value::Null);
                json_ok(&serde_json::json!({ "entity": ent, "state": state, "updated_at": updated_at }))
            }
            Err(_) => json_err(format!("unknown world entity: {ent}")),
        };
    }
    let mut stmt = match conn.prepare("SELECT entity, state_json, updated_at FROM world_entities ORDER BY updated_at DESC") {
        Ok(s) => s,
        Err(e) => return json_err(e.to_string()),
    };
    let rows = match stmt.query_map([], |r| {
        let entity: String = r.get(0)?;
        let state_raw: String = r.get(1)?;
        let updated_at: i64 = r.get(2)?;
        let state: serde_json::Value =
            serde_json::from_str(&state_raw).unwrap_or(serde_json::Value::Null);
        Ok(serde_json::json!({ "entity": entity, "state": state, "updated_at": updated_at }))
    }) {
        Ok(iter) => iter.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(e) => return json_err(e.to_string()),
    };
    json_ok(&rows)
}

/// Fast (<1ms) System 1 decision router (`exec` | `escalate_sys2` | `deny`) with SQLite audit log.
#[unsafe(no_mangle)]
pub extern "C" fn ai_os_sys1_decide_json(
    db_path: *const c_char,
    req_json: *const c_char,
) -> *mut c_char {
    let t0 = Instant::now();
    // SAFETY: caller passes NUL-terminated strings valid for the call.
    let db = unsafe { c_str(db_path) };
    let raw = unsafe { c_str(req_json) };
    let req: Sys1DecideReq = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(e) => return json_err(format!("invalid req_json: {e}")),
    };
    let (decision, reason): (&'static str, String) = if !req.risk.is_finite()
        || !req.confidence.is_finite()
        || !req.world_surprise.is_finite()
    {
        ("deny", "non-finite decision input".into())
    } else if req.risk > 0.85 {
        ("deny", format!("risk {:.2} > 0.85 policy ceiling", req.risk))
    } else if req.confidence >= 0.85 && req.risk <= 0.25 && req.world_surprise < 0.5 {
        (
            "exec",
            format!(
                "system1 fast-path (conf={:.2}, risk={:.2}, surprise={:.2})",
                req.confidence, req.risk, req.world_surprise
            ),
        )
    } else {
        (
            "escalate_sys2",
            format!(
                "escalate to system2/LLM (conf={:.2}, risk={:.2}, surprise={:.2}, budget_ms={})",
                req.confidence,
                req.risk,
                req.world_surprise,
                req.latency_budget_ms.unwrap_or(0)
            ),
        )
    };
    let latency_us = t0.elapsed().as_micros() as u64;
    if !db.is_empty()
        && let Ok(conn) = open_os_db(db)
    {
        let _ = conn.execute(
            "INSERT INTO sys1_decisions(action, risk, confidence, surprise, decision, reason, latency_us, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                req.action,
                req.risk,
                req.confidence,
                req.world_surprise,
                decision,
                reason,
                latency_us as i64,
                now_ms()
            ],
        );
    }
    json_ok(&Sys1DecideRes {
        decision,
        reason,
        latency_us,
    })
}
