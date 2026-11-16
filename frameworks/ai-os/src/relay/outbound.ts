// Outbound HTTP calls of the relay (LLM providers, OpenAI-compatible APIs, aggregated HTTP MCP servers), client-side
// complement of the cluster's nginx coalescing (device/cluster, docs/infra/CLUSTER.md):
//   - singleflight: identical in-flight requests share a single upstream call; the body (JSON or SSE stream) is
//     broadcast to all subscribers, latecomers first receive the chunks already read;
//   - bun:sqlite response cache (<relayHome>/cache.sqlite, RELAY_CACHE_DB): key = sha256(method, URL, canonical body,
//     model), canonical body = JSON with sorted keys and no volatile fields (user, id, request_id…);
//     only deterministic 2xx responses (temperature 0, integer seed, read declared by the caller) are kept,
//     TTL RELAY_CACHE_TTL_MS (default 120 s), RELAY_CACHE=0 disables the cache; `Cache-Control: no-store` and
//     `x-aphrody-cache: bypass` (request) or `no-store` (response) bypass it;
//   - Idempotency-Key = the sha256 key on POSTs that go through a cluster LB port (nginx replays them for 24 h);
//   - mesh: a cross-host URL whose host:port is the target of a [cluster.services] entry of device/deploy.toml
//     goes to 127.0.0.1:<lb_port> when that port listens (HAProxy mTLS, TCP 7444), falling back to the original URL.
// Metrics: stats() (relay_cache_stats tool, GET /metrics of the server).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { relayHome } from "./cdp.ts";
import { expandSync } from "../../../../system/env-kit/src/discover.ts";

export type OutboundInit = RequestInit & {
  /** Response deemed deterministic (read, embeddings, tools/call of a readOnly tool). */
  deterministic?: boolean;
};

const VOLATILE = new Set([
  "user",
  "id",
  "request_id",
  "requestId",
  "idempotency_key",
]);

/** JSON with sorted keys, top-level volatile fields removed (metadata.user_id too). */
export function canonical(body: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as any)[k])]),
          )
        : v;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return JSON.stringify(sort(body));
  const top: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!VOLATILE.has(k)) top[k] = v;
  if (top.metadata && typeof top.metadata === "object") {
    const { user_id: _u, ...m } = top.metadata as Record<string, unknown>;
    top.metadata = m;
  }
  return JSON.stringify(sort(top));
}

const sha256 = (s: string) =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");

export function requestKey(method: string, url: string, body?: string) {
  let parsed: unknown;
  let canon = body ?? "";
  if (body)
    try {
      parsed = JSON.parse(body);
      canon = canonical(parsed);
    } catch {}
  const model = (parsed as any)?.model ?? (parsed as any)?.params?.name ?? "";
  return {
    key: sha256(
      JSON.stringify([method.toUpperCase(), url, canon, String(model)]),
    ),
    parsed,
  };
}

/** Deterministic request: temperature 0, integer seed (JSON body), or declared by the caller. */
export function deterministic(
  method: string,
  parsed: unknown,
  declared?: boolean,
) {
  if (declared) return true;
  if (method === "GET" || method === "HEAD") return false;
  const p = parsed as any;
  if (!p || typeof p !== "object") return false;
  return p.temperature === 0 || Number.isInteger(p.seed);
}

// ---- cluster mesh -----------------------------------------------------------------------------------------------

type MeshRoute = { lbPort: number; cached: boolean };
type Mesh = { routes: Map<string, MeshRoute>; lbPorts: Map<number, boolean> };

