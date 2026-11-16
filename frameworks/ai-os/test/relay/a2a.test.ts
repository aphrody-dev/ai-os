// A2A 1.0 (JSON-RPC binding): card, version, validation, task lifecycle and SSE streams, on the echo model.
process.env.RELAY_HUB = "0";
process.env.RELAY_BUILTIN_MCP = "0";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_HOME = mkdtempSync(join(tmpdir(), "ai-os-a2a-"));
const { a2aHttp, a2aRpc, agentCard, versionSupported } =
  await import("../../src/relay/a2a.ts");

const msg = (text: string, extra: Record<string, unknown> = {}) => ({
  messageId: crypto.randomUUID(),
  role: "ROLE_USER",
  parts: [{ text }],
  metadata: { skill: "agent_run", model: "echo/bot" },
  ...extra,
});
const post = (body: unknown, version: string | null = "1.0") =>
  a2aHttp(
    new Request("http://127.0.0.1/a2a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(version === null ? {} : { "A2A-Version": version }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const events = async (r: Response) =>
  (await r.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));

test("agent card: JSON-RPC 1.0 interface, announced stream, existing skills", () => {
  const c = agentCard("http://127.0.0.1:8790");
  expect(c.supportedInterfaces[0]).toEqual({
    url: "http://127.0.0.1:8790/a2a",
    protocolBinding: "JSONRPC",
    protocolVersion: "1.0",
  });
  expect(c.capabilities.streaming).toBe(true);
  expect(c.skills.map((s) => s.id)).toContain("agent_run");
  for (const s of c.skills) expect(s.tags.length).toBeGreaterThan(0);
});

test("A2A-Version: absent = 0.3 refused (-32009), 1.0 and 1.1 accepted", async () => {
  expect(versionSupported(null)).toBe(false);
  expect(versionSupported("0.3")).toBe(false);
  expect(versionSupported("1.0")).toBe(true);
  expect(versionSupported("1.1")).toBe(true);
  const r: any = await (
    await post(
      { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } },
      null,
    )
  ).json();
  expect(r.error.code).toBe(-32009);
  expect(r.error.data[0].reason).toBe("VERSION_NOT_SUPPORTED");
  expect(r.id).toBe(1);
});

test("errors: invalid JSON -32700, parameters -32602 (BadRequest), unknown method -32601, missing task -32001", async () => {
  expect(((await (await post("{")).json()) as any).error.code).toBe(-32700);
  const noRole: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "SendMessage",
    params: { message: { messageId: "m", parts: [{ text: "x" }] } },
  });
  expect(noRole.error.code).toBe(-32602);
  expect(noRole.error.data[0]["@type"]).toBe(
    "type.googleapis.com/google.rpc.BadRequest",
  );
  expect(noRole.error.data[0].fieldViolations[0].field).toBe("message.role");
  const empty: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "SendMessage",
    params: { message: msg("x", { parts: [] }) },
  });
  expect(empty.error.data[0].fieldViolations[0].field).toBe("message.parts");
  expect(
    ((await a2aRpc({ jsonrpc: "2.0", id: 4, method: "message/send" })) as any)
      .error.code,
  ).toBe(-32601);
  const nf: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 5,
    method: "GetTask",
    params: { id: "absent" },
  });
  expect(nf.error.code).toBe(-32001);
  expect(nf.error.data[0].reason).toBe("TASK_NOT_FOUND");
  const img: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 6,
    method: "SendMessage",
    params: {
      message: msg("x", { parts: [{ raw: "AAAA", mediaType: "image/png" }] }),
    },
  });
  expect(img.error.code).toBe(-32005);
  const push: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 7,
    method: "CreateTaskPushNotificationConfig",
    params: {},
  });
  expect(push.error.code).toBe(-32003);
  const ext: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 8,
    method: "GetExtendedAgentCard",
  });
  expect(ext.error.code).toBe(-32007);
});

