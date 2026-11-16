// Persistent memory (Hermes memory_tool/memory_manager semantics, MIT, Nous Research).
// Storage and recall go through Context (attention-style selection); this class is the memory-scoped view.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Context, type Embedder } from "./context";
import { resolveEmbedder } from "./model";

const shared = new Map<string, { m: Memory; refs: number }>();

export class Memory {
  /** One open store per path, shared by concurrent users (gateway sessions, agent turns); closed when the last one releases. */
  static acquire(path: string): Memory {
    const key = path === ":memory:" ? path : resolve(path);
    const e = shared.get(key) ?? { m: new Memory(key), refs: 0 };
    e.refs++;
    shared.set(key, e);
    return e.m;
  }
  static release(m: Memory) {
    for (const [path, e] of shared)
      if (e.m === m && --e.refs <= 0) {
        shared.delete(path);
        m.close();
      }
  }

  readonly ctx: Context;
  /** Skills/docs indexing of this store: the last run (ms) and the one in flight (shared by concurrent turns). */
  indexedAt = 0;
  indexing?: Promise<void>;
  constructor(
    path: string,
    embedder: Embedder | undefined = resolveEmbedder(),
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true });
    this.ctx = new Context(path, embedder);
    this.ctx.db.run(
      "CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, task TEXT, result TEXT, steps INTEGER, at TEXT DEFAULT (datetime('now')))",
    );
    this.ctx.db.run(
      "CREATE TABLE IF NOT EXISTS memory_seq(n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER)",
    );
  }

  async add(content: string, scope = "user"): Promise<number> {
    const n = Number(
      this.ctx.db.query("INSERT INTO memory_seq(at) VALUES (?)").run(Date.now())
        .lastInsertRowid,
    );
    await this.ctx.ingest({
      id: `memory:${n}`,
      source: "memory",
      scope,
      text: content,
    });
    return n;
  }

  async search(q: string, limit = 8, scopes?: string[]): Promise<string[]> {
    const r = await this.ctx.select(q, {
      sources: ["memory"],
      scopes,
      k: limit,
      budgetTokens: 1e9,
      weights: { recency: 0.05 },
      redact: Bun.env,
    });
    return r.map((x) => x.text);
  }

  recent(limit = 8): string[] {
    return this.ctx.list({ sources: ["memory"] }, limit).map((e) => e.text);
  }

  logRun(task: string, result: string, steps: number) {
    this.ctx.db
      .query("INSERT INTO runs(task, result, steps) VALUES (?, ?, ?)")
      .run(task, result, steps);
  }

  close() {
    this.ctx.close();
  }
}
