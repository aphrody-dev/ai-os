import { describe, expect, test } from "bun:test";
import { type Offer, join, norm } from "../../src/router/catalog.ts";
import { type CallFn, Exhausted, Router } from "../../src/router/engine.ts";
import { order, parsePolicy } from "../../src/router/policy.ts";
import {
  HALF_LIFE_MS,
  Store,
  decay,
  eloUpdate,
} from "../../src/router/stats.ts";
import {
  anthropicStream,
  anthropicToOpenAI,
  openAIToAnthropic,
} from "../../src/router/wire.ts";

const offer = (id: string, o: Partial<Offer> = {}): Offer => {
  const [provider, ...r] = id.split("/");
  const model = r.join("/");
  return {
    id,
    provider: provider!,
    model,
    key: norm(model),
    cli: false,
    tools: true,
    vision: false,
    sources: [],
    ...o,
  };
};
const OFFERS = [
  offer("a/big", { arena: 1500, priceIn: 5, priceOut: 15, context: 200_000 }),
  offer("b/small", {
    arena: 1300,
    priceIn: 0.1,
    priceOut: 0.2,
    context: 32_000,
  }),
  offer("c/mid", { arena: 1400, priceIn: 1, priceOut: 3, context: 1_000_000 }),
  offer("d/big", { arena: 1500, priceIn: 4, priceOut: 12 }),
  offer("agy/cli", { cli: true, tools: false, arena: 1600 }),
];
const ids = (l: Offer[]) => l.map((o) => o.id);
const ok = (text = "pong") =>
  Response.json({
    id: "x",
    created: 1,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });
const catalog = (offers: Offer[]) => ({
  offers,
  providers: [],
  at: Date.now(),
  report: {},
});
const mk = (call: CallFn, offers = OFFERS) => {
  const r = new Router(new Store(":memory:"), call, async () =>
    catalog(offers),
  );
  r.setCatalog(catalog(offers));
  return r;
};
const body = { model: "auto", messages: [{ role: "user", content: "ping" }] };

describe("decay and Elo", () => {
  test("weight halves every half-life", () => {
    expect(decay(0)).toBe(1);
    expect(decay(HALF_LIFE_MS)).toBeCloseTo(0.5);
    expect(decay(3 * HALF_LIFE_MS)).toBeCloseTo(0.125);
  });
  test("Elo: zero-sum, tie between equals changes nothing, upsets move more", () => {
    const [a, b] = eloUpdate(1000, 1000, 1);
    expect(a + b).toBeCloseTo(2000);
    expect(a).toBeCloseTo(1016);
    expect(eloUpdate(1000, 1000, 0.5)).toEqual([1000, 1000]);
    expect(eloUpdate(800, 1200, 1)[0] - 800).toBeGreaterThan(a - 1000);
  });
  test("old errors fade from health", () => {
    const s = new Store(":memory:");
    const t = 1_000_000_000_000;
    for (let i = 0; i < 5; i++)
      s.record({
        ts: t,
        offer: "a/big",
        ok: false,
        status: 500,
        ms: 10,
        inTok: 0,
        outTok: 0,
        cost: 0,
        caller: "x",
      });
    const fresh = s.stats(t + 1000).get("a/big")!.health;
    const later = s.stats(t + 6 * HALF_LIFE_MS).get("a/big")!.health;
    expect(fresh).toBeLessThan(0.3);
    expect(later).toBeGreaterThan(0.9);
  });
});

