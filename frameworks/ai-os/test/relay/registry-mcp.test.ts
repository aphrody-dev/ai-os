import { afterEach, describe, expect, test } from "bun:test";
import { TOOLS, handle } from "../../src/relay/registry-mcp.ts";

// The server talks to the real registries; these tests replace fetch with a stub so they run offline.
const realFetch = globalThis.fetch;
const out: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);

function stub(routes: Record<string, unknown>) {
  globalThis.fetch = (async (
    input: string | Request | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    expect(new Headers(init?.headers).get("user-agent")).toContain(
      "aphrody-registry-mcp",
    );
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit)
      return new Response("not found", {
        status: 404,
        statusText: "Not Found",
      });
    return typeof hit[1] === "string"
      ? new Response(hit[1])
      : Response.json(hit[1]);
  }) as typeof fetch;
}
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
async function rpc(m: object): Promise<any[]> {
  out.length = 0;
  process.stdout.write = ((s: string) => (
    out.push(s),
    true
  )) as typeof process.stdout.write;
  try {
    await handle(m as any);
  } finally {
    process.stdout.write = realWrite;
  }
  return out.map((l) => JSON.parse(l));
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("registry MCP", () => {
  test("crate_info keeps newest, stable, MSRV, features and flags yanked releases", async () => {
    stub({
      "/crates/serde": {
        crate: {
          name: "serde",
          newest_version: "2.0.0-rc.1",
          max_stable_version: "1.0.9",
          repository: "r",
          downloads: 5,
          recent_downloads: 2,
        },
        versions: [
          {
            num: "2.0.0-rc.1",
            license: "MIT OR Apache-2.0",
            rust_version: "1.90",
            features: { std: [], derive: [] },
            yanked: false,
          },
          { num: "1.0.9", yanked: true },
        ],
      },
    });
    const r: any = await tool("crate_info").run({ name: "serde" });
    expect(r.newest).toBe("2.0.0-rc.1");
    expect(r.stable).toBe("1.0.9");
    expect(r.rust_version).toBe("1.90");
    expect(r.features).toEqual(["std", "derive"]);
    expect(r.releases[1].yanked).toBe(true);
    expect(r.documentation).toBe("https://docs.rs/serde");
  });

  test("npm_info encodes scoped names and dates every dist-tag", async () => {
    let seen = "";
    globalThis.fetch = (async (u: string | Request | URL) => {
      seen = String(u);
      return Response.json({
        name: "@scope/pkg",
        "dist-tags": { latest: "1.0.0", canary: "1.1.0-canary.3" },
        time: { "1.0.0": "t1", "1.1.0-canary.3": "t2" },
        versions: { "1.0.0": { license: "MIT", engines: { bun: ">=1" } } },
      });
    }) as typeof fetch;
    const r: any = await tool("npm_info").run({ name: "@scope/pkg" });
    expect(seen.endsWith("/@scope%2Fpkg")).toBe(true);
    expect(r.dist_tags.canary).toEqual({
      version: "1.1.0-canary.3",
      published: "t2",
    });
    expect(r.engines).toEqual({ bun: ">=1" });
  });

  test("search tools clamp the limit and require the query", async () => {
    let seen = "";
    globalThis.fetch = (async (u: string | Request | URL) => (
      (seen = String(u)),
      Response.json({ objects: [], crates: [] })
    )) as typeof fetch;
    await tool("npm_search").run({ q: "mcp", limit: 500 });
    expect(seen).toContain("size=50");
    await tool("crates_search").run({ q: "mcp", limit: 0 });
    expect(seen).toContain("per_page=10");
    await expect(tool("crates_search").run({})).rejects.toThrow('"q"');
  });

  test("JSON-RPC: notifications get no reply, bad requests and unknown tools get errors, HTTP errors are tool errors", async () => {
    expect(
      await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toEqual([]);
    expect((await rpc({ id: 1, method: "tools/list" }))[0].error.code).toBe(
      -32600,
    );
    expect(
      (
        await rpc({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "nope" },
        })
      )[0].error.code,
    ).toBe(-32602);
    const list = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }))[0]
      .result.tools;
    expect(list.map((t: any) => t.name).sort()).toEqual([
      "crate_info",
      "crate_readme",
      "crates_search",
      "npm_info",
      "npm_search",
    ]);
    stub({});
    const r = (
      await rpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "crate_info", arguments: { name: "x" } },
      })
    )[0].result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("404");
  });
});
