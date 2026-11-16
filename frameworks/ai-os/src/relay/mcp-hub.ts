// Aggregation of Claude Code's user MCP servers (~/.claude.json, mcpServers key) into the relay: each tool
// of a server is exposed as `<server>__<tool>`. stdio: process launched on demand (protocol 2025-11-25,
// one JSON line per message); http: JSON-RPC POST with the configured headers. Env/header values are
// never logged. The claude.ai connectors (Gmail, Drive, Docs, Slides, Sheets, Calendar) are only reachable
// from a Claude Code session: `workspace_ask` tool (tools.ts).
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { outboundFetch } from "./outbound.ts";
import { relayHome } from "./cdp.ts";
import { McpHttpClient } from "./mcp-http.ts";
import { gcloudHeaders } from "../google/auth.ts";
import { DEFAULT_STITCH_API_URL } from "../google/stitch/src/constants.ts";

type Conf = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Header -> environment variable name (hub.json, [[hub.mcp]] headers); absent = not sent. */
  headerEnv?: Record<string, string>;
  /** Headers computed on every call (short-lived OAuth token). */
  dynamicHeaders?: () => Promise<Record<string, string>>;
};

// Google remote MCP servers built into the relay, authenticated by the active gcloud account's OAuth token
// (no API key, src/google/auth.ts): Stitch (stitch.googleapis.com/mcp, same URL as the absorbed client
// src/google/stitch). Tools are exposed as stitch__<tool>.
const BUILTIN: Record<string, Conf> = {
  stitch: {
    type: "http",
    url: Bun.env.STITCH_BASE_URL ?? DEFAULT_STITCH_API_URL,
    dynamicHeaders: gcloudHeaders,
  },
};
type Remote = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

/**
 * Servers reserved for the relay (<relay folder>/hub.json, { mcpServers }), written by toolchain.ts from
 * [[hub.mcp]]: reachable through hub_tools / hub_call without their tools loading a client's context.
 */
async function hubFile(): Promise<Record<string, Conf>> {
  const f = Bun.file(join(relayHome(), "hub.json"));
  try {
    return (await f.exists()) ? ((await f.json()).mcpServers ?? {}) : {};
  } catch {
    return {};
  }
}

export async function userServers(): Promise<Record<string, Conf>> {
  const f = Bun.file(join(homedir(), ".claude.json"));
  const all = {
    ...(await hubFile()),
    ...(((await f.exists()) ? (await f.json()).mcpServers : {}) ?? {}),
  } as Record<string, Conf>;
  // The relay itself is registered as a "relay" server: no loop.
  return {
    ...(Bun.env.RELAY_BUILTIN_MCP === "0" ? {} : BUILTIN),
    ...Object.fromEntries(
      Object.entries(all).filter(([n]) => n !== "relay" && /^[\w.-]+$/.test(n)),
    ),
  };
}

/** Live stdio children: killed when the relay exits (otherwise one orphan `agent-desktop mcp` per stdio bridge). */
const children = new Set<ReturnType<typeof Bun.spawn>>();
export const closeHub = () => {
  for (const c of children) c.kill();
  children.clear();
};
process.once("exit", closeHub);

class StdioServer {
  private p: ReturnType<typeof Bun.spawn> | null = null;
  private seq = 0;
  private buf = "";
  private pending = new Map<number, (m: any) => void>();
  constructor(private conf: Conf) {}

