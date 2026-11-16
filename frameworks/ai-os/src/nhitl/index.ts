// Index of NHITL (no human in the loop) violations: everything that makes a human wait (an agent's final question,
// interactive prompt, confirmation, sign-in click, task failing for lack of a credential, doc asking for a manual
// action). Store: <src>/var/agents/nhitl.sqlite (same root as the agent queue; NHITL_DB takes precedence), table `violation`
// + FTS5 `violation_fts`. Human triage (status, reason) lives in `triage` and survives rescans. No secret value:
// excerpts are short and passed through redact().
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { srcRoot } from "../orch/fleet";

export type Severity = "high" | "medium" | "low" | "info";
export type Status = "open" | "fixed" | "inevitable";
export type Source =
  | "transcript"
  | "settings"
  | "code"
  | "queue"
  | "docs"
  | "hook"
  | "ledger"
  | "review";

export type Violation = {
  id: string;
  source: Source;
  location: string;
  category: string;
  severity: Severity;
  excerpt: string;
  fix: string;
  status: Status;
  reason?: string;
  /** Rescan unit (file, host): entries of an unchanged unit are kept as is. */
  unit?: string;
};

export const dbPath = () =>
  Bun.env.NHITL_DB ?? join(srcRoot(), "var", "agents", "nhitl.sqlite");

export const fingerprint = (...parts: string[]) =>
  new Bun.CryptoHasher("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 16);

const SECRET_RES = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
  /\b(cfat|cfut|npm|glpat|hf|vercel)_[A-Za-z0-9_-]{16,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}/g,
];
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL|AUTH/i;
let envValues: string[] | undefined;