/** Remote host:port -> local LB port table, from device/deploy.toml [cluster] (SRC_ROOT, otherwise the repository copy). */
export function loadMesh(text?: string): Mesh {
  const routes = new Map<string, MeshRoute>();
  const lbPorts = new Map<number, boolean>();
  let d: any;
  try {
    if (text === undefined) {
      const file = [
        Bun.env.RELAY_DEPLOY_TOML,
        Bun.env.SRC_ROOT && join(Bun.env.SRC_ROOT, "device", "deploy.toml"),
        join(import.meta.dir, "..", "..", "..", "..", "device", "deploy.toml"),
      ].find((f) => f && existsSync(f));
      if (!file) return { routes, lbPorts };
      text = expandSync(readFileSync(file, "utf8"));
    }
    d = Bun.TOML.parse(text);
  } catch {
    return { routes, lbPorts };
  }
  const c = d?.cluster;
  if (!c?.services) return { routes, lbPorts };
  for (const s of Object.values<any>(c.services)) {
    if (!s.lb_port || !s.targets) continue;
    const cached =
      (s.mode ?? "http") === "http" && (s.cache ?? "off") !== "off";
    lbPorts.set(s.lb_port, cached);
    for (const [member, target] of Object.entries<string>(s.targets)) {
      const i = target.lastIndexOf(":");
      const [h, port] = [target.slice(0, i), target.slice(i + 1)];
      const m = c.members?.[member];
      const n = m && d.nodes?.[m.node];
      const hosts = new Set<string>([member]);
      if (m?.node) hosts.add(m.node);
      if (m?.ssh) hosts.add(m.ssh);
      if (n?.public_ip) hosts.add(n.public_ip);
      if (n?.mesh_ip) hosts.add(n.mesh_ip);
      if (n?.ssh_alias) hosts.add(n.ssh_alias);
      if (h !== "127.0.0.1" && h !== "localhost") hosts.add(h);
      for (const x of hosts)
        routes.set(`${x}:${port}`, { lbPort: s.lb_port, cached });
    }
  }
  return { routes, lbPorts };
}

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const portOf = (u: URL) =>
  u.port ||
  (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");

/** 127.0.0.1:p port listening (result kept 30 s). */
const listening = new Map<number, { ok: boolean; at: number }>();
function portOpen(p: number): Promise<boolean> {
  const c = listening.get(p);
  if (c && Date.now() - c.at < 30_000) return Promise.resolve(c.ok);
  return new Promise((res) => {
    const s = connect({ host: "127.0.0.1", port: p });
    const done = (ok: boolean) => {
      listening.set(p, { ok, at: Date.now() });
      s.destroy();
      res(ok);
    };
    s.setTimeout(300, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// ---- broadcasting a body to several subscribers -----------------------------------------------------------------

const safe = (f: () => void) => {
  try {
    f();
  } catch {}
};

class Broadcast {
  chunks: Uint8Array[] = [];
  subs = new Set<ReadableStreamDefaultController<Uint8Array>>();
  done = false;
  error: unknown = null;
  constructor(body: ReadableStream<Uint8Array> | null) {
    if (!body) {
      this.done = true;
      return;
    }
    (async () => {
      try {
        for await (const c of body as any as AsyncIterable<Uint8Array>) {
          this.chunks.push(c);
          for (const s of this.subs) safe(() => s.enqueue(c));
        }
        this.done = true;
        for (const s of this.subs) safe(() => s.close());
      } catch (e) {
        this.error = e;
        for (const s of this.subs) safe(() => s.error(e));
      }
      this.subs.clear();
    })();
  }
  stream(): ReadableStream<Uint8Array> {
    let me: ReadableStreamDefaultController<Uint8Array>;
    return new ReadableStream({
      start: (ctl) => {
        me = ctl;
        for (const c of this.chunks) ctl.enqueue(c);
        if (this.error) ctl.error(this.error);
        else if (this.done) ctl.close();
        else this.subs.add(ctl);
      },
      cancel: () => {
        this.subs.delete(me);
      },
    });
  }
  /** Full body (waits for the end). */
  async bytes(): Promise<Uint8Array> {
    await new Response(this.stream()).arrayBuffer();
    return Buffer.concat(this.chunks);
  }
}

type Flight = {
  status: number;
  statusText: string;
  headers: Headers;
  body: Broadcast;
};

// ---- client sortant --------------------------------------------------------------------------------------------

export type OutboundStats = {
  hit: number;
  miss: number;
  coalesced: number;
  bypass: number;
  stored: number;
  uncacheable: number;
  errors: number;
  upstream: number;
  idempotency_keys: number;
  mesh_routed: number;
  mesh_fallback: number;
  inflight: number;
  entries: number;
  ttl_ms: number;
};

export class Outbound {
  private db: Database | null;
  private inflight = new Map<string, Promise<Flight>>();
  private counters = {
    hit: 0,
    miss: 0,
    coalesced: 0,
    bypass: 0,
    stored: 0,
    uncacheable: 0,
    errors: 0,
    upstream: 0,
    idempotency_keys: 0,
    mesh_routed: 0,
    mesh_fallback: 0,
  };
  readonly ttlMs: number;
  readonly maxEntries: number;
  private mesh: Mesh;
  private fetcher: typeof fetch;

  constructor(
    o: {
      db?: string | null;
      ttlMs?: number;
      maxEntries?: number;
      mesh?: Mesh;
      fetch?: typeof fetch;
    } = {},
  ) {
    this.ttlMs = o.ttlMs ?? Number(Bun.env.RELAY_CACHE_TTL_MS ?? 120_000);
    this.maxEntries = o.maxEntries ?? Number(Bun.env.RELAY_CACHE_MAX ?? 2000);
    this.mesh = o.mesh ?? loadMesh();
    // Late-bound global: a test or a runtime that swaps globalThis.fetch after construction is honoured.
    this.fetcher =
      o.fetch ?? (((i, init) => globalThis.fetch(i, init)) as typeof fetch);
    const path = o.db === undefined ? join(relayHome(), "cache.sqlite") : o.db;
    this.db = null;
    if (path !== null) {
      try {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.db = new Database(path, { create: true });
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run(
          "CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, status INTEGER, headers TEXT, body BLOB, expires INTEGER)",
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS responses_expires ON responses (expires)",
        );
      } catch (e) {
        console.error(`relay cache: SQLite unavailable (${e}), cache disabled`);
        this.db = null;
      }
    }
  }

  stats(): OutboundStats {
    const entries =
      (
        this.db
          ?.query("SELECT count(*) AS n FROM responses WHERE expires > ?")
          .get(Date.now()) as { n: number } | null
      )?.n ?? 0;
    return {
      ...this.counters,
      inflight: this.inflight.size,
      entries,
      ttl_ms: this.ttlMs,
    };
  }

  /** Format d'exposition Prometheus. */
  metrics(): string {
    const s = this.stats();
    return `${Object.entries(s)
      .map(
        ([k, v]) =>
          `# TYPE aphrody_relay_outbound_${k} ${k === "inflight" || k === "entries" || k === "ttl_ms" ? "gauge" : "counter"}\naphrody_relay_outbound_${k} ${v}`,
      )
      .join("\n")}\n`;
  }

  clear() {
    this.db?.run("DELETE FROM responses");
  }

  private get(key: string) {
    return this.db
      ?.query(
        "SELECT status, headers, body FROM responses WHERE key = ? AND expires > ?",
      )
      .get(key, Date.now()) as
      { status: number; headers: string; body: Uint8Array } | null | undefined;
  }

  private put(key: string, f: Flight, body: Uint8Array) {
    if (!this.db) return;
    const ct = f.headers.get("content-type");
    const keep: Record<string, string> = ct ? { "content-type": ct } : {};
    this.db
      .query(
        "INSERT OR REPLACE INTO responses (key, status, headers, body, expires) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, f.status, JSON.stringify(keep), body, Date.now() + this.ttlMs);
    this.counters.stored++;
    if (this.counters.stored % 64 === 0) {
      this.db.query("DELETE FROM responses WHERE expires <= ?").run(Date.now());
      this.db
        .query(
          "DELETE FROM responses WHERE key IN (SELECT key FROM responses ORDER BY expires DESC LIMIT -1 OFFSET ?)",
        )
        .run(this.maxEntries);
    }
  }

  /** URL rewritten to the mesh's local LB port if the remote host:port is served there and that port listens. */
  async route(
    url: string,
  ): Promise<{ url: string; lbPort?: number; cached: boolean }> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { url, cached: false };
    }
    const port = Number(portOf(u));
    if (LOCAL.has(u.hostname)) {
      const c = this.mesh.lbPorts.get(port);
      return { url, lbPort: c === undefined ? undefined : port, cached: !!c };
    }
    const r = this.mesh.routes.get(`${u.hostname}:${portOf(u)}`);
    if (!r || u.protocol !== "http:" || !(await portOpen(r.lbPort)))
      return { url, cached: false };
    u.hostname = "127.0.0.1";
    u.port = String(r.lbPort);
    return { url: u.toString(), lbPort: r.lbPort, cached: r.cached };
  }

  async fetch(input: string | URL, init: OutboundInit = {}): Promise<Response> {
    const { deterministic: declared, ...rest } = init;
    const method = (rest.method ?? "GET").toUpperCase();
    const headers = new Headers(rest.headers);
    const url = String(input);
    const directive = headers.get("x-aphrody-cache")?.toLowerCase() ?? "";
    headers.delete("x-aphrody-cache");
    const bypass =
      directive === "bypass" ||
      directive === "no-store" ||
      /no-store/i.test(headers.get("cache-control") ?? "") ||
      Bun.env.RELAY_CACHE === "0";
    const body = typeof rest.body === "string" ? rest.body : undefined;
    const keyable = rest.body == null || body !== undefined;
    const { key, parsed } = requestKey(method, url, body);
    const cacheable =
      !bypass && keyable && deterministic(method, parsed, declared);

    const routed = await this.route(url);
    // Non-idempotent POST through a cluster LB port: stable key, nginx coalesces and replays (24 h).
    if (
      method === "POST" &&
      routed.lbPort !== undefined &&
      !headers.has("idempotency-key")
    ) {
      headers.set("idempotency-key", key);
      this.counters.idempotency_keys++;
    }

    const upstream = async (): Promise<Flight> => {
      this.counters.upstream++;
      const go = (u: string) => this.fetcher(u, { ...rest, method, headers });
      let r: Response;
      if (routed.url !== url) {
        try {
          r = await go(routed.url);
          this.counters.mesh_routed++;
        } catch {
          this.counters.mesh_fallback++;
          listening.delete(routed.lbPort!);
          r = await go(url);
        }
      } else r = await go(url);
      return {
        status: r.status,
        statusText: r.statusText,
        headers: new Headers(r.headers),
        body: new Broadcast(r.body),
      };
    };
    const respond = (f: Flight, tag: string) => {
      const h = new Headers(f.headers);
      h.delete("content-length");
      h.delete("content-encoding");
      h.set("x-aphrody-cache", tag);
      return new Response(f.body.stream(), {
        status: f.status,
        statusText: f.statusText,
        headers: h,
      });
    };

    if (bypass || !keyable) {
      this.counters.bypass++;
      return this.fetcher(routed.url, { ...rest, method, headers }).catch(
        (e) => {
          if (routed.url === url) throw e;
          this.counters.mesh_fallback++;
          return this.fetcher(url, { ...rest, method, headers });
        },
      );
    }

    if (cacheable && this.db) {
      const c = this.get(key);
      if (c) {
        this.counters.hit++;
        const h = new Headers(JSON.parse(c.headers));
        h.set("x-aphrody-cache", "hit");
        return new Response(c.body, { status: c.status, headers: h });
      }
    }

    const shared = this.inflight.get(key);
    if (shared) {
      this.counters.coalesced++;
      return respond(await shared, "coalesced");
    }
    this.counters.miss++;
    const p = upstream();
    this.inflight.set(key, p);
    let f: Flight;
    try {
      f = await p;
    } catch (e) {
      this.inflight.delete(key);
      this.counters.errors++;
      throw e;
    }
    // End of the flight once the body is fully read; cache only a deterministic success.
    f.body
      .bytes()
      .then((bytes) => {
        if (!cacheable) return void this.counters.uncacheable++;
        if (f.status < 200 || f.status >= 300)
          return void this.counters.errors++;
        if (/no-store/i.test(f.headers.get("cache-control") ?? "")) return;
        if ((f.headers.get("x-aphrody-cache") ?? "") === "no-store") return;
        if (/json/.test(f.headers.get("content-type") ?? "")) {
          try {
            const j = JSON.parse(new TextDecoder().decode(bytes));
            if (j && typeof j === "object" && "error" in j && j.error)
              return void this.counters.errors++;
          } catch {
            return void this.counters.errors++;
          }
        }
        this.put(key, f, bytes);
      })
      .catch(() => void this.counters.errors++)
      .finally(() => this.inflight.delete(key));
    return respond(f, "miss");
  }
}

let shared: Outbound | null = null;
/** Process-wide shared client (in-memory database under `bun test`). */
export const outbound = () =>
  (shared ??= new Outbound({
    db:
      Bun.env.RELAY_CACHE_DB ??
      (Bun.env.NODE_ENV === "test" ? ":memory:" : undefined),
  }));
/** fetch() sortant : singleflight, cache, Idempotency-Key, mesh. */
export const outboundFetch = (input: string | URL, init?: OutboundInit) =>
  outbound().fetch(input, init);
