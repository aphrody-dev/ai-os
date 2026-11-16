import { afterAll, expect, test } from "bun:test";
import { resolveModel } from "../../src/core/model";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../../src/gateway/index";

const home = mkdtempSync(join(tmpdir(), "agent-gw-"));
const gw = createGateway({ home, model: await resolveModel("echo/gw") });
afterAll(() => gw.stop());
const url = (p: string) => new URL(p, gw.url).href;

test("gateway: openai-compatible, webhook channel, websocket (A2A lives in the relay)", async () => {
  const oa: any = await (
    await fetch(url("/v1/chat/completions"), {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
  ).json();
  expect(oa.choices[0].message.content).toBe("gw: hi");

  expect(
    (await fetch(url("/a2a"), { method: "POST", body: "{}" })).status,
  ).toBe(404);

  const ch: any = await (
    await fetch(url("/channels/webhook"), {
      method: "POST",
      body: JSON.stringify({ session: "s1", text: "yo" }),
    })
  ).json();
  expect(ch.text).toBe("gw: yo");
  expect(gw.sessions.get("webhook:s1")?.length).toBe(2);

  const ws = new WebSocket(url("/ws").replace("http", "ws"));
  const reply = await new Promise<any>((res, rej) => {
    ws.onopen = () =>
      ws.send(
        JSON.stringify({ type: "message", session: "w", text: "over ws" }),
      );
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data));
      if (f.type === "reply") res(f);
    };
    ws.onerror = rej;
  });
  expect(reply.text).toBe("gw: over ws");
  ws.close();
});

test("gateway: channel webhooks require the gateway token unless the channel verifies itself", async () => {
  const g = createGateway({
    home,
    model: await resolveModel("echo/gw"),
    token: "t0k",
  });
  try {
    const u = new URL("/channels/webhook", g.url).href;
    expect(
      (await fetch(u, { method: "POST", body: JSON.stringify({ text: "x" }) }))
        .status,
    ).toBe(401);
    const okRes: any = await (
      await fetch(u, {
        method: "POST",
        headers: { authorization: "Bearer t0k" },
        body: JSON.stringify({ text: "x" }),
      })
    ).json();
    expect(okRes.text).toBe("gw: x");
  } finally {
    g.stop();
  }
});

test("gateway: idle sessions expire, LRU cap, bounded history", async () => {
  const h = mkdtempSync(join(tmpdir(), "agent-gw-ttl-"));
  const g = createGateway({
    home: h,
    model: await resolveModel("echo/gw"),
    sessionTtlMs: 50,
    maxSessions: 2,
    maxHistory: 4,
  });
  const say = (session: string, text: string) =>
    fetch(new URL("/channels/webhook", g.url).href, {
      method: "POST",
      body: JSON.stringify({ session, text }),
    }).then((r) => r.json());
  for (let i = 0; i < 3; i++) await say("a", `t${i}`);
  expect(g.sessions.get("webhook:a")?.length).toBe(4);
  await say("b", "x");
  await say("c", "y");
  expect([...g.sessions.keys()].sort()).toEqual(["webhook:b", "webhook:c"]);
  await Bun.sleep(80);
  g.evict();
  expect(g.sessions.size).toBe(0);
  g.stop();
});