  private async start() {
    if (this.p) return;
    // agent-desktop refuses a state whose owner differs from the token (elevated session = BUILTIN\Administrators,
    // non-elevated = user): state root dedicated to the relay, created by its own process.
    const home = /agent-desktop(\.exe)?$/i.test(this.conf.command ?? "")
      ? { AGENT_DESKTOP_HOME: join(relayHome(), "agent-desktop") }
      : {};
    if (home.AGENT_DESKTOP_HOME)
      mkdirSync(home.AGENT_DESKTOP_HOME, { recursive: true });
    const p = Bun.spawn([this.conf.command!, ...(this.conf.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...home, ...(this.conf.env ?? {}) },
    });
    this.p = p;
    children.add(p);
    p.exited.then(() => children.delete(p));
    (async () => {
      for await (const c of p.stdout as ReadableStream<Uint8Array>) {
        this.buf += Buffer.from(c).toString("utf8");
        let i: number;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          const r = typeof m.id === "number" && this.pending.get(m.id);
          if (r) (this.pending.delete(m.id), r(m));
        }
      }
      this.p = null;
    })();
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "aphrody-relay", version: "0.1.0" },
    });
    (p.stdin as any).write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  request(method: string, params: unknown, timeout = 120_000): Promise<any> {
    return new Promise((ok, ko) => {
      const id = ++this.seq;
      const t = setTimeout(
        () => (this.pending.delete(id), ko(new Error(`${method}: timed out`))),
        timeout,
      );
      this.pending.set(
        id,
        (m) => (
          clearTimeout(t),
          m.error ? ko(rpcError(m.error)) : ok(m.result)
        ),
      );
      (this.p!.stdin as any).write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async call(method: string, params: unknown) {
    await this.start();
    return this.request(method, params);
  }
}

// Aggregated http server: transport shared with the Stitch client (mcp-http.ts) over outboundFetch. tools/list and
// tools/call of a readOnlyHint tool are reads, cached; everything else goes through the singleflight.
class HttpServer {
  private c: McpHttpClient;
  constructor(conf: Conf) {
    this.c = new McpHttpClient({
      url: conf.url!,
      headers: conf.headers,
      dynamicHeaders:
        conf.dynamicHeaders ??
        (conf.headerEnv
          ? async () =>
              Object.fromEntries(
                Object.entries(conf.headerEnv!).flatMap(([h, v]) =>
                  Bun.env[v] ? [[h, Bun.env[v]!]] : [],
                ),
              )
          : undefined),
      fetch: (u, i) => outboundFetch(u, i),
    });
  }
  async call(method: string, params: unknown, readOnly = false) {
    if (method === "initialize") return this.c.connect();
    return this.c.request(method, params, {
      init: { deterministic: method === "tools/list" || readOnly },
    });
  }
}

const servers = new Map<string, StdioServer | HttpServer>();
const toolCache = new Map<string, Remote[]>();

async function server(name: string) {
  let s = servers.get(name);
  if (!s) {
    const c = (await userServers())[name];
    if (!c)
      throw Object.assign(new Error(`unknown MCP server: ${name}`), {
        code: -32601,
        unknownTool: true,
      });
    s = c.type === "http" || c.url ? new HttpServer(c) : new StdioServer(c);
    if (c.type === "http" || c.url)
      await s
        .call("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "aphrody-relay", version: "0.1.0" },
        })
        .catch(() => {});
    servers.set(name, s);
  }
  return s;
}

/** Listing timeout per aggregated server: the relay's `tools/list` must fit under the MCP clients' timeout. */
const LIST_TIMEOUT = Number(Bun.env.RELAY_HUB_LIST_TIMEOUT ?? 3000);
/** Slow or unreachable server: no new synchronous attempt before this date (the late listing fills the cache). */
const retryAt = new Map<string, number>();

/**
 * Tools of all user servers (prefixed), listed in parallel with a per-server timeout. A server that
 * exceeds the timeout is omitted this time; its listing continues in the background and feeds the cache; on
 * failure it is retried only after 10 min. Before this fix, a slow server was retried serially on every
 * call and `tools/list` took 22 s ("tools fetch failed — Request timed out" in `claude mcp list`).
 */
/** Server built into the relay (never from ~/.claude.json). */
export const isBuiltin = (server: string) => Object.hasOwn(BUILTIN, server);

export async function hubTools(
  builtinOnly = false,
): Promise<(Remote & { server: string })[]> {
  // builtinOnly: client that already declares the ~/.claude.json servers itself (Claude Code, route /mcp/core).
  const names = Object.keys(await userServers())
    .filter((n) => !builtinOnly || Object.hasOwn(BUILTIN, n))
    .sort();
  const lists = await Promise.all(
    names.map(async (name): Promise<Remote[]> => {
      const cached = toolCache.get(name);
      if (cached) return cached;
      if ((retryAt.get(name) ?? 0) > Date.now()) return [];
      retryAt.set(name, Date.now() + 600_000);
      const p = (async () =>
        ((await (await server(name)).call("tools/list", {})).tools ??
          []) as Remote[])();
      p.then(
        (t) => {
          toolCache.set(name, t);
          retryAt.delete(name);
        },
        () => {},
      );
      return Promise.race([
        p.catch(() => [] as Remote[]),
        Bun.sleep(LIST_TIMEOUT).then(() => [] as Remote[]),
      ]);
    }),
  );
  return names.flatMap((name, i) =>
    lists[i]!.map((t) => ({ ...t, server: name, name: `${name}__${t.name}` })),
  );
}

/** Preload at relay startup: a client's first `tools/list` finds a warm cache. */
export const warmHub = () => void hubTools().catch(() => {});

/** JSON-RPC error of an aggregated server: code and data kept (protocol error relayed as is). */
const rpcError = (e: { code?: number; message: string; data?: unknown }) =>
  Object.assign(new Error(e.message), {
    code: e.code,
    data: e.data,
    rpc: true,
  });

export async function hubCall(prefixed: string, args: unknown) {
  const i = prefixed.indexOf("__");
  if (i < 0)
    throw Object.assign(new Error(`unknown tool: ${prefixed}`), {
      code: -32601,
    });
  const [srv, tool] = [prefixed.slice(0, i), prefixed.slice(i + 2)];
  const readOnly =
    toolCache.get(srv)?.find((t) => t.name === tool)?.annotations
      ?.readOnlyHint === true;
  return (await server(srv)).call(
    "tools/call",
    { name: tool, arguments: args ?? {} },
    readOnly,
  );
}
