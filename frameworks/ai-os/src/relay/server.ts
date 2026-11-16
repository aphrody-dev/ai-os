// Relay server: one bun process, all bindings on 127.0.0.1 (or RELAY_HOST), authorization mandatory
// (except the A2A agent card and OAuth metadata): OAuth 2.1 access token of the embedded server (oauth.ts, MCP 2026-07-28)
// or the relay's fixed token in the Authorization header; never a token in the URL outside the /webmcp bootstrap.
//   HTTP   GET /metrics (hit/miss/coalesced counters of outbound calls, outbound.ts, unauthenticated)
//          POST /rpc (relais natif)  POST /mcp (MCP Streamable HTTP)  POST /a2a (A2A 1.0, SSE : a2a.ts)  GET /.well-known/agent-card.json
//   WS     /ws : native relay JSON-RPC, one message per frame
//   WebMCP GET /webmcp?token=… : tools exposed to the browser agent (document.modelContext)
//   TCP    RELAY_TCP_PORT : line-delimited JSON-RPC (NDJSON); TLS on RELAY_TLS_PORT if RELAY_TLS_CERT/KEY are set
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { relayHome } from "./cdp.ts";
import { webmcpPage } from "./webmcp.ts";
import { a2aHttp, agentCard } from "./a2a.ts";
import { createOAuth, relayCookie } from "./oauth.ts";
import { warmHub } from "./mcp-hub.ts";
import { handle as acpHandle } from "./acp.ts";
import { outbound } from "./outbound.ts";
import { router } from "../router/index.ts";
import {
  chatCompletions,
  countTokens,
  messages,
  models,
} from "../router/http.ts";
import { dispatch, mcpRpc, nativeRpc, VERSION } from "./protocols.ts";

/** Relay token (32 random bytes, created at first launch in the user's private folder). */
export async function relayToken(): Promise<string> {
  if (Bun.env.RELAY_TOKEN) return Bun.env.RELAY_TOKEN;
  const f = join(relayHome(), "token");
  if (existsSync(f)) return (await Bun.file(f).text()).trim();
  mkdirSync(relayHome(), { recursive: true });
  const t = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "hex",
  );
  await Bun.write(f, t);
  if (process.platform !== "win32") Bun.spawnSync(["chmod", "600", f]);
  return t;
}

