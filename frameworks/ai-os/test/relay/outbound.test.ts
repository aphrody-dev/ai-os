import { afterAll, expect, test } from "bun:test";
import {
  Outbound,
  canonical,
  loadMesh,
  requestKey,
} from "../../src/relay/outbound.ts";

let calls = 0;
const seen: Record<string, string | null> = {};
const up = Bun.serve({
  port: 0,
  routes: {
    "/v1/chat/completions": {
      POST: async (req) => {
        calls++;
        const b: any = await req.json();
        seen.idem = req.headers.get("idempotency-key");
        seen.marker = req.headers.get("x-aphrody-cache");
        await Bun.sleep(80);
        if (b.fail) return Response.json({ error: "boom" }, { status: 500 });
        if (b.soft) return Response.json({ error: { message: "quota" } });
        if (b.stream) {
          const enc = new TextEncoder();
          return new Response(
            new ReadableStream({
              async start(c) {
                for (const t of ["a", "b", "c"]) {
                  c.enqueue(enc.encode(`data: ${t}\n\n`));
                  await Bun.sleep(30);
                }
                c.enqueue(enc.encode("data: [DONE]\n\n"));
                c.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({ n: calls, echo: b.messages?.[0]?.content });
      },
    },
  },
});
afterAll(() => up.stop(true));
const url = `${up.url.origin}/v1/chat/completions`;
const post = (
  o: Outbound,
  body: object,
  headers: Record<string, string> = {},
) =>
  o.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const fresh = (ttlMs = 60_000) =>
  new Outbound({ db: ":memory:", ttlMs, mesh: loadMesh("") });
const msg = (t: string, extra: object = {}) => ({
  model: "m",
  messages: [{ role: "user", content: t }],
  ...extra,
});

test("canonical: sorted keys, volatile fields removed", () => {
  expect(canonical({ b: 1, a: { d: 2, c: 3 }, user: "u", id: 7 })).toBe(
    '{"a":{"c":3,"d":2},"b":1}',
  );
  expect(requestKey("POST", url, '{"a":1,"user":"x"}').key).toBe(
    requestKey("post", url, '{ "user":"y","a":1 }').key,
  );
  expect(requestKey("POST", url, '{"a":1}').key).not.toBe(
    requestKey("POST", url, '{"a":2}').key,
  );
});

test("singleflight: 5 identical concurrent requests, a single upstream call", async () => {
  const o = fresh();
  calls = 0;
  const rs = await Promise.all(
    Array.from({ length: 5 }, () => post(o, msg("x", { temperature: 0.7 }))),
  );
  const bodies = await Promise.all(rs.map((r) => r.json()));
  expect(calls).toBe(1);
  expect(new Set(bodies.map((b: any) => b.n)).size).toBe(1);
  expect(rs.map((r) => r.headers.get("x-aphrody-cache")).sort()).toEqual([
    "coalesced",
    "coalesced",
    "coalesced",
    "coalesced",
    "miss",
  ]);
  expect(o.stats()).toMatchObject({ miss: 1, coalesced: 4, stored: 0 });
  // Non-deterministic: no cache, the next call goes upstream again.
  await (await post(o, msg("x", { temperature: 0.7 }))).json();
  expect(calls).toBe(2);
});

test("cache : temperature 0 ou seed fixe, hit puis expiration du TTL", async () => {
  const o = fresh(150);
  calls = 0;
  const a = await (await post(o, msg("t0", { temperature: 0 }))).json();
  await Bun.sleep(5);
  const r = await post(o, msg("t0", { temperature: 0, user: "autre" }));
  expect(r.headers.get("x-aphrody-cache")).toBe("hit");
  expect(await r.json()).toEqual(a);
  expect(calls).toBe(1);
  await (await post(o, msg("s", { seed: 42 }))).json();
  await Bun.sleep(5);
  expect(
    (await post(o, msg("s", { seed: 42 }))).headers.get("x-aphrody-cache"),
  ).toBe("hit");
  expect(calls).toBe(2);
  await Bun.sleep(200);
  const late = await post(o, msg("t0", { temperature: 0 }));
  expect(late.headers.get("x-aphrody-cache")).toBe("miss");
  await late.json();
  await Bun.sleep(5);
  expect(calls).toBe(3);
  expect(o.stats()).toMatchObject({ hit: 2, stored: 3 });
});

test("bypass : x-aphrody-cache: bypass et Cache-Control: no-store", async () => {
  const o = fresh();
  calls = 0;
  await (await post(o, msg("b", { temperature: 0 }))).json();
  await Bun.sleep(5);
  const r1 = await post(o, msg("b", { temperature: 0 }), {
    "x-aphrody-cache": "bypass",
  });
  await r1.json();
  expect(seen.marker).toBeNull(); // internal header not propagated
  const r2 = await post(o, msg("b", { temperature: 0 }), {
    "cache-control": "no-store",
  });
  await r2.json();
  expect(calls).toBe(3);
  expect(o.stats()).toMatchObject({ bypass: 2, hit: 0 });
});

test("errors never cached (HTTP 500 and error JSON in a 200)", async () => {
  const o = fresh();
  calls = 0;
  for (let i = 0; i < 2; i++) {
    expect(
      (await post(o, msg("e", { temperature: 0, fail: true }))).status,
    ).toBe(500);
    await Bun.sleep(5);
  }
  for (let i = 0; i < 2; i++) {
    await (await post(o, msg("e", { temperature: 0, soft: true }))).json();
    await Bun.sleep(5);
  }
  expect(calls).toBe(4);
  expect(o.stats()).toMatchObject({ stored: 0, hit: 0 });
});

test("SSE streaming: one upstream stream broadcast to all subscribers, then replayed from the cache", async () => {
  const o = fresh();
  calls = 0;
  const first = await post(o, msg("s", { stream: true, temperature: 0 }));
  await Bun.sleep(40); // the second arrives mid-stream: catch-up on chunks already read
  const second = await post(o, msg("s", { stream: true, temperature: 0 }));
  const [a, b] = await Promise.all([first.text(), second.text()]);
  const want = "data: a\n\ndata: b\n\ndata: c\n\ndata: [DONE]\n\n";
  expect(a).toBe(want);
  expect(b).toBe(want);
  expect(second.headers.get("x-aphrody-cache")).toBe("coalesced");
  expect(second.headers.get("content-type")).toContain("text/event-stream");
  await Bun.sleep(5);
  const third = await post(o, msg("s", { stream: true, temperature: 0 }));
  expect(third.headers.get("x-aphrody-cache")).toBe("hit");
  expect(await third.text()).toBe(want);
  expect(calls).toBe(1);
});

test("mesh: remote host:port -> local LB port, Idempotency-Key on LB port POSTs", async () => {
  const toml = `
[nodes.usa]
public_ip = "203.0.113.5"
mesh_ip = "192.0.2.5"
ssh_alias = "prd"
[cluster.members.prd]
node = "usa"
ssh = "prd"
[cluster.services.commons]
lb_port = 19766
targets = { prd = "192.0.2.5:8766" }
cache = "off"
[cluster.services.api]
lb_port = ${up.port}
targets = { prd = "127.0.0.1:28081" }
cache = "micro"
`;
  const m = loadMesh(toml);
  expect(m.routes.get("192.0.2.5:8766")?.lbPort).toBe(19766);
  expect(m.routes.get("prd:28081")?.lbPort).toBe(up.port);
  expect(m.routes.get("203.0.113.5:28081")?.cached).toBe(true);
  const o = new Outbound({ db: ":memory:", mesh: m });
  // prd:28081 -> 127.0.0.1:<test port> (listening); fall back to the original URL if absent.
  const r = await o.route("http://prd:28081/v1/chat/completions");
  expect(r.url).toBe(`http://127.0.0.1:${up.port}/v1/chat/completions`);
  expect((await o.route("http://192.0.2.5:8766/x")).url).toBe(
    "http://192.0.2.5:8766/x",
  ); // 19766 does not listen here
  calls = 0;
  const res = await o.fetch("http://prd:28081/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(msg("w")),
  });
  await res.json();
  expect(calls).toBe(1);
  expect(seen.idem).toBe(
    requestKey(
      "POST",
      "http://prd:28081/v1/chat/completions",
      JSON.stringify(msg("w")),
    ).key,
  );
  expect(o.stats()).toMatchObject({ mesh_routed: 1, idempotency_keys: 1 });
});
