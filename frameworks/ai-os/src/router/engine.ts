// Infinite router: walks the ordered offers until one answers. Failover on 429, 5xx, timeout, auth, quota and
// model-specific 4xx; never gives up while an untried offer exists, then backs off and retries the healthiest.
// Provider calls go through an injectable `CallFn` (fake providers in the unit tests).
import { outboundFetch } from "../relay/outbound.ts";
import { flatten } from "../llm/model.ts";
import { llmAsk } from "../llm/model.ts";
import { providers } from "../llm/models.ts";
import { type Catalog, type Offer, buildCatalog } from "./catalog.ts";
import { TTL, WALK } from "./config.ts";
import { type Need, cost, order, parsePolicy } from "./policy.ts";
import { type OfferStat, Store } from "./stats.ts";

export type Body = Record<string, any> & { model?: string; messages: any[] };
export type CallOpts = { stream: boolean; signal: AbortSignal };
export type CallFn = (
  offer: Offer,
  body: Body,
  o: CallOpts,
) => Promise<Response>;
export type Attempt = {
  offer: string;
  status: number;
  ms: number;
  error?: string;
};
export type Result = {
  offer: Offer;
  attempts: Attempt[];
  /** Non-streaming: the OpenAI completion JSON. */
  json?: any;
  /** Streaming: the upstream SSE bytes (first chunk already validated). */
  stream?: ReadableStream<Uint8Array>;
  pair?: string;
};
export class Exhausted extends Error {
  constructor(
    readonly attempts: Attempt[],
    readonly status = 503,
  ) {
    super(
      `no offer answered (${attempts.length} attempts): ${attempts
        .slice(-3)
        .map((a) => `${a.offer} ${a.status} ${a.error ?? ""}`)
        .join("; ")}`,
    );
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const tokensOf = (b: Body) =>
  Math.ceil(JSON.stringify(b.messages ?? []).length / 4) +
  Math.ceil(JSON.stringify(b.tools ?? []).length / 4);

/** Default provider call: OpenAI-compatible HTTP, or a CLI agent wrapped into an OpenAI answer. */
export const providerCall: CallFn = async (offer, body, o) => {
  const p = providers().find((x) => x.id === offer.provider);
  if (!p) throw new Error(`fournisseur inactif : ${offer.provider}`);
  if (p.chat) {
    const send = async (b: any) =>
      outboundFetch(
        `${p.chat!.base()}${p.chat!.path ?? "/v1/chat/completions"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...p.chat!.headers(),
          },
          body: JSON.stringify(b),
          signal: o.signal,
        },
      );
    const b: any = { ...body, model: offer.model, stream: o.stream };
    if (o.stream)
      b.stream_options = { include_usage: true, ...b.stream_options };
    else delete b.stream_options;
    const r = await send(b);
    // Some servers refuse stream_options: one more try without it, same offer.
    if (o.stream && r.status === 400) {
      delete b.stream_options;
      return send(b);
    }
    return r;
  }
  const prompt = flatten({
    messages: body.messages.map((m: any) => ({
      role: m.role === "developer" ? "system" : m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : (m.content ?? []).map((c: any) => c.text ?? "").join(""),
    })),
  } as any);
  const text = await Promise.race([
    p.ask!(offer.model, prompt),
    new Promise<never>((_, rej) =>
      o.signal.addEventListener("abort", () => rej(new Error("timeout"))),
    ),
  ]);
  const inTok = Math.ceil(prompt.length / 4);
  return Response.json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: offer.id,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: inTok,
      completion_tokens: Math.ceil(text.length / 4),
      total_tokens: inTok,
    },
  });
};

/** SSE of an OpenAI completion (CLI offers and arena answers cannot stream natively). */
export function sseOf(json: any): ReadableStream<Uint8Array> {
  const m = json.choices?.[0]?.message ?? {};
  const base = {
    id: json.id,
    object: "chat.completion.chunk",
    created: json.created,
    model: json.model,
  };
  const frames = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: m.content ?? "",
            ...(m.tool_calls
              ? {
                  tool_calls: m.tool_calls.map((t: any, i: number) => ({
                    index: i,
                    ...t,
                  })),
                }
              : {}),
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: json.choices?.[0]?.finish_reason ?? "stop",
        },
      ],
      usage: json.usage,
    },
  ];
  return new ReadableStream({
    start(c) {
      for (const f of frames)
        c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

export type RunOpts = {
  caller?: string;
  stream?: boolean;
  signal?: AbortSignal;
  /** Simulate a 503 on the first N attempts (failover tests and e2e). */
  failFirst?: number;
  /** Per-attempt timeout (ms): whole answer when not streaming, first byte when streaming. */
  attemptMs?: number;
  /** Total time (ms) after which no new attempt starts. */
  deadlineMs?: number;
  rounds?: number;
  sleep?: (ms: number) => Promise<unknown>;
  need?: Need;
};

export class Router {
  private cat?: Catalog;
  private catP?: Promise<Catalog>;
  constructor(
    readonly store: Store = new Store(),
    private call: CallFn = providerCall,
    private build: (
      s: Store,
      force?: boolean,
    ) => Promise<Catalog> = buildCatalog,
  ) {}

  /** Current catalog: memory, else the sqlite cache, else a fresh build; stale tables refresh in the background. */
  async catalog(force = false): Promise<Catalog> {
    if (force) this.cat = undefined;
    if (this.cat && Date.now() - this.cat.at < TTL.memory) return this.cat;
    const cached = this.store.cacheGet<Catalog>("offers");
    if (!force && cached && Date.now() - cached.ts < TTL.stored) {
      return (this.cat = cached.value);
    }
    this.catP ??= this.build(this.store, force)
      .then((c) => (this.cat = c))
      .finally(() => (this.catP = undefined));
    return this.catP;
  }
  setCatalog(c: Catalog) {
    this.cat = c;
  }

  /** The ordered offers a `model` spec resolves to (no call is made): router_route. */
  async route(spec: string | undefined, body?: Partial<Body>, need: Need = {}) {
    const cat = await this.catalog();
    const policy = parsePolicy(spec, cat.offers);
    const n: Need = {
      tools: !!body?.tools?.length,
      tokens: body?.messages
        ? tokensOf(body as Body) + (body.max_tokens ?? 0)
        : undefined,
      outTokens: body?.max_tokens,
      ...need,
    };
    return {
      policy,
      offers: order(cat.offers, policy, n, this.store.stats()),
      need: n,
    };
  }

  /** Executes a request over an ordered offer list with failover (the core of the infinite router). */
  async exec(offers: Offer[], body: Body, o: RunOpts = {}): Promise<Result> {
    const stream = o.stream ?? body.stream === true;
    const sleep = o.sleep ?? Bun.sleep;
    const deadline = Date.now() + (o.deadlineMs ?? WALK.deadlineMs);
    const attempts: Attempt[] = [];
    const caller = o.caller ?? "anon";
    let forced = o.failFirst ?? 0;
    let clientErrors = 0;
    let lastClient: Attempt | undefined;
    const rounds = o.rounds ?? WALK.rounds;
    const inEst = tokensOf(body);

    const attempt = async (offer: Offer): Promise<Result | undefined> => {
      const t0 = performance.now();
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      o.signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => ac.abort(), o.attemptMs ?? WALK.attemptMs);
      const fail = (status: number, err: string, coolMs = 0) => {
        const ms = performance.now() - t0;
        attempts.push({
          offer: offer.id,
          status,
          ms: Math.round(ms),
          error: err.slice(0, 200),
        });
        this.store.record({
          ts: Date.now(),
          offer: offer.id,
          ok: false,
          status,
          ms,
          inTok: 0,
          outTok: 0,
          cost: 0,
          caller,
          err,
        });
        if (coolMs) this.store.cooldown(offer.id, Date.now() + coolMs);
        if (
          !coolMs &&
          status >= 400 &&
          status < 500 &&
          ![401, 402, 403, 408, 429].includes(status)
        ) {
          clientErrors++;
          lastClient = attempts.at(-1);
        }
        return undefined;
      };
      try {
        o.signal?.throwIfAborted();
        if (forced > 0) {
          forced--;
          return fail(
            503,
            "simulated failure (x-router-fail)",
            WALK.coolServer,
          );
        }
        const res = await this.call(offer, body, { stream, signal: ac.signal });
        if (!res.ok) {
          const text = (await res.text().catch(() => "")).slice(0, 200);
          const ra = Number(res.headers.get("retry-after")) * 1000;
          const cool =
            /upgrade|not available on|quota|billing|credit|insufficient/i.test(
              text,
            )
              ? WALK.coolQuota
              : res.status === 429
                ? Math.min(
                    Math.max(ra || WALK.coolRateDefault, WALK.coolRateMin),
                    WALK.coolRateMax,
                  )
                : res.status === 401 || res.status === 403 || res.status === 402
                  ? WALK.coolAuth
                  : res.status >= 500
                    ? WALK.coolServer
                    : 0;
          return fail(res.status, text || `HTTP ${res.status}`, cool);
        }
        const finish = (json: any, outTxt: number) => {
          const u = json?.usage ?? {};
          const inTok = u.prompt_tokens ?? inEst;
          const outTok = u.completion_tokens ?? Math.ceil(outTxt / 4);
          const ms = performance.now() - t0;
          this.store.record({
            ts: Date.now(),
            offer: offer.id,
            ok: true,
            status: 200,
            ms,
            inTok,
            outTok,
            cost: cost(offer, inTok, outTok),
            caller,
          });
        };
        const ct = res.headers.get("content-type") ?? "";
        if (stream && ct.includes("text/event-stream") && res.body) {
          const reader = res.body.getReader();
          const first = await reader.read();
          if (first.done || !first.value?.length)
            return fail(502, "flux vide", WALK.coolServer);
          const head = dec.decode(first.value);
          if (/^\s*(data:\s*)?\{\s*"error"/.test(head))
            return fail(502, head, WALK.coolServer);
          attempts.push({
            offer: offer.id,
            status: 200,
            ms: Math.round(performance.now() - t0),
          });
          let tail = head;
          const body2 = new ReadableStream<Uint8Array>({
            start: (c) => c.enqueue(first.value),
            pull: async (c) => {
              const r = await reader
                .read()
                .catch((e) => ({ done: true, value: undefined, e }) as any);
              if (r.done) {
                clearTimeout(timer);
                const usage = [...tail.matchAll(/"usage":(\{[^{}]*\})/g)].at(
                  -1,
                )?.[1];
                const text = [
                  ...tail.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g),
                ]
                  .map((m) => m[1])
                  .join("");
                finish({ usage: usage && JSON.parse(usage) }, text.length);
                c.close();
              } else {
                tail = (tail + dec.decode(r.value)).slice(-6000);
                c.enqueue(r.value);
              }
            },
            cancel: () => reader.cancel(),
          });
          return { offer, attempts, stream: body2 };
        }
        const raw = await res.text();
        let json: any;
        try {
          json = JSON.parse(raw);
        } catch {
          return fail(
            502,
            `non-JSON response: ${raw.slice(0, 120)}`,
            WALK.coolServer,
          );
        }
        if (json.error || !json.choices?.length)
          return fail(
            502,
            JSON.stringify(json.error ?? json).slice(0, 200),
            WALK.coolServer,
          );
        const msg = json.choices[0].message ?? {};
        // A reasoning model that spent every token thinking returns no visible answer: try the next offer.
        if (!msg.content && !msg.tool_calls?.length)
          return fail(502, "empty response", WALK.coolEmpty);
        finish(json, String(msg.content ?? "").length);
        attempts.push({
          offer: offer.id,
          status: 200,
          ms: Math.round(performance.now() - t0),
        });
        json.model = offer.id;
        return {
          offer,
          attempts,
          stream: stream ? sseOf(json) : undefined,
          json,
        };
      } catch (e: any) {
        if (o.signal?.aborted) throw e;
        return fail(
          e?.name === "AbortError" || e?.name === "TimeoutError" ? 408 : 599,
          String(e?.message ?? e),
          WALK.coolTimeout,
        );
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      }
    };

    for (let round = 0; round < rounds; round++) {
      // Round 0 follows the policy; later rounds retry every offer, healthiest first (cooldowns ignored).
      let list = offers;
      if (round > 0) {
        const st = this.store.stats();
        list = offers
          .slice()
          .sort(
            (a, b) => (st.get(b.id)?.health ?? 1) - (st.get(a.id)?.health ?? 1),
          );
        list = list.slice(0, WALK.retryPool);
      }
      for (const offer of list) {
        if (Date.now() > deadline) throw new Exhausted(attempts);
        const r = await attempt(offer);
        if (r) return r;
        if (clientErrors >= WALK.clientErrors && lastClient)
          throw new Exhausted(attempts, lastClient.status);
      }
      if (round < rounds - 1)
        await sleep(Math.min(WALK.backoffBase * 2 ** round, WALK.backoffMax));
    }
    throw new Exhausted(attempts);
  }

  /** Resolves `model` and executes: `arena` goes through arena(), everything else through exec(). */
  async complete(body: Body, o: RunOpts = {}): Promise<Result> {
    const cat = await this.catalog();
    const policy = parsePolicy(body.model, cat.offers);
    const caller = o.caller ?? "anon";
    const budget = this.store.budget(caller);
    let maxCost: number | undefined;
    if (budget !== undefined) {
      const left = budget - this.store.spent(caller);
      if (left <= 0)
        throw Object.assign(
          new Error(`budget exhausted for ${caller} (${budget} USD)`),
          { status: 402 },
        );
      maxCost = left;
    }
    const need: Need = {
      tools: !!body.tools?.length,
      tokens: tokensOf(body) + (body.max_tokens ?? 0),
      outTokens: body.max_tokens,
      maxCost,
      ...o.need,
    };
    if (policy.kind === "arena") return this.arena(body, o, need);
    const offers = order(cat.offers, policy, need, this.store.stats());
    if (!offers.length) throw new Exhausted([], 503);
    return this.exec(offers, body, o);
  }

  /** Two different models answer; one answer is returned, the pair is stored for votes (router_vote). */
  async arena(body: Body, o: RunOpts, need: Need): Promise<Result> {
    const cat = await this.catalog();
    const list = order(cat.offers, { kind: "arena" }, need, this.store.stats());
    const live = list.filter((x) => !x.cli);
    const top = (live.length >= 2 ? live : list).slice(0, 8);
    const a = top[Math.floor(Math.random() * Math.min(3, top.length))]!;
    const others = top.filter((x) => x.key !== a.key);
    const b =
      others[Math.floor(Math.random() * others.length)] ??
      list.find((x) => x.key !== a.key) ??
      a;
    const sub = { ...body, stream: false };
    const run = (first: Offer, avoid: string) =>
      this.exec(
        [first, ...list.filter((x) => x.id !== first.id && x.key !== avoid)],
        sub,
        { ...o, stream: false },
      ).catch(() => undefined);
    const [ra, rb] = await Promise.all([run(a, b.key), run(b, a.key)]);
    const ok = [ra, rb].filter((x): x is Result => !!x);
    if (!ok.length)
      throw new Exhausted([...(ra?.attempts ?? []), ...(rb?.attempts ?? [])]);
    const flip = Math.random() < 0.5;
    const [shown, hidden] =
      ok.length === 2 ? (flip ? [ra!, rb!] : [rb!, ra!]) : [ok[0]!, undefined];
    const out: Result = { ...shown };
    out.json = { ...shown.json, model: "arena" };
    if (hidden && hidden.offer.key !== shown.offer.key) {
      const id = crypto.randomUUID().slice(0, 12);
      const txt = (r: Result) =>
        String(r.json.choices[0].message.content ?? "");
      this.store.savePair({
        id,
        ts: Date.now(),
        prompt: JSON.stringify(body.messages.at(-1)?.content ?? "").slice(
          0,
          4000,
        ),
        a: shown.offer.key,
        b: hidden.offer.key,
        ansA: txt(shown),
        ansB: txt(hidden),
      });
      out.pair = id;
      out.json.router = { mode: "arena", pair_id: id };
    }
    out.attempts = [...shown.attempts, ...(hidden?.attempts ?? [])];
    out.stream = o.stream ? sseOf(out.json) : undefined;
    return out;
  }

  /** A judge model reads both answers of a pair and votes (a = the answer that was returned). */
  async judge(pairId: string, judge?: string) {
    const p = this.store.pair(pairId);
    if (!p) throw new Error(`unknown pair: ${pairId}`);
    const model =
      judge ??
      (await this.route("auto:fast")).offers.find(
        (x) => x.key !== p.a && x.key !== p.b,
      )?.id;
    if (!model) throw new Error("no judge model available");
    const r = await llmAsk(
      model,
      `Question:\n${p.prompt}\n\n=== A ===\n${p.ansA.slice(0, 6000)}\n\n=== B ===\n${p.ansB.slice(0, 6000)}\n\nWhich answer is better (correct, complete, concise)? Reply with exactly one token: A, B or TIE.`,
      "You are an impartial judge of two answers. Output only A, B or TIE.",
      { temperature: 0 },
    );
    const w = /\b(TIE|A|B)\b/i.exec(r.text)?.[1]?.toLowerCase();
    if (!w)
      throw new Error(
        `unreadable verdict from judge ${model}: ${r.text.slice(0, 80)}`,
      );
    return {
      ...this.store.vote(pairId, w as "a" | "b" | "tie", `judge:${model}`),
      judge: model,
      verdict: w,
    };
  }

  /** Public arena rating next to the local Elo, per model key. */
  async leaderboard(limit = 50) {
    const cat = await this.catalog();
    const elo = new Map(this.store.elo().map((e) => [e.model, e]));
    const keys = new Map<
      string,
      { model: string; arena?: number; votes?: number; offers: number }
    >();
    for (const o of cat.offers) {
      const e = keys.get(o.key) ?? { model: o.key, offers: 0 };
      e.offers++;
      if (o.arena !== undefined) {
        e.arena = o.arena;
        e.votes = o.arenaVotes;
      }
      keys.set(o.key, e);
    }
    for (const k of elo.keys())
      if (!keys.has(k)) keys.set(k, { model: k, offers: 0 });
    const rows = [...keys.values()].map((e) => ({
      ...e,
      elo: elo.get(e.model)?.rating,
      battles: elo.get(e.model)?.battles ?? 0,
      wins: elo.get(e.model)?.wins ?? 0,
    }));
    // Two scales, never mixed: local Elo (battles judged through this router) and the public Arena rating.
    return {
      local: rows
        .filter((e) => e.elo !== undefined)
        .sort((a, b) => b.elo! - a.elo!)
        .slice(0, limit),
      arena: rows
        .filter((e) => e.arena !== undefined)
        .sort((a, b) => b.arena! - a.arena!)
        .slice(0, limit),
    };
  }

  stats(): Record<string, OfferStat> {
    return Object.fromEntries(this.store.stats());
  }
}