describe("policy", () => {
  const pol = (m: string, need = {}, st = new Store(":memory:").stats()) =>
    ids(order(OFFERS, parsePolicy(m, OFFERS), need, st));
  test("auto = best arena, price breaks ties, CLI offers last", () => {
    expect(pol("auto")).toEqual([
      "d/big",
      "a/big",
      "c/mid",
      "b/small",
      "agy/cli",
    ]);
  });
  test("auto:cheap, auto:long", () => {
    expect(pol("auto:cheap").slice(0, 2)).toEqual(["b/small", "c/mid"]);
    expect(pol("auto:long")[0]).toBe("c/mid");
  });
  test("auto:code ranks by the arena coding rating, falling back to the overall one", () => {
    const o = [
      offer("x/plain", { arena: 1500 }),
      offer("y/coder", { arena: 1400, arenaCode: 1550 }),
    ];
    expect(ids(order(o, parsePolicy("auto:code", o)))).toEqual([
      "y/coder",
      "x/plain",
    ]);
    expect(ids(order(o, parsePolicy("auto", o)))).toEqual([
      "x/plain",
      "y/coder",
    ]);
  });
  test("auto:fast uses measured p50", () => {
    const s = new Store(":memory:");
    const rec = (offer: string, ms: number) =>
      s.record({
        ts: Date.now(),
        offer,
        ok: true,
        status: 200,
        ms,
        inTok: 1,
        outTok: 1,
        cost: 0,
        caller: "x",
      });
    rec("a/big", 900);
    rec("c/mid", 100);
    expect(pol("auto:fast", {}, s.stats()).slice(0, 2)).toEqual([
      "c/mid",
      "a/big",
    ]);
  });
  test("exact then same model elsewhere then auto; bare name cheapest first; unknown falls back to auto", () => {
    const o = [
      ...OFFERS,
      offer("e/big", { priceIn: 1, priceOut: 1, arena: 1500 }),
    ];
    const l = ids(order(o, parsePolicy("a/big", o)));
    expect(l.slice(0, 4)).toEqual(["a/big", "e/big", "d/big", "c/mid"]);
    expect(ids(order(o, parsePolicy("big", o))).slice(0, 3)).toEqual([
      "e/big",
      "d/big",
      "a/big",
    ]);
    expect(ids(order(o, parsePolicy("nonexistent-model", o)))).toEqual(
      ids(order(o, parsePolicy("auto", o))),
    );
    expect(ids(order(o, parsePolicy("a/big", o), { strict: true }))).toEqual([
      "a/big",
      "e/big",
      "d/big",
    ]);
  });
  test("tools filter, cooling offers last, unhealthy demoted, budget filter", () => {
    expect(pol("auto", { tools: true })).not.toContain("agy/cli");
    const s = new Store(":memory:");
    s.cooldown("d/big", Date.now() + 60_000);
    expect(pol("auto", {}, s.stats()).at(-1)).toBe("d/big");
    expect(
      pol("auto", { maxCost: 0.001, tokens: 1000, outTokens: 1000 })[0],
    ).toBe("b/small");
  });
});