test("blocking SendMessage -> COMPLETED task with artifact; GetTask, historyLength, ListTasks, terminal CancelTask -32002", async () => {
  const r: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 10,
    method: "SendMessage",
    params: { message: msg("ping") },
  });
  const t = r.result.task;
  expect(t.status.state).toBe("TASK_STATE_COMPLETED");
  expect(t.artifacts[0].parts[0].text).toContain("bot: ping");
  expect(t.history[0].role).toBe("ROLE_USER");
  expect(t.history[0].taskId).toBe(t.id);
  const g: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 11,
    method: "GetTask",
    params: { id: t.id, historyLength: 0 },
  });
  expect(g.result.id).toBe(t.id);
  expect(g.result.history).toEqual([]);
  const l: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 12,
    method: "ListTasks",
    params: { contextId: t.contextId, status: "TASK_STATE_COMPLETED" },
  });
  expect(l.result.tasks.map((x: any) => x.id)).toEqual([t.id]);
  expect(l.result.totalSize).toBe(1);
  expect(l.result.nextPageToken).toBe("");
  expect(l.result.tasks[0].artifacts).toEqual([]);
  const c: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 13,
    method: "CancelTask",
    params: { id: t.id },
  });
  expect(c.error.code).toBe(-32002);
  const again: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 14,
    method: "SendMessage",
    params: { message: msg("encore", { taskId: t.id }) },
  });
  expect(again.error.code).toBe(-32004);
});

test("returnImmediately then CancelTask: CANCELED task, SubscribeToTask refused (-32004)", async () => {
  const r: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 20,
    method: "SendMessage",
    params: {
      message: msg("lent"),
      configuration: { returnImmediately: true },
    },
  });
  const t = r.result.task;
  expect(t.status.state).toBe("TASK_STATE_SUBMITTED");
  const c: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 21,
    method: "CancelTask",
    params: { id: t.id },
  });
  expect(c.result.status.state).toBe("TASK_STATE_CANCELED");
  await Bun.sleep(20);
  const g: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 22,
    method: "GetTask",
    params: { id: t.id },
  });
  expect(g.result.status.state).toBe("TASK_STATE_CANCELED");
  expect(g.result.artifacts).toEqual([]);
  const ev = await events(
    await post({
      jsonrpc: "2.0",
      id: 23,
      method: "SubscribeToTask",
      params: { id: t.id },
    }),
  );
  expect(ev[0].error.code).toBe(-32004);
});

test("SendStreamingMessage : SSE Task, WORKING, artefact, COMPLETED puis fermeture", async () => {
  const res = await post({
    jsonrpc: "2.0",
    id: 30,
    method: "SendStreamingMessage",
    params: { message: msg("flux") },
  });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const ev = await events(res);
  expect(ev.every((e) => e.jsonrpc === "2.0" && e.id === 30)).toBe(true);
  expect(ev[0].result.task.status.state).toBe("TASK_STATE_SUBMITTED");
  const id = ev[0].result.task.id;
  expect(ev[1].result.statusUpdate.status.state).toBe("TASK_STATE_WORKING");
  expect(ev[2].result.artifactUpdate.taskId).toBe(id);
  expect(ev[2].result.artifactUpdate.artifact.parts[0].text).toContain(
    "bot: flux",
  );
  expect(ev.at(-1).result.statusUpdate.status.state).toBe(
    "TASK_STATE_COMPLETED",
  );
  expect(ev.length).toBe(4);
  const bad = await events(
    await post({
      jsonrpc: "2.0",
      id: 31,
      method: "SendStreamingMessage",
      params: { message: { messageId: "m", role: "ROLE_USER", parts: [] } },
    }),
  );
  expect(bad[0].error.code).toBe(-32602);
});

test("tool failure: FAILED task with agent message, no JSON-RPC error", async () => {
  const r: any = await a2aRpc({
    jsonrpc: "2.0",
    id: 40,
    method: "SendMessage",
    params: {
      message: msg("x", {
        metadata: { skill: "llm_ask", model: "absent/modele" },
      }),
    },
  });
  expect(r.error).toBeUndefined();
  expect(r.result.task.status.state).toBe("TASK_STATE_FAILED");
  expect(r.result.task.status.message.role).toBe("ROLE_AGENT");
});
