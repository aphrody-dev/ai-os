// Context = attention-style selection (design rules: var/data/ai_foundations_to_agi/attention_is_all_you_need_full_llm_markdown.md §7).
// Encoder: ingest() indexes memories, skills, research results and code chunks into one bun:sqlite store.
// Heads (parallel): lexical (FTS5 bm25), semantic (embeddings, cached = KV-cache), structural (symbol graph overlap),
// recency (exponential decay). Each head's scores go through a temperature softmax; heads merge linearly (weights).
// Masks: scope allowlist + predicate (permission) applied before scoring; secrets redacted on the way out.
// Output: top-k entries under a token budget. Every memory/skill/context read in the agent goes through select().
import { Database } from "bun:sqlite";
import type { Embedder } from "../llm/types";
import { redactText } from "./secrets";

export type { Embedder } from "../llm/types";
export type Source =
  "memory" | "skill" | "research" | "code" | "doc" | (string & {});
export type Entry = {
  id: string;
  source: Source;
  scope: string;
  text: string;
  title?: string;
  symbols?: string[];
  at: number;
};
export type Scored = Entry & {
  score: number;
  heads: Record<string, number>;
  tokens: number;
};

export function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Offline embedder: signed feature hashing of word unigrams + char trigrams, L2-normalized. Deterministic, no network. */
export const hashEmbedder = (dim = 512): Embedder => ({
  id: `hash${dim}`,
  embed: async (texts) =>
    texts.map((t) => {
      const v = new Array<number>(dim).fill(0);
      const s = t.toLowerCase();
      const feats = [...(s.match(/[\p{L}\p{N}_]+/gu) ?? [])];
      for (const w of [...feats])
        for (let i = 0; i + 3 <= w.length; i++)
          feats.push(`#${w.slice(i, i + 3)}`);
      for (const f of feats) {
        const h = Number(Bun.hash.wyhash(f) & 0xffffffffn);
        v[h % dim]! += h & 0x80000000 ? -1 : 1;
      }
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
      return v.map((x) => x / n);
    }),
});

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
/** Characters of an entry's text that renderContext keeps; the token budget counts the same slice. */
export const RENDER_CHARS = 1200;

export type Mask = {
  scopes?: string[];
  sources?: Source[];
  allow?: (e: Entry) => boolean;
};
export type SelectOptions = Mask & {
  k?: number;
  budgetTokens?: number;
  weights?: Partial<
    Record<"lexical" | "semantic" | "structural" | "recency", number>
  >;
  temperature?: number;
  /** rrf (default): weighted reciprocal-rank fusion; logit: weighted sum of standardized scores, softmax. */
  fusion?: "rrf" | "logit";
  rrfK?: number;
  halfLifeDays?: number;
  candidates?: number;
  now?: number;
  redact?: Record<string, string | undefined>;
};

// Learned on the research pack (bench/retrieval.ts --tune, bge-m3): RRF lexical 0.2 / semantic 0.8; small structural + recency share.
const DEFAULT_WEIGHTS = {
  lexical: 0.2,
  semantic: 0.7,
  structural: 0.05,
  recency: 0.05,
};

/** Standardize a head (plays the role of the 1/sqrt(d_k) scaling: keeps heads comparable, softmax unsaturated). */
function standardize(xs: Map<string, number>): Map<string, number> {
  const vals = [...xs.values()];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd =
    Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  return new Map([...xs].map(([k, v]) => [k, (v - mean) / sd]));
}

function softmax(xs: Map<string, number>, t: number): Map<string, number> {
  if (xs.size === 0) return xs;
  const z = [...standardize(xs)].map(([k, v]) => [k, v / t] as const);
  const m = Math.max(...z.map(([, v]) => v));
  const e = z.map(([k, v]) => [k, Math.exp(v - m)] as const);
  const sum = e.reduce((a, [, v]) => a + v, 0);
  return new Map(e.map(([k, v]) => [k, v / sum]));
}

const identifiers = (s: string) =>
  new Set(
    (s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).map((x) => x.toLowerCase()),
  );

