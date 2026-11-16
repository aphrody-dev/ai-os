// Router state in bun:sqlite (relayHome()/router.db): per-offer call stats with exponential health decay, arena pairs and
// votes, Elo per model, spend and budget per caller. Pure helpers (decay, elo) are exported for the unit tests.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { relayHome } from "../relay/cdp.ts";

export const HALF_LIFE_MS = 10 * 60_000;
export const ELO_BASE = 1000;
export const ELO_K = 32;

/** Weight of an observation of age `ageMs`: halves every `halfLife`. */
export const decay = (ageMs: number, halfLife = HALF_LIFE_MS) =>
  0.5 ** (Math.max(0, ageMs) / halfLife);

/** Elo update for a battle: score 1 = a wins, 0 = b wins, 0.5 = tie. */
export function eloUpdate(ra: number, rb: number, score: number, k = ELO_K) {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  return [ra + k * (score - ea), rb + k * (1 - score - (1 - ea))] as const;
}

export type Call = {
  ts: number;
  offer: string;
  ok: boolean;
  status: number;
  ms: number;
  inTok: number;
  outTok: number;
  cost: number;
  caller: string;
  err?: string;
};
export type OfferStat = {
  /** Decayed success / failure weights. */
  ok: number;
  err: number;
  /** Health in [0,1]: 1 = nothing known or all good. */
  health: number;
  p50?: number;
  calls: number;
  errors: number;
  tokens: number;
  cost: number;
  coolUntil: number;
  lastErr?: string;
};
export type Pair = {
  id: string;
  ts: number;
  prompt: string;
  a: string;
  b: string;
  ansA: string;
  ansB: string;
  winner?: string;
  by?: string;
};

export class Store {
  readonly db: Database;
  private cool = new Map<string, number>();
  constructor(path?: string) {
    if (path === undefined) {
      mkdirSync(relayHome(), { recursive: true });
      path = join(relayHome(), "router.db");
    }
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db
      .run(`CREATE TABLE IF NOT EXISTS calls(ts INTEGER, offer TEXT, ok INTEGER, status INTEGER, ms INTEGER, in_tok INTEGER, out_tok INTEGER, cost REAL, caller TEXT, err TEXT);
      CREATE INDEX IF NOT EXISTS calls_offer ON calls(offer, ts);
      CREATE INDEX IF NOT EXISTS calls_caller ON calls(caller);
      CREATE TABLE IF NOT EXISTS pairs(id TEXT PRIMARY KEY, ts INTEGER, prompt TEXT, a TEXT, b TEXT, ans_a TEXT, ans_b TEXT, winner TEXT, by TEXT);
      CREATE TABLE IF NOT EXISTS elo(model TEXT PRIMARY KEY, rating REAL, battles INTEGER, wins INTEGER);
      CREATE TABLE IF NOT EXISTS budgets(caller TEXT PRIMARY KEY, budget REAL);
      CREATE TABLE IF NOT EXISTS catalog(k TEXT PRIMARY KEY, ts INTEGER, json TEXT);`);
  }
  close() {
    this.db.close();
  }

  record(c: Call) {
    this.db
      .query("INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        c.ts,
        c.offer,
        c.ok ? 1 : 0,
        c.status,
        Math.round(c.ms),
        c.inTok,
        c.outTok,
        c.cost,
        c.caller,
        c.err?.slice(0, 300) ?? null,
      );
  }
  /** Offer unusable until `until` (429 Retry-After, auth failure, 5xx burst). */
  cooldown(offer: string, until: number) {
    this.cool.set(offer, until);
  }

  /** Stats of all offers from the calls of the last 24 h, each weighted by exponential decay. */
  stats(now = Date.now(), halfLife = HALF_LIFE_MS): Map<string, OfferStat> {
    const rows = this.db
      .query(
        "SELECT ts, offer, ok, ms, in_tok, out_tok, cost, err FROM calls WHERE ts > ? ORDER BY ts",
      )
      .all(now - 86_400_000) as any[];
    const m = new Map<string, OfferStat & { lat: number[] }>();
    for (const r of rows) {
      const s = m.get(r.offer) ?? {
        ok: 0,
        err: 0,
        health: 1,
        calls: 0,
        errors: 0,
        tokens: 0,
        cost: 0,
        coolUntil: 0,
        lat: [],
      };
      const w = decay(now - r.ts, halfLife);
      if (r.ok) {
        s.ok += w;
        s.lat.push(r.ms);
      } else {
        s.err += w;
        s.errors++;
        s.lastErr = r.err ?? undefined;
      }
      s.calls++;
      s.tokens += r.in_tok + r.out_tok;
      s.cost += r.cost;
      m.set(r.offer, s);
    }
    for (const [o, until] of this.cool) {
      const s = m.get(o);
      if (until > now)
        (
          s ??
          m
            .set(o, {
              ok: 0,
              err: 0,
              health: 1,
              calls: 0,
              errors: 0,
              tokens: 0,
              cost: 0,
              coolUntil: 0,
              lat: [],
            })
            .get(o)!
        ).coolUntil = until;
      else this.cool.delete(o);
    }
    for (const s of m.values()) {
      // Laplace-smoothed success share of the decayed weights: an unknown offer is healthy, old errors fade.
      s.health = (s.ok + 1) / (s.ok + s.err + 1);
      const l = [...s.lat].slice(-30).sort((a, b) => a - b);
      s.p50 = l.length ? l[Math.floor(l.length / 2)] : undefined;
      delete (s as any).lat;
    }
    return m;
  }

