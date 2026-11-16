// Absorbed Stitch client (src/google/stitch, from google-labs-code/stitch-sdk) against a local Streamable HTTP MCP
// server: handshake and session, auth headers, domain classes on the upstream response fixtures, error mapping,
// retry policy, download_assets with the HTMLRewriter rewrite, and the relay's shared transport.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Stitch,
  StitchError,
  StitchToolClient,
  toolDefinitions,
} from "../../src/google/stitch/src/index.ts";
import { McpHttpClient, parseMcpBody } from "../../src/relay/mcp-http.ts";

const FIX = join(import.meta.dir, "fixtures", "stitch");
const fixture = (tool: string) =>
  JSON.parse(readFileSync(join(FIX, `${tool}.json`), "utf8"));

type Seen = { method: string; headers: Headers; body: any };
const seen: Seen[] = [];
let failNext: { status?: number; isError?: string; count: number } | null =
  null;
let server: ReturnType<typeof Bun.serve>;
let base = "";
const FILES = "https://files.example";
const realFetch = globalThis.fetch;

const sse = (m: unknown) =>
  new Response(`event: message\ndata: ${JSON.stringify(m)}\n\n`, {
    headers: {
      "content-type": "text/event-stream",
      "mcp-session-id": "sess-1",
    },
  });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (/^\/files\/s-\d+\.html$/.test(url.pathname))
        return new Response(
          `<html><head><link rel="stylesheet" href="${FILES}/a.css"></head><body><img src="${FILES}/logo.png"><img src="${FILES}/logo.png"><img src="data:x"></body></html>`,
        );
      if (url.pathname === "/files/a.css") return new Response("body{}");
      if (url.pathname === "/files/logo.png")
        return new Response(new Uint8Array([1, 2, 3]));
      if (/^\/files\/s-\d+\.png$/.test(url.pathname))
        return new Response(new Uint8Array([9]));
      if (req.method === "DELETE") {
        seen.push({ method: "DELETE", headers: req.headers, body: null });
        return new Response(null, { status: 204 });
      }
      const body: any = await req.json();
      seen.push({ method: body.method, headers: req.headers, body });
      if (body.method === "initialize")
        return sse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-stitch", version: "1" },
          },
        });
      if (!("id" in body)) return new Response(null, { status: 202 });
      if (failNext && failNext.count > 0) {
        failNext.count--;
        if (failNext.status)
          return new Response("slow down", {
            status: failNext.status,
            headers: { "retry-after": "0" },
          });
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            isError: true,
            content: [{ type: "text", text: failNext.isError }],
          },
        });
      }
      if (body.method === "tools/list")
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "list_projects", inputSchema: { type: "object" } }],
          },
        });
      const name: string = body.params.name;
      const payload = fixture(name);
      return sse({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: payload, content: [] },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  // Signed download URLs of the fixtures (https://files.example/...) are served by the local server.
  globalThis.fetch = Object.assign(
    (input: any, init?: any) =>
      realFetch(
        String(input instanceof Request ? input.url : input).replace(
          FILES,
          `${base}/files`,
        ),
        init,
      ),
    realFetch,
  );
});
afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
});

const client = (extra: Record<string, unknown> = {}) =>
  new StitchToolClient({ apiKey: "k-test", baseUrl: `${base}/mcp`, ...extra });

describe("stitch: transport", () => {
  test("initialize, session id and api key on every call; DELETE on close", async () => {
    seen.length = 0;
    const c = client();
    const r = await c.callTool<any>("list_projects", {});
    expect(r.projects.length).toBe(2);
    const methods = seen.map((s) => s.method);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    const call = seen[2]!;
    expect(call.headers.get("x-goog-api-key")).toBe("k-test");
    expect(call.headers.get("mcp-session-id")).toBe("sess-1");
    expect(call.headers.get("x-goog-api-client")).toMatch(
      /^gccl\/[\d.]+ client\/sdk$/,
    );
    await c.close();
    expect(seen.at(-1)!.method).toBe("DELETE");
    await expect(c.callTool("list_projects", {})).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
  });

  test("OAuth: bearer token and quota project", async () => {
    seen.length = 0;
    const c = new StitchToolClient({
      accessToken: "ya29.x",
      projectId: "proj-1",
      baseUrl: `${base}/mcp`,
    });
    await c.listTools();
    const h = seen.find((s) => s.method === "tools/list")!.headers;
    expect(h.get("authorization")).toBe("Bearer ya29.x");
    expect(h.get("x-goog-user-project")).toBe("proj-1");
    await c.close();
  });

  test("config validation keeps the upstream rule", () => {
    const saved = { ...process.env };
    for (const k of [
      "STITCH_API_KEY",
      "STITCH_ACCESS_TOKEN",
      "STITCH_PROJECT_ID",
      "GOOGLE_CLOUD_PROJECT",
    ])
      delete process.env[k];
    try {
      expect(() => new StitchToolClient({ accessToken: "t" })).toThrow(
        /apiKey' OR/,
      );
      expect(() => client({ retry: { attempts: 11 } })).toThrow(
        /retry.attempts/,
      );
    } finally {
      Object.assign(process.env, saved);
    }
  });

  test("SSE parser picks the response with the request id", () => {
    const body = `data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":1}}\n\n`;
    expect(parseMcpBody(body, 7).result).toEqual({ ok: 1 });
    expect(parseMcpBody('{"id":1,"result":2}', 1).result).toBe(2);
  });
});