/** SQL form of the scope/source mask (same rule as `visible`: exact scope, `scope:` prefix, or `*`). */
function maskSql(m: Mask, col: string): [string, (string | number)[]] {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (m.scopes && !m.scopes.includes("*")) {
    if (m.scopes.length === 0) return ["0", []];
    // `s` or `s:*` as an index range: ';' (0x3B) is the code point right after ':' (0x3A).
    parts.push(
      `(${m.scopes.map(() => `${col}scope = ? OR (${col}scope >= ? AND ${col}scope < ?)`).join(" OR ")})`,
    );
    for (const s of m.scopes) params.push(s, `${s}:`, `${s};`);
  }
  if (m.sources) {
    if (m.sources.length === 0) return ["0", []];
    parts.push(`${col}source IN (${m.sources.map(() => "?").join(", ")})`);
    params.push(...m.sources);
  }
  return [parts.join(" AND "), params];
}

export class Context {
  readonly db: Database;
  constructor(
    path: string,
    readonly embedder: Embedder | undefined = hashEmbedder(),
  ) {
    this.db = new Database(path, { create: true });
    // Concurrent agents share the store: wait on locks instead of SQLITE_BUSY.
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS entries(rid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL, title TEXT, text TEXT NOT NULL, symbols TEXT, at INTEGER NOT NULL)",
    );
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(title, text, content='entries', content_rowid='rid', tokenize='porter unicode61')",
    );
    this.db.run(
      "CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(rowid, title, text) VALUES (new.rid, new.title, new.text); END",
    );
    this.db.run(
      "CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN INSERT INTO entries_fts(entries_fts, rowid, title, text) VALUES ('delete', old.rid, old.title, old.text); END",
    );
    this.db.run(
      "CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN INSERT INTO entries_fts(entries_fts, rowid, title, text) VALUES ('delete', old.rid, old.title, old.text); INSERT INTO entries_fts(rowid, title, text) VALUES (new.rid, new.title, new.text); END",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS entries_at ON entries(at DESC, rid DESC)",
    );
    this.db.run("DROP INDEX IF EXISTS entries_scope");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS entries_scope_at ON entries(scope, at DESC, rid DESC)",
    );
    this.db.run("CREATE INDEX IF NOT EXISTS entries_source ON entries(source)");
    // KV-cache: embeddings keyed by (embedder, content hash); recompute only on change.
    this.db.run(
      "CREATE TABLE IF NOT EXISTS kv(embedder TEXT, hash TEXT, vec BLOB, PRIMARY KEY(embedder, hash))",
    );
  }

  /** Encoder: upsert entries (id is stable, e.g. `memory:12`, `skill:deploy`, `research:topic/item#field`). */
  async ingest(
    entries: Omit<Entry, "at">[] | Omit<Entry, "at">,
    at = Date.now(),
  ) {
    const list = Array.isArray(entries) ? entries : [entries];
    const up = this.db.query(
      "INSERT INTO entries(id, source, scope, title, text, symbols, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source=excluded.source, scope=excluded.scope, title=excluded.title, text=excluded.text, symbols=excluded.symbols, at=excluded.at",
    );
    this.db.transaction(() => {
      for (const e of list)
        up.run(
          e.id,
          e.source,
          e.scope,
          e.title ?? null,
          e.text,
          e.symbols ? JSON.stringify(e.symbols) : null,
          at,
        );
    })();
    if (this.embedder) await this.vectors(list.map((e) => this.embedText(e)));
  }

  remove(id: string) {
    this.db.query("DELETE FROM entries WHERE id = ?").run(id);
  }

  get(id: string): Entry | undefined {
    const r = this.db
      .query<any, [string]>("SELECT * FROM entries WHERE id = ?")
      .get(id);
    return r ? this.row(r) : undefined;
  }

  /** Most recent visible entries. Scopes and sources filter in SQL (before LIMIT); `allow` pages
   * with a keyset cursor (at, rid) inside one read transaction, so concurrent writers neither
   * duplicate nor skip rows. */
  list(mask: Mask = {}, limit = 1000): Entry[] {
    const [where, params] = maskSql(mask, "");
    const cond = (extra: string) =>
      [where, extra].filter(Boolean).join(" AND ") || "1";
    const first = this.db.query<any, (string | number)[]>(
      `SELECT * FROM entries WHERE ${cond("")} ORDER BY at DESC, rid DESC LIMIT ?`,
    );
    const next = this.db.query<any, (string | number)[]>(
      `SELECT * FROM entries WHERE ${cond("(at < ? OR (at = ? AND rid < ?))")} ORDER BY at DESC, rid DESC LIMIT ?`,
    );
    return this.db.transaction(() => {
      const out: Entry[] = [];
      let rows = first.all(...params, limit);
      while (rows.length) {
        for (const r of rows) {
          const e = this.row(r);
          if (!mask.allow || mask.allow(e)) out.push(e);
          if (out.length === limit) return out;
        }
        if (rows.length < limit || !mask.allow) break;
        const last = rows[rows.length - 1];
        rows = next.all(...params, last.at, last.at, last.rid, limit);
      }
      return out;
    })();
  }

  private row(r: any): Entry {
    return {
      id: r.id,
      source: r.source,
      scope: r.scope,
      title: r.title ?? undefined,
      text: r.text,
      symbols: r.symbols ? JSON.parse(r.symbols) : undefined,
      at: r.at,
    };
  }
  private embedText(e: Pick<Entry, "title" | "text">) {
    return `${e.title ?? ""}\n${e.text}`.slice(0, 8000);
  }
  /** Whether an entry passes a mask (same rule as the SQL filter plus the `allow` predicate). */
  visible(e: Entry, m: Mask) {
    if (
      m.scopes &&
      !m.scopes.some(
        (s) => e.scope === s || e.scope.startsWith(`${s}:`) || s === "*",
      )
    )
      return false;
    if (m.sources && !m.sources.includes(e.source)) return false;
    return m.allow ? m.allow(e) : true;
  }

  private async vectors(texts: string[]): Promise<number[][]> {
    const emb = this.embedder!;
    const hashes = texts.map((t) =>
      new Bun.CryptoHasher("sha256").update(t).digest("hex"),
    );
    const get = this.db.query<{ vec: Uint8Array }, [string, string]>(
      "SELECT vec FROM kv WHERE embedder = ? AND hash = ?",
    );
    const out: (number[] | undefined)[] = hashes.map((h) => {
      const r = get.get(emb.id, h);
      return r ? Array.from(new Float32Array(r.vec.slice().buffer)) : undefined;
    });
    const miss = out.flatMap((v, i) => (v ? [] : [i]));
    if (miss.length) {
      const fresh = await emb.embed(miss.map((i) => texts[i]!));
      const put = this.db.query(
        "INSERT OR REPLACE INTO kv(embedder, hash, vec) VALUES (?, ?, ?)",
      );
      this.db.transaction(() => {
        miss.forEach((i, j) => {
          out[i] = fresh[j]!;
          put.run(
            emb.id,
            hashes[i]!,
            new Uint8Array(new Float32Array(fresh[j]!).buffer),
          );
        });
      })();
    }
    return out as number[][];
  }

  /** Attention: score visible entries with every head, softmax per head, weighted merge, top-k under budget. */
  async select(query: string, o: SelectOptions = {}): Promise<Scored[]> {
    const now = o.now ?? Date.now();
    const w = { ...DEFAULT_WEIGHTS, ...o.weights };
    const t = Math.max(o.temperature ?? 1, 1e-6);
    const nCand = o.candidates ?? 200;
    const heads: Record<string, Map<string, number>> = {};
    const pool = new Map<string, Entry>();
    const take = (e: Entry) => this.visible(e, o) && (pool.set(e.id, e), true);

    // lexical head: FTS5 bm25 (lower is better -> negate)
    const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
      .filter((x) => x.length > 1)
      .map((x) => `"${x.replace(/"/g, "")}"`);
    const lex = new Map<string, number>();
    if (terms.length && w.lexical > 0) {
      const [where, params] = maskSql(o, "e.");
      const rows = this.db
        .query<any, (string | number)[]>(
          `SELECT e.*, bm25(entries_fts, 2.0, 1.0) AS s FROM entries_fts JOIN entries e ON e.rid = entries_fts.rowid WHERE entries_fts MATCH ?${where ? ` AND ${where}` : ""} ORDER BY s LIMIT ?`,
        )
        .all(terms.join(" OR "), ...params, nCand);
      for (const r of rows) if (take(this.row(r))) lex.set(r.id, -r.s);
    }
    // recency + structural + semantic candidates come from the most recent visible entries plus lexical hits
    for (const e of this.list(o, nCand)) pool.set(e.id, e);
    const ids = [...pool.keys()];
    if (ids.length === 0) return [];
    if (lex.size) {
      const lexHits = new Set(lex.keys());
      heads.__lexHits = new Map([...lexHits].map((k) => [k, 1]));
      const floor = Math.min(...lex.values());
      for (const id of ids) if (!lex.has(id)) lex.set(id, floor - 1);
      heads.lexical = lex;
    }
    if (this.embedder && w.semantic > 0) {
      const [qv, ...vs] = await this.vectors([
        query,
        ...ids.map((id) => this.embedText(pool.get(id)!)),
      ]);
      heads.semantic = new Map(
        ids.map((id, i) => [id, cosineSimilarity(qv!, vs[i]!)]),
      );
    }
    if (w.structural > 0) {
      const q = identifiers(query);
      const st = new Map<string, number>();
      for (const id of ids) {
        const e = pool.get(id)!;
        const syms = e.symbols?.length
          ? new Set(e.symbols.map((s) => s.toLowerCase()))
          : undefined;
        if (!syms) continue;
        let hit = 0;
        for (const s of q) if (syms.has(s)) hit++;
        st.set(id, hit);
      }
      if ([...st.values()].some((v) => v > 0)) {
        for (const id of ids) if (!st.has(id)) st.set(id, 0);
        heads.structural = st;
      }
    }
    if (w.recency > 0) {
      const hl = (o.halfLifeDays ?? 14) * 86_400_000;
      heads.recency = new Map(
        ids.map((id) => [
          id,
          Math.pow(0.5, Math.max(0, now - pool.get(id)!.at) / hl),
        ]),
      );
    }

    const lexHitSet = new Set(heads.__lexHits?.keys() ?? []);
    delete heads.__lexHits;
    // Concat heads + linear merge in logit space (weights = W^O), then one softmax over candidates.
    const W = w as Record<string, number>;
    const wsum = Object.keys(heads).reduce((a, h) => a + W[h]!, 0) || 1;
    const z = Object.fromEntries(
      Object.entries(heads).map(([h, m]) => [h, standardize(m)]),
    );
    const logits = new Map(
      ids.map((id) => [
        id,
        Object.keys(z).reduce(
          (a, h) => a + (W[h]! / wsum) * (z[h]!.get(id) ?? 0),
          0,
        ),
      ]),
    );
    let attn = softmax(logits, t);
    if ((o.fusion ?? "rrf") === "rrf") {
      // Weighted RRF: each head ranks candidates; score = sum_h w_h / (k + rank_h). Lexical ranks only its real hits.
      const k0 = o.rrfK ?? 60;
      const fused = new Map(ids.map((id) => [id, 0]));
      for (const [h, m] of Object.entries(heads)) {
        const hits =
          h === "lexical" ? [...m].filter(([id]) => lexHitSet.has(id)) : [...m];
        hits
          .sort((a, b) => b[1] - a[1])
          .forEach(([id], r) =>
            fused.set(id, fused.get(id)! + W[h]! / wsum / (k0 + r + 1)),
          );
      }
      const total = [...fused.values()].reduce((a, b) => a + b, 0) || 1;
      attn = new Map([...fused].map(([id, v]) => [id, v / total]));
    }
    const probs = Object.fromEntries(
      Object.entries(heads).map(([h, m]) => [h, softmax(m, t)]),
    );
    const scored: Scored[] = ids.map((id) => {
      const e = pool.get(id)!;
      const hs: Record<string, number> = {};
      for (const [h, p] of Object.entries(probs)) hs[h] = p.get(id) ?? 0;
      const text = redactText(e.text, o.redact ?? {});
      return {
        ...e,
        text,
        score: attn.get(id) ?? 0,
        heads: hs,
        tokens: estimateTokens(
          `${e.title ?? ""} ${text.replace(/\s+/g, " ").slice(0, RENDER_CHARS)}`,
        ),
      };
    });
    scored.sort((a, b) => b.score - a.score);
    const k = o.k ?? 8;
    const budget = o.budgetTokens ?? 4000;
    const out: Scored[] = [];
    let used = 0;
    for (const s of scored) {
      if (out.length >= k) break;
      if (used + s.tokens > budget) continue;
      out.push(s);
      used += s.tokens;
    }
    return out;
  }

  close() {
    this.db.close();
  }
}

/** Strip newlines and '#' so untrusted source/title cannot inject Markdown headers into the prompt. */
const oneLine = (s: string) =>
  s
    .replace(/[\r\n#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Render selected entries as a prompt block (grouped by source, in score order). */
export function renderContext(sel: Scored[]): string {
  if (!sel.length) return "";
  const by = new Map<string, Scored[]>();
  for (const s of sel) by.set(s.source, [...(by.get(s.source) ?? []), s]);
  return [...by]
    .map(
      ([src, xs]) =>
        `## ${oneLine(String(src)) || "context"}\n${xs.map((x) => `- ${x.title ? `${oneLine(x.title)}: ` : ""}${x.text.replace(/\s+/g, " ").slice(0, RENDER_CHARS)}`).join("\n")}`,
    )
    .join("\n\n");
}