describe("failover", () => {
  test("walks the ordered offers on 503, 429, auth, timeout; records stats", async () => {
    const seen: string[] = [];
    const call: CallFn = async (o) => {
      seen.push(o.id);
      if (seen.length === 1) return new Response("down", { status: 503 });
      if (seen.length === 2)
        return new Response("slow", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      if (seen.length === 3) return new Response("no", { status: 401 });
      return ok();
    };
    const r = mk(call);
    const res = await r.exec(
      ids(order(OFFERS, parsePolicy("auto", OFFERS))).map((i) =>
        OFFERS.find((o) => o.id === i)!,
      ),
      body,
    );
    expect(seen).toEqual(["d/big", "a/big", "c/mid", "b/small"]);
    expect(res.offer.id).toBe("b/small");
    expect(res.attempts.map((a) => a.status)).toEqual([503, 429, 401, 200]);
    const st = r.store.stats();
    expect(st.get("d/big")!.coolUntil).toBeGreaterThan(Date.now());
    expect(st.get("b/small")!.calls).toBe(1);
    expect(st.get("b/small")!.cost).toBeGreaterThan(0);
  });
  test("never gives up while an offer exists: second round retries after backoff", async () => {
    let n = 0;
    const r = mk(async () =>
      ++n <= OFFERS.length ? new Response("x", { status: 500 }) : ok(),
    );
    const slept: number[] = [];
    const res = await r.exec(OFFERS, body, {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(res.json.choices[0].message.content).toBe("pong");
    expect(slept).toEqual([500]);
  });
  test("exhausted after all rounds returns the attempts", async () => {
    const r = mk(async () => new Response("x", { status: 500 }));
    const err = await r
      .exec(OFFERS, body, { rounds: 2, sleep: async () => {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Exhausted);
    expect(err.attempts.length).toBe(OFFERS.length + 5);
  });
  test("model-specific 4xx fall over, but 4 in a row mean a bad request", async () => {
    const r = mk(async () => new Response("bad", { status: 400 }));
    const err = await r
      .exec(OFFERS, body, { sleep: async () => {} })
      .catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.attempts.length).toBe(4);
  });
  test("failFirst simulates failing offers; empty answers and bad JSON fail over", async () => {
    const seen: string[] = [];
    const r = mk(async (o) => {
      seen.push(o.id);
      return seen.length === 1
        ? Response.json({
            choices: [{ message: { role: "assistant", content: "" } }],
          })
        : ok();
    });
    const res = await r.exec(OFFERS, body, { failFirst: 1 });
    expect(seen.length).toBe(2);
    expect(res.attempts[0]!.status).toBe(503);
  });
  test("streaming: empty stream falls over, SSE passes through", async () => {
    let n = 0;
    const sse = (t: string) =>
      new Response(
        `data: {"choices":[{"delta":{"content":"${t}"}}]}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":1},"choices":[]}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    const r = mk(async () =>
      ++n === 1
        ? new Response("", { headers: { "content-type": "text/event-stream" } })
        : sse("pong"),
    );
    const res = await r.exec(
      OFFERS,
      { ...body, stream: true },
      { stream: true },
    );
    const txt = await new Response(res.stream).text();
    expect(txt).toContain("pong");
    expect(n).toBe(2);
    expect(r.store.stats().get(res.offer.id)!.tokens).toBe(4);
  });
  test("budget stops a caller at zero", async () => {
    const r = mk(async () => ok(), OFFERS.slice(0, 4));
    r.store.setBudget("tok", 0.0000001);
    await r.complete(body, { caller: "tok" });
    const err = await r.complete(body, { caller: "tok" }).catch((e) => e);
    expect(err.status).toBe(402);
    expect(r.store.spent("tok")).toBeGreaterThan(0);
  });
});

describe("arena", () => {
  test("two different models, one answer, a stored pair, votes move Elo", async () => {
    const r = mk(async (o) => ok(`from ${o.id}`));
    const res = await r.complete({ ...body, model: "arena" });
    expect(res.pair).toBeTruthy();
    const p = r.store.pair(res.pair!)!;
    expect(p.a).not.toBe(p.b);
    expect(res.json.model).toBe("arena");
    const v = r.store.vote(res.pair!, "a", "test");
    expect(v.ratings[p.a]).toBeGreaterThan(1000);
    expect(v.ratings[p.b]).toBeLessThan(1000);
    expect(() => r.store.vote(res.pair!, "b", "test")).toThrow(/already voted/);
    const lb = await r.leaderboard();
    expect(lb.local[0]!.model).toBe(p.a);
  });
});

describe("catalog join", () => {
  test("joins models.dev, litellm, openrouter and arena by normalised key", () => {
    expect(norm("anthropic/claude-sonnet-4-5-20260101")).toBe(
      "claude-sonnet-4-5",
    );
    expect(norm("meta-llama/Llama-3.3-70B:free")).toBe("llama-3-3-70b");
    const src = {
      modelsdev: {
        "gpt-x": {
          ctx: 128000,
          out: 16000,
          tools: true,
          vision: true,
          pi: 2,
          po: 8,
        },
      },
      litellm: {
        "gpt-x": { pi: 9, po: 9 },
        "only-lite": { ctx: 8000, pi: 0.5, po: 1 },
      },
      openrouter: {},
      hf: {},
      arena: { "gpt-x": { rating: 1480, votes: 999, name: "GPT X" } },
    };
    const [a, b, c] = join(
      [
        { id: "openai/gpt-x-2026-05-05", provider: "openai" },
        { id: "openrouter/vendor/only-lite", provider: "openrouter" },
        { id: "claude/default", provider: "claude" },
      ],
      new Set(["claude"]),
      src,
    );
    expect(a).toMatchObject({
      key: "gpt-x",
      context: 128000,
      tools: true,
      priceIn: 2,
      priceOut: 8,
      arena: 1480,
    });
    expect(a!.sources).toEqual(["models.dev", "litellm", "arena"]);
    expect(b).toMatchObject({ context: 8000, priceIn: 0.5 });
    expect(c).toMatchObject({ cli: true, tools: false });
  });
});

describe("Anthropic wire", () => {
  test("request: system, tool_use, tool_result, tools", () => {
    const o = anthropicToOpenAI({
      model: "m",
      system: "be brief",
      max_tokens: 50,
      tools: [
        { name: "ls", description: "d", input_schema: { type: "object" } },
      ],
      tool_choice: { type: "any" },
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", id: "t1", name: "ls", input: { p: 1 } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "files" }],
            },
          ],
        },
      ],
    });
    expect(o.messages.map((m: any) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(o.messages[2].tool_calls[0].function.arguments).toBe('{"p":1}');
    expect(o.messages[3]).toMatchObject({
      tool_call_id: "t1",
      content: "files",
    });
    expect((o as any).tools[0].function.name).toBe("ls");
    expect((o as any).tool_choice).toBe("required");
  });
  test("response and SSE", async () => {
    const a = openAIToAnthropic(
      {
        id: "c1",
        choices: [
          {
            message: {
              content: "yo",
              tool_calls: [
                { id: "t", function: { name: "ls", arguments: '{"a":1}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 5 },
      },
      "m",
    );
    expect(a.stop_reason).toBe("tool_use");
    expect(a.content.map((c: any) => c.type)).toEqual(["text", "tool_use"]);
    const src = new Response(
      `data: {"choices":[{"delta":{"content":"po"}}]}\n\ndata: {"choices":[{"delta":{"content":"ng"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t","function":{"name":"ls","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`,
    ).body!;
    const out = await new Response(anthropicStream(src, "m")).text();
    const names = [...out.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
    expect(names).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(out).toContain('"stop_reason":"tool_use"');
  });
});
