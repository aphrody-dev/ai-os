// ACP v1: negotiation, required parameters, error codes, persistence + session/load, session/cancel -> cancelled.
import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ACP_HOME = mkdtempSync(join(tmpdir(), "ai-os-acp-"));
process.env.AGENT_HOME = process.env.ACP_HOME;
let slow = false;
const real = await import("../../src/relay/backends.ts");
mock.module("../../src/relay/backends.ts", () => ({
  ...real,
  gemini: async (prompt: string) => {
    if (slow) await Bun.sleep(200);
    if (prompt === "boom") throw new Error("moteur indisponible");
    return { text: `echo: ${prompt}`, engine: "test", chat: "c1", ms: 1 };
  },
  claude: async () => ({ text: "claude", engine: "claude", ms: 1 }),
}));
const { handle } = await import("../../src/relay/acp.ts");

const rpc = async (
  method: string,
  params?: unknown,
  id: number | undefined = 1,
) => {
  const out: any[] = [];
  await handle({ jsonrpc: "2.0", id, method, params }, (m) => out.push(m));
  return out;
};
const cwd = process.platform === "win32" ? "C:\\w" : "/w";

test("initialize: negotiated version, loadSession and session/list announced", async () => {
  const [r] = await rpc("initialize", { protocolVersion: 7 });
  expect(r.result.protocolVersion).toBe(1);
  expect(r.result.agentCapabilities.loadSession).toBe(true);
  expect(r.result.agentCapabilities.sessionCapabilities.list).toEqual({});
  expect((await rpc("initialize", {}))[0].error.code).toBe(-32602);
});

test("session/new: absolute cwd and mcpServers required; unknown session -32002; engine failure -32603", async () => {
  expect((await rpc("session/new", { mcpServers: [] }))[0].error.code).toBe(
    -32602,
  );
  expect(
    (await rpc("session/new", { cwd: "rel", mcpServers: [] }))[0].error.code,
  ).toBe(-32602);
  expect((await rpc("session/new", { cwd }))[0].error.code).toBe(-32602);
  const [n] = await rpc("session/new", { cwd, mcpServers: [] });
  const sessionId = n.result.sessionId;
  expect(
    (await rpc("session/prompt", { sessionId: "x", prompt: [] }))[0].error.code,
  ).toBe(-32002);
  const fail = await rpc("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "boom" }],
  });
  expect(fail[0].error.code).toBe(-32603);
});

test("session/prompt puis session/load rejoue l'historique ; session/list", async () => {
  const [n] = await rpc("session/new", { cwd, mcpServers: [] });
  const sessionId = n.result.sessionId;
  const out = await rpc("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "salut" }],
  });
  expect(out[0].params.update).toEqual({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "echo: salut" },
  });
  expect(out[1].result.stopReason).toBe("end_turn");
  const replay = await rpc("session/load", { sessionId, cwd, mcpServers: [] });
  expect(replay.map((m) => m.params?.update?.sessionUpdate ?? "reply")).toEqual(
    ["user_message_chunk", "agent_message_chunk", "reply"],
  );
  expect(replay[2].result).toEqual({});
  expect(
    (await rpc("session/load", { sessionId: "x", cwd, mcpServers: [] }))[0]
      .error.code,
  ).toBe(-32002);
  const [l] = await rpc("session/list", { cwd });
  expect(
    l.result.sessions.some(
      (s: any) => s.sessionId === sessionId && s.cwd === cwd,
    ),
  ).toBe(true);
});

test("session/cancel pendant un tour : stopReason cancelled", async () => {
  const [n] = await rpc("session/new", { cwd, mcpServers: [] });
  const sessionId = n.result.sessionId;
  slow = true;
  const turn = rpc(
    "session/prompt",
    { sessionId, prompt: [{ type: "text", text: "long" }] },
    9,
  );
  await Bun.sleep(20);
  expect(await rpc("session/cancel", { sessionId }, undefined)).toEqual([]);
  const out = await turn;
  slow = false;
  expect(out.at(-1).result.stopReason).toBe("cancelled");
  expect(out.some((m) => m.method === "session/update")).toBe(false);
});

test("_meta.model: discovered model, history carried into the next turn", async () => {
  const [n] = await rpc("session/new", {
    cwd,
    mcpServers: [],
    _meta: { model: "echo/bot" },
  });
  const sessionId = n.result.sessionId;
  await rpc("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "un" }],
  });
  const out = await rpc("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "deux" }],
  });
  const t = out[0].params.update.content.text;
  expect(t).toContain("bot:");
  expect(t).toContain("User: un");
  expect(t).toContain("User: deux");
  expect(out[1].result.stopReason).toBe("end_turn");
});