  // ---- arena
  savePair(p: Pair) {
    this.db
      .query(
        "INSERT INTO pairs(id,ts,prompt,a,b,ans_a,ans_b) VALUES(?,?,?,?,?,?,?)",
      )
      .run(p.id, p.ts, p.prompt.slice(0, 4000), p.a, p.b, p.ansA, p.ansB);
  }
  pair(id: string): Pair | undefined {
    const r = this.db.query("SELECT * FROM pairs WHERE id=?").get(id) as any;
    return (
      r && {
        id: r.id,
        ts: r.ts,
        prompt: r.prompt,
        a: r.a,
        b: r.b,
        ansA: r.ans_a,
        ansB: r.ans_b,
        winner: r.winner ?? undefined,
        by: r.by ?? undefined,
      }
    );
  }
  /** Records a vote once per pair; returns the new ratings. `winner` is "a", "b" or "tie". */
  vote(id: string, winner: "a" | "b" | "tie", by: string) {
    const p = this.pair(id);
    if (!p) throw new Error(`unknown pair: ${id}`);
    if (p.winner) throw new Error(`pair ${id} already voted (${p.winner})`);
    this.db
      .query("UPDATE pairs SET winner=?, by=? WHERE id=?")
      .run(winner, by, id);
    const get = (m: string) =>
      (this.db.query("SELECT * FROM elo WHERE model=?").get(m) as any) ?? {
        rating: ELO_BASE,
        battles: 0,
        wins: 0,
      };
    const A = get(p.a);
    const B = get(p.b);
    const s = winner === "a" ? 1 : winner === "b" ? 0 : 0.5;
    const [ra, rb] = eloUpdate(A.rating, B.rating, s);
    const put = this.db.query(
      "INSERT INTO elo VALUES(?,?,?,?) ON CONFLICT(model) DO UPDATE SET rating=excluded.rating, battles=excluded.battles, wins=excluded.wins",
    );
    put.run(p.a, ra, A.battles + 1, A.wins + (winner === "a" ? 1 : 0));
    put.run(p.b, rb, B.battles + 1, B.wins + (winner === "b" ? 1 : 0));
    return { pair: p, ratings: { [p.a]: ra, [p.b]: rb } };
  }
  elo(): { model: string; rating: number; battles: number; wins: number }[] {
    return this.db
      .query("SELECT * FROM elo ORDER BY rating DESC")
      .all() as any[];
  }

  // ---- spend and budget per caller
  spent(caller: string) {
    return (
      this.db
        .query("SELECT COALESCE(SUM(cost),0) c FROM calls WHERE caller=?")
        .get(caller) as any
    ).c as number;
  }
  budget(caller: string): number | undefined {
    const r = this.db
      .query("SELECT budget FROM budgets WHERE caller=?")
      .get(caller) as any;
    return r?.budget ?? undefined;
  }
  setBudget(caller: string, usd: number | null) {
    if (usd === null)
      this.db.query("DELETE FROM budgets WHERE caller=?").run(caller);
    else
      this.db
        .query(
          "INSERT INTO budgets VALUES(?,?) ON CONFLICT(caller) DO UPDATE SET budget=excluded.budget",
        )
        .run(caller, usd);
  }
  callers() {
    return this.db
      .query(
        "SELECT caller, COUNT(*) calls, SUM(in_tok+out_tok) tokens, SUM(cost) cost FROM calls GROUP BY caller ORDER BY cost DESC",
      )
      .all() as {
      caller: string;
      calls: number;
      tokens: number;
      cost: number;
    }[];
  }

  // ---- catalog cache
  cacheGet<T>(k: string): { ts: number; value: T } | undefined {
    const r = this.db
      .query("SELECT ts, json FROM catalog WHERE k=?")
      .get(k) as any;
    return r && { ts: r.ts, value: JSON.parse(r.json) as T };
  }
  cachePut(k: string, v: unknown) {
    this.db
      .query(
        "INSERT INTO catalog VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET ts=excluded.ts, json=excluded.json",
      )
      .run(k, Date.now(), JSON.stringify(v));
  }
}