/** Short excerpt without secrets: known token patterns, values of sensitive environment variables, 160 chars max. */
export function redact(text: string, max = 160): string {
  const s = scrub(text.replace(/\s+/g, " ").trim());
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Same patterns as redact(), formatting preserved (ai-os review: content sent to the engines and archived). */
export function scrub(text: string): string {
  envValues ??= Object.entries(Bun.env)
    .filter(([k, v]) => SECRET_NAME.test(k) && v && v.length >= 12)
    .map(([, v]) => v!);
  let s = text;
  for (const v of envValues) s = s.split(v).join("[secret]");
  for (const re of SECRET_RES) s = s.replace(re, "[secret]");
  return s;
}

export class Index {
  readonly db: Database;
  constructor(path = dbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(`CREATE TABLE IF NOT EXISTS violation(
      id TEXT PRIMARY KEY, source TEXT, location TEXT, category TEXT, severity TEXT, excerpt TEXT, fix TEXT,
      status TEXT, reason TEXT, unit TEXT, first_seen TEXT, last_seen TEXT)`);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS violation_sc ON violation(source, category)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS triage(id TEXT PRIMARY KEY, status TEXT, reason TEXT, at TEXT)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS unit_cache(unit TEXT PRIMARY KEY, stamp TEXT)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS scan(at TEXT, source TEXT, n INTEGER, ms INTEGER, error TEXT)",
    );
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS violation_fts USING fts5(id UNINDEXED, source, location, category, excerpt, fix, tokenize='unicode61 remove_diacritics 2')",
    );
  }

  stamp(unit: string): string | undefined {
    return (
      this.db
        .query<{ stamp: string }, [string]>(
          "SELECT stamp FROM unit_cache WHERE unit = ?",
        )
        .get(unit)?.stamp ?? undefined
    );
  }

  /** Ids already indexed for an unchanged unit (kept when the source is replaced). */
  idsOf(source: Source, unit: string): string[] {
    return this.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM violation WHERE source = ? AND unit = ?",
      )
      .all(source, unit)
      .map((r) => r.id);
  }

  /** Replaces the entries of a source: upsert of `items`, keep `keep`, delete the rest. */
  replace(
    source: Source,
    items: Violation[],
    keep: string[] = [],
    stamps: Record<string, string> = {},
  ) {
    const now = new Date().toISOString();
    const up = this.db
      .prepare(`INSERT INTO violation VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET location=excluded.location, category=excluded.category, severity=excluded.severity,
      excerpt=excluded.excerpt, fix=excluded.fix, status=excluded.status, reason=excluded.reason, unit=excluded.unit,
      last_seen=excluded.last_seen`);
    this.db.transaction(() => {
      const seen = new Set(keep);
      for (const v of items) {
        seen.add(v.id);
        up.run(
          v.id,
          v.source,
          v.location,
          v.category,
          v.severity,
          v.excerpt,
          v.fix,
          v.status,
          v.reason ?? null,
          v.unit ?? null,
          now,
          now,
        );
      }
      const old = this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM violation WHERE source = ?",
        )
        .all(source);
      const del = this.db.prepare("DELETE FROM violation WHERE id = ?");
      for (const { id } of old) if (!seen.has(id)) del.run(id);
      for (const [u, s] of Object.entries(stamps))
        this.db
          .query("INSERT OR REPLACE INTO unit_cache VALUES (?, ?)")
          .run(u, s);
      this.db.query("DELETE FROM violation_fts WHERE source = ?").run(source);
      this.db
        .query(
          "INSERT INTO violation_fts SELECT id, source, location, category, excerpt, fix FROM violation WHERE source = ?",
        )
        .run(source);
    })();
  }

  /** Upsert of a single entry, without touching the other entries of its source (ai-os review: missing engine). */
  record(v: Violation) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO violation VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET excerpt=excluded.excerpt, fix=excluded.fix, status=excluded.status,
          severity=excluded.severity, last_seen=excluded.last_seen`,
        )
        .run(
          v.id,
          v.source,
          v.location,
          v.category,
          v.severity,
          redact(v.excerpt),
          v.fix,
          v.status,
          v.reason ?? null,
          v.unit ?? null,
          now,
          now,
        );
      this.db.query("DELETE FROM violation_fts WHERE id = ?").run(v.id);
      this.db
        .query(
          "INSERT INTO violation_fts SELECT id, source, location, category, excerpt, fix FROM violation WHERE id = ?",
        )
        .run(v.id);
    })();
  }

  logScan(source: string, n: number, ms: number, error?: string) {
    this.db
      .query("INSERT INTO scan VALUES (?,?,?,?,?)")
      .run(new Date().toISOString(), source, n, ms, error ?? null);
  }

  triage(id: string, status: Status, reason?: string) {
    this.db
      .query("INSERT OR REPLACE INTO triage VALUES (?,?,?,?)")
      .run(id, status, reason ?? null, new Date().toISOString());
  }

  /** Effective view: human triage takes precedence over the status computed by the scanner. */
  list(
    o: {
      source?: string;
      category?: string;
      status?: string;
      severity?: string;
      q?: string;
      limit?: number;
    } = {},
  ) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.source) (where.push("v.source = ?"), args.push(o.source));
    if (o.category) (where.push("v.category = ?"), args.push(o.category));
    if (o.severity) (where.push("v.severity = ?"), args.push(o.severity));
    if (o.status)
      (where.push("coalesce(t.status, v.status) = ?"), args.push(o.status));
    if (o.q)
      (where.push(
        "v.id IN (SELECT id FROM violation_fts WHERE violation_fts MATCH ?)",
      ),
        args.push(o.q));
    args.push(o.limit ?? 200);
    return this.db
      .query(
        `SELECT v.id, v.source, v.location, v.category, v.severity, coalesce(t.status, v.status) AS status,
        coalesce(t.reason, v.reason) AS reason, v.excerpt, v.fix, v.first_seen, v.last_seen
        FROM violation v LEFT JOIN triage t ON t.id = v.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY CASE v.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, v.last_seen DESC
        LIMIT ?`,
      )
      .all(...args);
  }

  stats() {
    const q = (sql: string) => this.db.query(sql).all();
    const eff =
      "FROM violation v LEFT JOIN triage t ON t.id = v.id GROUP BY 1, 2 ORDER BY 1, 3 DESC";
    return {
      db: this.db.filename,
      total: (this.db.query("SELECT count(*) AS n FROM violation").get() as any)
        .n,
      byCategory: q(
        `SELECT v.category, coalesce(t.status, v.status) AS status, count(*) AS n ${eff}`,
      ),
      bySource: q(
        "SELECT source, severity, count(*) AS n FROM violation GROUP BY 1, 2 ORDER BY 1",
      ),
      lastScan: q(
        "SELECT source, max(at) AS at, n, ms, error FROM scan GROUP BY source ORDER BY source",
      ),
    };
  }

  close() {
    this.db.close();
  }
}