export async function serve() {
  const token = await relayToken();
  const host = Bun.env.RELAY_HOST ?? "127.0.0.1";
  const port = Number(Bun.env.RELAY_PORT ?? 8790);
  const oauth = createOAuth({ token, host });
  await oauth.ready;
  // Session cookie derived from the token (HMAC), never the token itself.
  const session = relayCookie(token);
  const cookie = (req: Request) =>
    (req.headers.get("cookie") ?? "")
      .split(/;\s*/)
      .includes(`relay=${session}`);
  // HttpOnly SameSite=Strict cookie: set by the /webmcp bootstrap, accepted for the page and its /mcp calls.
  const authed = (req: Request, resource: "mcp" | "a2a" | "rpc" = "rpc") =>
    cookie(req) || typeof oauth.verify(req, resource) === "object";
  const guard =
    (
      resource: "mcp" | "a2a" | "rpc",
      h: (req: Request) => Response | Promise<Response>,
    ) =>
    (req: Request) => {
      if (cookie(req)) return h(req);
      const v = oauth.verify(req, resource);
      if (v === "insufficient") return oauth.challenge(req, resource, true);
      return v ? h(req) : oauth.challenge(req, resource);
    };
  const apiKey =
    (h: (req: Request) => Response | Promise<Response>) => (req: Request) => {
      const k = req.headers.get("x-api-key");
      if (k && !req.headers.get("authorization")) {
        const hd = new Headers(req.headers);
        hd.set("authorization", `Bearer ${k}`);
        req = new Request(req, { headers: hd });
      }
      return h(req);
    };
  // WebMCP page: opened once with ?token=…, the token moves to an HttpOnly cookie and leaves the URL.
  const webmcp = async (req: Request) => {
    const u = new URL(req.url);
    if (u.searchParams.get("token") === token)
      return new Response(null, {
        status: 303,
        headers: {
          location: "/webmcp",
          "set-cookie": `relay=${session}; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
    if (!cookie(req)) return deny();
    return new Response(await webmcpPage(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  };
  const deny = () =>
    new Response("jeton requis (Authorization: Bearer)", { status: 401 });
  const rpc = (h: Parameters<typeof dispatch>[1]) => async (req: Request) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const out = await dispatch(body, h);
    return out === null
      ? new Response(null, { status: 202 })
      : Response.json(out);
  };
  const acpHttp = async (req: Request) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const msgs: unknown[] = [];
    await acpHandle(body as any, (m) => msgs.push(m));
    const reply = msgs.find(
      (m: any) => m && typeof m === "object" && "id" in m && m.id !== undefined,
    );
    const updates = msgs.filter((m) => m !== reply);
    return reply
      ? Response.json(
          updates.length ? { ...(reply as object), _updates: updates } : reply,
        )
      : updates.length
        ? Response.json({ jsonrpc: "2.0", id: null, _updates: updates })
        : new Response(null, { status: 202 });
  };
  const http = Bun.serve<{ open: number; kind?: "rpc" | "acp" }>({
    hostname: host,
    port,
    idleTimeout: 255,
    routes: {
      "/.well-known/agent-card.json": (req: Request) =>
        Response.json(agentCard(oauth.origin(req))),
      ...oauth.routes,
      "/health": () =>
        Response.json({ name: "aphrody-relay", version: VERSION }),
      // Outbound dedup counters (outbound.ts), Prometheus format; no request data.
      "/metrics": () =>
        new Response(outbound().metrics(), {
          headers: { "content-type": "text/plain; version=0.0.4" },
        }),
      "/rpc": { POST: guard("rpc", rpc(nativeRpc)) },
      "/acp": { POST: guard("rpc", acpHttp) },
      // Model router (src/router): OpenAI and Anthropic, same authorization as the relay; Anthropic sends
      // also the token in x-api-key.
      "/v1/chat/completions": {
        POST: apiKey(guard("rpc", (req) => chatCompletions(req, router()))),
      },
      "/v1/models": { GET: apiKey(guard("rpc", () => models(router()))) },
      "/v1/messages": {
        POST: apiKey(guard("rpc", (req) => messages(req, router()))),
      },
      "/v1/messages/count_tokens": {
        POST: apiKey(guard("rpc", (req) => countTokens(req))),
      },
      "/webmcp": webmcp,
      "/mcp": {
        POST: guard("mcp", rpc(mcpRpc)),
        GET: () => new Response(null, { status: 405 }),
      },
      "/mcp/core": {
        POST: guard(
          "mcp",
          rpc((r) => mcpRpc(r, true)),
        ),
        GET: () => new Response(null, { status: 405 }),
      },
      "/a2a": {
        POST: guard("a2a", a2aHttp),
      },
      "/ws": (
        req: Request,
        srv: Bun.Server<{ open: number; kind?: "rpc" | "acp" }>,
      ) =>
        !authed(req, "rpc")
          ? oauth.challenge(req, "rpc")
          : srv.upgrade(req, { data: { open: Date.now(), kind: "rpc" } })
            ? undefined
            : new Response("WebSocket attendu", { status: 426 }),
      "/acp/ws": (
        req: Request,
        srv: Bun.Server<{ open: number; kind?: "rpc" | "acp" }>,
      ) =>
        !authed(req, "rpc")
          ? oauth.challenge(req, "rpc")
          : srv.upgrade(req, { data: { open: Date.now(), kind: "acp" } })
            ? undefined
            : new Response("WebSocket attendu", { status: 426 }),
    },
    websocket: {
      async message(ws, msg) {
        if (ws.data?.kind === "acp") {
          try {
            const parsed = JSON.parse(String(msg));
            await acpHandle(parsed, (m) => ws.send(JSON.stringify(m)));
          } catch (e) {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: String(e) },
              }),
            );
          }
          return;
        }
        const out = await dispatch(JSON.parse(String(msg)), nativeRpc).catch(
          (e) => ({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: String(e) },
          }),
        );
        if (out) ws.send(JSON.stringify(out));
      },
    },
  });

  // TCP / TLS: NDJSON; the first line must be the token.
  type Sock = { buf: string; ok: boolean };
  const socketHandlers = {
    open(s: any) {
      s.data = { buf: "", ok: false } satisfies Sock;
    },
    async data(s: any, chunk: Buffer) {
      const st = s.data as Sock;
      st.buf += Buffer.from(chunk).toString("utf8");
      let i: number;
      while ((i = st.buf.indexOf("\n")) >= 0) {
        const line = st.buf.slice(0, i).trim();
        st.buf = st.buf.slice(i + 1);
        if (!line) continue;
        if (!st.ok) {
          st.ok = line === token;
          s.write(st.ok ? '{"ok":true}\n' : '{"ok":false}\n');
          if (!st.ok) s.end();
          continue;
        }
        const out = await dispatch(JSON.parse(line), nativeRpc).catch((e) => ({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: String(e) },
        }));
        if (out) s.write(`${JSON.stringify(out)}\n`);
      }
    },
  };
  const tcpPort = Number(Bun.env.RELAY_TCP_PORT ?? 8791);
  const tcp = Bun.listen({
    hostname: host,
    port: tcpPort,
    socket: socketHandlers,
  });
  let tls: { port: number } | null = null;
  if (Bun.env.RELAY_TLS_CERT && Bun.env.RELAY_TLS_KEY) {
    tls = Bun.listen({
      hostname: host,
      port: Number(Bun.env.RELAY_TLS_PORT ?? 8792),
      tls: {
        cert: Bun.file(Bun.env.RELAY_TLS_CERT),
        key: Bun.file(Bun.env.RELAY_TLS_KEY),
      },
      socket: socketHandlers,
    });
  }
  if (Bun.env.RELAY_HUB !== "0") warmHub();
  console.error(
    `relay ${VERSION} http://${host}:${http.port} (rpc, mcp, a2a, ws) tcp ${tcp.port}${tls ? ` tls ${tls.port}` : ""}`,
  );
  return { http, tcp, tls, token, oauth };
}
