// Agent core tools on the relay MCP surface (replaces the former packages/mcp stdio server test).
process.env.RELAY_HUB = "0";
process.env.RELAY_BUILTIN_MCP = "0";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_HOME = mkdtempSync(join(tmpdir(), "ai-os-relay-"));
const { mcpRpc } = await import("../../src/relay/protocols.ts");

test("MCP: agent tools listed, memory round trip", async () => {
  const l: any = await mcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = l.result.tools.map((t: any) => t.name);
  for (const n of [
    "memory_search",
    "memory_add",
    "skills_list",
    "council",
    "agent_run",
    "llm_models",
    "llm_ask",
  ])
    expect(names).toContain(n);
  await mcpRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "memory_add", arguments: { content: "the sky is teal" } },
  });
  const r: any = await mcpRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "memory_search", arguments: { query: "sky" } },
  });
  expect(r.result.isError).toBe(false);
  expect(r.result.content[0].text).toContain("teal");
});

test("MCP: agent_run on the echo model", async () => {
  const r: any = await mcpRpc({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "agent_run",
      arguments: { task: "ping", model: "echo/bot" },
    },
  });
  expect(r.result.structuredContent.text).toBe("bot: ping");
});

test("JSON-RPC: empty batch, invalid element, structuredContent object only, validated arguments, confined cwd", async () => {
  const { dispatch } = await import("../../src/relay/protocols.ts");
  expect(((await dispatch([], mcpRpc)) as any).error.code).toBe(-32600);
  const batch: any = await dispatch(
    [null, { jsonrpc: "2.0", id: 9, method: "ping" }],
    mcpRpc,
  );
  expect(batch.map((x: any) => x.error?.code ?? "ok")).toEqual([-32600, "ok"]);
  const s: any = await mcpRpc({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "memory_search", arguments: { query: "sky" } },
  });
  expect(s.result.structuredContent).toBeUndefined();
  const bad: any = await mcpRpc({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "memory_add", arguments: {} },
  });
  // Arguments that violate inputSchema are a protocol error (-32602), not a tool result.
  expect(bad.error.code).toBe(-32602);
  const esc: any = await mcpRpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "agent_run",
      arguments: { task: "x", model: "echo/e", cwd: "../.." },
    },
  });
  expect(esc.result.content[0].text).toContain("hors de AGENT_HOME");
});
