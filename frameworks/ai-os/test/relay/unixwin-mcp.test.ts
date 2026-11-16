import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applets, respond, unixwinTools } from "../../src/relay/unixwin-mcp.ts";

const fake = {
  bin: [
    process.execPath,
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "omniu",
      "test",
      "fixtures",
      "fake-ay.ts",
    ),
  ],
};
const call = async (name: string, args: object = {}) => {
  const t = unixwinTools(fake).find((x) => x.name === name)!;
  return t.run(args as never);
};

describe("unixwin MCP tools", () => {
  test("the tool list is stable and marks the shell tool as not read-only", () => {
    const tools = unixwinTools(fake);
    expect(tools.map((t) => t.name)).toEqual([
      "unixwin_applets",
      "unixwin_plugin_manifest",
      "unixwin_validate_bundle",
      "unixwin_sh",
    ]);
    expect(tools.filter((t) => !t.readOnly).map((t) => t.name)).toEqual([
      "unixwin_sh",
    ]);
  });

  test("applets: the provider table, with WinuxCmd as the base", async () => {
    const t = await applets();
    expect(t.basename).toBe("winux");
    const r: any = await call("unixwin_applets");
    expect(r.counts.winux).toBeGreaterThan(50);
    expect(r.counts.uutils).toBeGreaterThan(10);
    expect(await call("unixwin_applets", { name: "basename" })).toEqual({
      basename: "winux",
    });
    expect(await call("unixwin_applets", { name: "nope" })).toEqual({
      error: "unknown applet nope",
    });
  });

  test("plugin manifest comes from the ay binary", async () => {
    expect(((await call("unixwin_plugin_manifest")) as any).version).toBe(
      "9.9.9",
    );
  });

  test("the omniu bundle validates", async () => {
    expect(await call("unixwin_validate_bundle")).toEqual({
      ok: true,
      errors: [],
    });
  });

  test("sh runs through ay and returns the exit status", async () => {
    expect(await call("unixwin_sh", { command: "exit 4" })).toMatchObject({
      code: 4,
    });
    await expect(call("unixwin_sh", {})).rejects.toThrow(
      "command (string) required",
    );
  });
});

test("the stdio server answers initialize and tools/list, one JSON message per line", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "..", "src", "relay", "unixwin-mcp.ts"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  proc.stdin.end();
  const lines = (await new Response(proc.stdout).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines[0].result.serverInfo.name).toBe("aphrody-unixwin");
  expect(lines[1].result.tools.map((t: any) => t.name)).toContain(
    "unixwin_applets",
  );
  await proc.exited;
});

describe("JSON-RPC conformance", () => {
  const tools = unixwinTools(fake);
  const req = (o: object) => respond(JSON.stringify(o), tools);

  test("a notification gets no reply, a request gets one with its id", async () => {
    expect(
      await req({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
    expect(await req({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {},
    });
    expect((await req({ jsonrpc: "2.0", id: 0, method: "ping" }))?.id).toBe(0);
  });

  test("malformed input is an error reply, not a crash", async () => {
    expect(await respond("{not json", tools)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    expect((await respond("[1,2]", tools))?.error?.code).toBe(-32600);
    expect((await respond("null", tools))?.error?.code).toBe(-32600);
    expect((await respond('{"id":1}', tools))?.error?.code).toBe(-32600);
  });

  test("unknown methods and bad tool calls carry the right codes", async () => {
    expect(
      (await req({ jsonrpc: "2.0", id: 1, method: "nope" }))?.error?.code,
    ).toBe(-32601);
    expect(
      (await req({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }))
        ?.error?.code,
    ).toBe(-32602);
    expect(
      (
        await req({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "nope" },
        })
      )?.error?.code,
    ).toBe(-32602);
  });

  test("a failing tool is an isError result, and a missing provider table does not break the server", async () => {
    const r: any = await req({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "unixwin_sh", arguments: {} },
    });
    expect(r.result.isError).toBe(true);
    const broken = unixwinTools(fake, "/definitely/not/a/root");
    const a: any = await respond(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "unixwin_applets" },
      }),
      broken,
    );
    expect(a.result.isError).toBe(true);
  });
});

test("the stdio server survives a malformed line and answers the next request", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "..", "src", "relay", "unixwin-mcp.ts"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(
    `garbage\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`,
  );
  proc.stdin.end();
  const lines = (await new Response(proc.stdout).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines.map((l: any) => l.error?.code ?? l.id)).toEqual([-32700, 9]);
  expect(await proc.exited).toBe(0);
});
