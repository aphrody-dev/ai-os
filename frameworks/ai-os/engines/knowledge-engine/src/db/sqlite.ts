import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_KNOWLEDGE_DB_PATH =
  process.platform === "win32"
    ? "C:\\aphrody\\var\\knowledge.sqlite"
    : "/src/var/knowledge.sqlite";

const dbPool = new Map<string, Database>();

export function openKnowledgeDatabase(
  dbPath: string = process.env.SKE_DB_PATH ?? DEFAULT_KNOWLEDGE_DB_PATH,
): Database {
  const resolved = dbPath === ":memory:" ? ":memory:" : resolve(dbPath);
  if (resolved !== ":memory:") {
    const existing = dbPool.get(resolved);
    if (existing) {
      return existing;
    }
    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolved, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA temp_store = MEMORY;");

  db.run(`
    CREATE TABLE IF NOT EXISTS context7_cache (
      cache_key TEXT PRIMARY KEY,
      endpoint_kind TEXT NOT NULL,
      library_id TEXT NOT NULL,
      query_text TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_context7_cache_expires
    ON context7_cache(expires_at_ms);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS research_dossiers (
      slug TEXT PRIMARY KEY,
      query_text TEXT NOT NULL,
      content_blake3 TEXT NOT NULL,
      dossier_path TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      tier1_count INTEGER NOT NULL,
      tier2_count INTEGER NOT NULL,
      tier3_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS factcheck_runs (
      target_hash TEXT PRIMARY KEY,
      target_label TEXT NOT NULL,
      verdict TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      claims_total INTEGER NOT NULL,
      verified_count INTEGER NOT NULL,
      contradicted_count INTEGER NOT NULL,
      unverified_count INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agy_session_reviews (
      session_id TEXT PRIMARY KEY,
      transcript_path TEXT NOT NULL,
      transcript_mtime_ms REAL NOT NULL,
      transcript_size INTEGER NOT NULL,
      artifacts_sig TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS live_turn_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      hook_phase TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      command_status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_live_turn_events_conv
    ON live_turn_events(conversation_id, created_at_ms);
  `);

  if (resolved !== ":memory:") {
    dbPool.set(resolved, db);
  }
  return db;
}

export function closeAllKnowledgeDatabases(): void {
  for (const [key, db] of dbPool.entries()) {
    try {
      db.close(false);
    } catch {
      // Ignore close errors
    }
    dbPool.delete(key);
  }
}
