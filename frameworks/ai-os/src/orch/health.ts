// Engine health memory per (host, provider): observed outcomes and cooldowns, like the LiteLLM router
// cooldowns (allowed_fails, cooldown_time) and OpenRouter's reliability/latency sort, but learned locally.
// Store: $AGENT_HOME/orch.sqlite (WAL, busy_timeout). No default value pinned to a provider.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cooldownMs, type FailClass } from "./classify";

export type Stats = { n: number; ok: number; p50: number };

export class Health {
  readonly db: Database;
  constructor(path = defaultPath()) {
    mkdirSync(join(path, ".."), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS outcome(host TEXT, provider TEXT, ok INTEGER, class TEXT, ms INTEGER, at INTEGER)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS outcome_hp ON outcome(host, provider, at)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS cooldown(host TEXT, provider TEXT, until INTEGER, class TEXT, fails INTEGER, PRIMARY KEY(host, provider))",
    );
  }

  record(
    host: string,
    provider: string,
    ok: boolean,
    cls: FailClass | null,
    ms: number,
    now = Date.now(),
  ) {
    this.db
      .query("INSERT INTO outcome VALUES (?, ?, ?, ?, ?, ?)")
      .run(host, provider, ok ? 1 : 0, cls, ms, now);
    if (Math.random() < 0.02)
      this.db.query("DELETE FROM outcome WHERE at <= ?").run(now - 30 * 864e5);
    if (ok) {
      this.db
        .query("DELETE FROM cooldown WHERE host = ? AND provider = ?")
        .run(host, provider);
      return;
    }
    const prev =
      this.db
        .query<{ fails: number }, [string, string]>(
          "SELECT fails FROM cooldown WHERE host = ? AND provider = ?",
        )
        .get(host, provider)?.fails ?? 0;
    const ms2 = cls ? cooldownMs(cls, prev + 1) : 0;
    if (ms2 > 0)
      this.db
        .query("INSERT OR REPLACE INTO cooldown VALUES (?, ?, ?, ?, ?)")
        .run(host, provider, now + ms2, cls, prev + 1);
  }

  /** Class of the current cooldown, otherwise null. */
  cooling(host: string, provider: string, now = Date.now()): string | null {
    return (
      this.db
        .query<{ class: string }, [string, string, number]>(
          "SELECT class FROM cooldown WHERE host = ? AND provider = ? AND until > ?",
        )
        .get(host, provider, now)?.class ?? null
    );
  }

  /** Outcomes of the last 7 days. */
  stats(host: string, provider: string, now = Date.now()): Stats {
    const rows = this.db
      .query<{ ok: number; ms: number }, [string, string, number]>(
        "SELECT ok, ms FROM outcome WHERE host = ? AND provider = ? AND at > ? ORDER BY ms",
      )
      .all(host, provider, now - 7 * 864e5);
    // Latency measured on successes only: an engine that fails fast must not look fast.
    const okRows = rows.filter((r) => r.ok);
    return {
      n: rows.length,
      ok: okRows.length,
      p50: okRows.length ? okRows[okRows.length >> 1]!.ms : 0,
    };
  }

  close() {
    this.db.close();
  }
}

const defaultPath = () =>
  join(Bun.env.AGENT_HOME ?? join(homedir(), ".agent"), "orch.sqlite");
