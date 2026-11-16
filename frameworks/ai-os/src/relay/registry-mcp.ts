// Package registries as a stdio MCP server (protocol 2025-11-25, one JSON message per line), reached through the relay
// hub: hub_tools server=registry, hub_call name=registry__crates_search | registry__crate_info | registry__crate_readme |
// registry__npm_search | registry__npm_info. Registered by [[hub.mcp]] registry in tools/agents/toolchain.toml.
// Every answer is read live from the registry's own API (crates.io v1, docs.rs, registry.npmjs.org); nothing is cached
// or pinned here. Library documentation itself comes from the context7 server.

type Rpc = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: any;
};
type Args = Record<string, unknown>;

const CRATES = Bun.env.REGISTRY_CRATES_API ?? "https://crates.io/api/v1";
const NPM = Bun.env.REGISTRY_NPM_API ?? "https://registry.npmjs.org";
// crates.io asks every API client to identify itself (crates.io data access policy).
const UA = "aphrody-registry-mcp (+https://github.com/aphrody-labs/ay)";

async function get(url: string, accept = "application/json"): Promise<any> {
  const r = await fetch(url, {
    headers: { "user-agent": UA, accept },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return accept.includes("json") ? r.json() : r.text();
}

const str = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v.trim())
    throw new Error(`argument "${k}" (string) is required`);
  return v.trim();
};
const limit = (a: Args): number =>
  Math.min(Math.max(Number(a.limit ?? 10) || 10, 1), 50);
const enc = encodeURIComponent;

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run(a: Args): Promise<unknown>;
}

const nameArg = (what: string) => ({
  type: "object",
  properties: { name: { type: "string", description: `${what} name` } },
  required: ["name"],
});
const searchArg = {
  type: "object",
  properties: {
    q: { type: "string", description: "search text" },
    limit: { type: "number", description: "1-50, default 10" },
  },
  required: ["q"],
};

export const TOOLS: Tool[] = [
  {
    name: "crates_search",
    description:
      "Search crates.io, ranked by recent downloads: name, newest version, recent downloads, repository.",
    inputSchema: searchArg,
    async run(a) {
      const r = await get(
        `${CRATES}/crates?q=${enc(str(a, "q"))}&per_page=${limit(a)}&sort=recent-downloads`,
      );
      return r.crates.map((c: any) => ({
        name: c.name,
        newest: c.newest_version ?? c.max_version,
        stable: c.max_stable_version,
        recent_downloads: c.recent_downloads,
        updated_at: c.updated_at,
        repository: c.repository,
        description: c.description,
      }));
    },
  },
  {
    name: "crate_info",
    description:
      "One crate from crates.io: newest and stable versions, MSRV, features, license, links, and the 10 latest releases (yanked flagged).",
    inputSchema: nameArg("crate"),
    async run(a) {
      const name = str(a, "name");
      const r = await get(`${CRATES}/crates/${enc(name)}`);
      const c = r.crate;
      const versions = (r.versions ?? []) as any[];
      const newest =
        versions.find((v) => v.num === (c.newest_version ?? c.max_version)) ??
        versions[0];
      return {
        name: c.name,
        newest: c.newest_version ?? c.max_version,
        stable: c.max_stable_version,
        description: c.description,
        repository: c.repository,
        documentation: c.documentation ?? `https://docs.rs/${c.name}`,
        downloads: c.downloads,
        recent_downloads: c.recent_downloads,
        updated_at: c.updated_at,
        license: newest?.license,
        rust_version: newest?.rust_version,
        edition: newest?.edition,
        features: newest?.features ? Object.keys(newest.features) : [],
        releases: versions.slice(0, 10).map((v) => ({
          num: v.num,
          created_at: v.created_at,
          yanked: v.yanked,
          rust_version: v.rust_version,
        })),
      };
    },
  },
  {
    name: "crate_readme",
    description:
      "README of a crate version as published on crates.io (HTML rendered by crates.io); version defaults to the newest.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "string", description: "default: newest" },
      },
      required: ["name"],
    },
    async run(a) {
      const name = str(a, "name");
      const version =
        typeof a.version === "string" && a.version
          ? a.version
          : (await get(`${CRATES}/crates/${enc(name)}`)).crate.newest_version;
      return {
        name,
        version,
        readme_html: await get(
          `${CRATES}/crates/${enc(name)}/${enc(version)}/readme`,
          "text/html",
        ),
      };
    },
  },
  {
    name: "npm_search",
    description:
      "Search the npm registry: name, version, date, weekly downloads, repository.",
    inputSchema: searchArg,
    async run(a) {
      const r = await get(
        `${NPM}/-/v1/search?text=${enc(str(a, "q"))}&size=${limit(a)}`,
      );
      return r.objects.map((o: any) => ({
        name: o.package.name,
        version: o.package.version,
        date: o.package.date,
        weekly_downloads: o.downloads?.weekly,
        repository: o.package.links?.repository,
        description: o.package.description,
      }));
    },
  },
  {
    name: "npm_info",
    description:
      "One npm package: dist-tags (latest, next, canary, rc...) with their publish dates, license, repository, engines and peer dependencies of latest, deprecation.",
    inputSchema: nameArg("package"),
    async run(a) {
      const name = str(a, "name");
      // Scoped names keep the @ and encode the slash (registry API).
      const r = await get(
        `${NPM}/${name.startsWith("@") ? `@${enc(name.slice(1))}` : enc(name)}`,
      );
      const tags = (r["dist-tags"] ?? {}) as Record<string, string>;
      const latest = r.versions?.[tags.latest ?? ""] ?? {};
      return {
        name: r.name,
        description: r.description,
        dist_tags: Object.fromEntries(
          Object.entries(tags).map(([t, v]) => [
            t,
            { version: v, published: r.time?.[v] },
          ]),
        ),
        license: latest.license ?? r.license,
        repository:
          typeof r.repository === "string" ? r.repository : r.repository?.url,
        homepage: r.homepage,
        engines: latest.engines,
        peer_dependencies: latest.peerDependencies,
        deprecated: latest.deprecated,
        modified: r.time?.modified,
      };
    },
  },
];

const send = (m: unknown): void =>
  void process.stdout.write(`${JSON.stringify(m)}\n`);
const ok = (id: Rpc["id"], result: unknown) =>
  send({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) =>
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handle(m: Rpc): Promise<void> {
  if (m?.jsonrpc !== "2.0" || typeof m.method !== "string")
    return fail(m?.id, -32600, "invalid request");
  if (m.id === undefined) return; // notification: no response
  switch (m.method) {
    case "initialize":
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "aphrody-registry", version: "0.1.0" },
      });
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return fail(m.id, -32602, `unknown tool ${m.params?.name}`);
      try {
        return ok(m.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(await t.run(m.params?.arguments ?? {})),
            },
          ],
        });
      } catch (e) {
        return ok(m.id, {
          isError: true,
          content: [
            { type: "text", text: e instanceof Error ? e.message : String(e) },
          ],
        });
      }
    }
    default:
      return fail(m.id, -32601, `method not found: ${m.method}`);
  }
}

if (import.meta.main) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(null, -32700, "parse error");
        continue;
      }
      await handle(msg);
    }
  }
}