describe("stitch: domain classes on upstream fixtures", () => {
  test("projects, generate, screens, screen URLs", async () => {
    const c = client();
    const s = new Stitch(c);
    const projects = await s.projects();
    expect(projects.map((p) => p.projectId)).toEqual(["p-fix", "p-two"]);
    const p = s.project("p-fix");
    const gen = await p.generate("login screen");
    expect(gen.length ?? [...gen].length).toBeGreaterThan(0);
    const screen = await p.getScreen("s-1");
    expect(await screen.getHtmlUrl()).toBe(`${FILES}/s-1.html`);
    expect(await screen.readHtml()).toContain("<img");
    await c.close();
  });

  test("tool catalog is shipped", () => {
    expect(
      toolDefinitions.some((t) => t.name === "generate_screen_from_text"),
    ).toBe(true);
  });
});

describe("stitch: errors and retry", () => {
  test("isError envelope -> classified StitchError, no retry for mutations", async () => {
    const c = client();
    failNext = { isError: "Permission denied on project", count: 5 };
    seen.length = 0;
    const e: any = await c
      .callTool("create_project", { title: "x" })
      .catch((x: any) => x);
    expect(e).toBeInstanceOf(StitchError);
    expect(e.code).toBe("PERMISSION_DENIED");
    expect(seen.filter((s) => s.method === "tools/call").length).toBe(1);
    failNext = null;
    await c.close();
  });

  test("HTTP 429 on a read is retried with backoff, then succeeds", async () => {
    const c = client({ retry: { attempts: 3, baseMs: 1, maxMs: 2 } });
    await c.connect();
    failNext = { status: 429, count: 2 };
    seen.length = 0;
    const r = await c.callTool<any>("list_projects", {});
    expect(r.projects.length).toBe(2);
    expect(seen.filter((s) => s.method === "tools/call").length).toBe(3);
    failNext = null;
    await c.close();
  });

  test("HTTP 401 -> AUTH_FAILED with status", async () => {
    const c = client({ retry: false });
    await c.connect();
    failNext = { status: 401, count: 1 };
    const e: any = await c.callTool("list_projects", {}).catch((x: any) => x);
    expect(e.code).toBe("AUTH_FAILED");
    expect(e.status).toBe(401);
    failNext = null;
    await c.close();
  });
});

describe("stitch: download_assets (HTMLRewriter)", () => {
  test("assets downloaded once, attributes rewritten, data: URLs kept", async () => {
    const out = mkdtempSync(join(tmpdir(), "stitch-dl-"));
    try {
      const c = client();
      const res = await new Stitch(c).project("p-fix").downloadAssets(out);
      expect(res.screens.length).toBeGreaterThan(0);
      const file = join(out, res.screens[0]!.filePath);
      const html = readFileSync(file, "utf8");
      expect(html).not.toContain(`${FILES}/logo.png`);
      expect(html).toMatch(/src="assets\/logo-[0-9a-f]{32}\.png"/);
      expect(html).toMatch(/href="assets\/a-[0-9a-f]{32}\.css"/);
      expect(html).toContain('src="data:x"');
      const assets = readdirSync(join(file, "..", "assets"));
      expect(assets.filter((a) => a.startsWith("logo-")).length).toBe(1);
      await c.close();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("relay transport", () => {
  test("McpHttpClient passes fetch init through (outboundFetch deterministic flag)", async () => {
    const inits: any[] = [];
    const m = new McpHttpClient({
      url: `${base}/mcp`,
      fetch: (u, i) => (inits.push(i), fetch(u, i)),
    });
    await m.connect();
    await m.request("tools/list", {}, { init: { deterministic: true } });
    expect(inits.at(-1).deterministic).toBe(true);
    await m.close();
  });
});
