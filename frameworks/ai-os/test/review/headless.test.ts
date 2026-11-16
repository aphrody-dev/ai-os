// Headless review: structured JSON output, deterministic cache keys, engine fallback on billing/quota, Vertex provider
// with a generated service-account key and a stubbed fetch. No network, no real credentials.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { llmAsk } from "../../src/llm/model.ts";
import { classify } from "../../src/orch/classify.ts";
import { Health } from "../../src/orch/health.ts";
import {
  bundleFiles,
  cachedEngine,
  collect,
  type Config,
  type Engine,
  engineKey,
  enginesFor,
  interpret,
  review,
  type Skipped,
  voicePrompt,
} from "../../src/review/index.ts";
import {
  DEFAULT_SCHEMA,
  parseReview,
  validate,
  wireSchema,
} from "../../src/review/schema.ts";

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ai-os-headless-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const finding = {
  file: "src/a.ts",
  line: 3,
  severity: "high",
  title: "unchecked input",
  breaks: "path traversal",
  fix: "validate the path",
  source: "checklist:bun-ts",
};
const good = {
  score: 12.5,
  verdict: "changes",
  findings: [finding],
  to_confirm: [],
  summary: "one defect",
};

test("schema: valid, fenced with prose, invalid, partial and truncated answers", () => {
  const ok = parseReview(JSON.stringify(good));
  expect(ok.ok && ok.review.score).toBe(12.5);
  expect(ok.ok && ok.partial).toBe(false);
  const fenced = parseReview(
    `Here is the review:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\nDone.`,
  );
  expect(fenced.ok).toBe(true);

  const bad = parseReview(JSON.stringify({ ...good, score: 25 }));
  expect(bad.ok).toBe(false);
  expect(!bad.ok && bad.error).toContain("above 20");
  expect(parseReview("Score: 12/20").ok).toBe(false);
  expect(parseReview(JSON.stringify({ ...good, verdict: "maybe" })).ok).toBe(
    false,
  );

  const partial = parseReview(
    JSON.stringify({
      ...good,
      findings: [finding, { ...finding, severity: "urgent" }, { file: "x" }],
    }),
  );
  expect(partial.ok).toBe(true);
  if (partial.ok) {
    expect(partial.partial).toBe(true);
    expect(partial.review.findings).toHaveLength(1);
    expect(partial.warnings).toHaveLength(2);
  }

  const cut = parseReview(JSON.stringify(good).slice(0, 60));
  expect(cut.ok).toBe(false);
  expect(!cut.ok && cut.truncated).toBe(true);

  // wire schema drops what Gemini-family response schemas reject; local validation keeps it
  expect(JSON.stringify(wireSchema(DEFAULT_SCHEMA))).not.toContain(
    "additionalProperties",
  );
  expect(validate(DEFAULT_SCHEMA, { ...good, extra: 1 })).toContain(
    "$.extra: unexpected",
  );
});

test("interpret: strict rejects markdown, lenient accepts it, partial is flagged", () => {
  expect(interpret("Score: 9/20", DEFAULT_SCHEMA, true).ok).toBe(false);
  const lenient = interpret("Score: 9/20", DEFAULT_SCHEMA, false);
  expect(lenient).toMatchObject({ ok: true, score: 9 });
  const s = interpret(JSON.stringify(good), DEFAULT_SCHEMA, true);
  expect(s.text).toContain("Score: 12.5/20");
  expect(s.findings![0]).toMatchObject({
    where: "src/a.ts:3",
    severity: "high",
  });
  const p = interpret(
    JSON.stringify({ ...good, findings: [finding, { file: "x" }] }),
    DEFAULT_SCHEMA,
    true,
  );
  expect(p.partial).toBe(true);
  expect(p.text).toContain("Dropped findings");
});

test("prompt: template placeholders, unknown placeholder refused, contract carries the schema", () => {
  const v = { label: "L", stance: "S" };
  const t = {
    title: "t",
    spec: [],
    files: ["a.ts"],
    text: "x",
    truncated: 0,
    kind: "paths" as const,
  };
  const g = { topics: [], text: "", sources: [], checklists: [] };
  const p = voicePrompt(v, t, g, [], {
    schema: DEFAULT_SCHEMA,
    rubric: "Weigh security first.",
    template: "{{label}}|{{rubric}}|{{contract}}",
  });
  expect(p.startsWith("L|Weigh security first.|")).toBe(true);
  expect(p).toContain('"required":["score","verdict"');
  expect(() => voicePrompt(v, t, g, [], { template: "{{nope}}" })).toThrow(
    /nope/,
  );
});

test("cache key: same input same key, any option or prompt change a new key; second call is a hit", async () => {
  const opts = {
    temperature: 0,
    seed: 7,
    schema: wireSchema(DEFAULT_SCHEMA),
    thinking: "high",
  };
  expect(engineKey("google-vertex/m", "p", opts)).toBe(
    engineKey("google-vertex/m", "p", { ...opts }),
  );
  // key order of the options does not matter (canonical JSON)
  expect(engineKey("e", "p", { seed: 7, temperature: 0 })).toBe(
    engineKey("e", "p", { temperature: 0, seed: 7 }),
  );
  const base = engineKey("e", "p", opts);
  expect(engineKey("e", "p", { ...opts, seed: 8 })).not.toBe(base);
  expect(engineKey("e", "p", { ...opts, thinking: "low" })).not.toBe(base);
  expect(engineKey("e", "p2", opts)).not.toBe(base);
  expect(engineKey("e2", "p", opts)).not.toBe(base);

  let calls = 0;
  const seen: any[] = [];
  const call = (async (
    _h: unknown,
    _p: string,
    _prompt: string,
    _t: number,
    o: unknown,
  ) => {
    calls++;
    seen.push(o);
    return { ok: true, text: JSON.stringify(good), ms: 1, tokens: 1 };
  }) as any;
  const e = cachedEngine(
    { id: "t", local: true, src: ".", roles: [], maxAgents: 1 },
    { db: ":memory:", call },
  );
  const a = await e("e", "p", 1000, opts);
  const b = await e("e", "p", 1000, { ...opts });
  expect(a.cache).toBe("miss");
  expect(b.cache).toBe("hit");
  expect(calls).toBe(1);
  expect(seen[0]).toMatchObject({ temperature: 0, seed: 7, thinking: "high" });
  // an answer that is not a valid review is never cached
  const junk = cachedEngine(
    { id: "t", local: true, src: ".", roles: [], maxAgents: 1 },
    {
      db: ":memory:",
      call: (async () => ({
        ok: true,
        text: "looks fine",
        ms: 1,
        tokens: 1,
      })) as any,
    },
  );
  await junk("e", "p", 1000, opts);
  expect((await junk("e", "p", 1000, opts)).cache).not.toBe("hit");
});

test("classify: billing and quota are quota, disabled API is missing", () => {
  expect(
    classify(
      'google-vertex/gemini-4-carbon : HTTP 403 {"message":"This API method requires billing to be enabled","status":"PERMISSION_DENIED"}',
    ),
  ).toBe("quota");
  expect(
    classify(
      "HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded for aiplatform.googleapis.com",
    ),
  ).toBe("quota");
  expect(
    classify(
      "HTTP 403 Vertex AI API has not been used in project 123 before or it is disabled (SERVICE_DISABLED)",
    ),
  ).toBe("missing");
  expect(classify("HTTP 403 ACCESS_DENIED")).toBe("auth");
});

const cfg = (): Config => ({
  threshold: 16,
  timeout_s: 60,
  max_bytes: 10_000,
  grounding_chars: 1000,
  rounds: 1,
  stale_rounds: 2,
  topics: {},
  sources: [],
  sampling: { temperature: 0, seed: 42 },
  output: { strict: true },
  voices: {
    gemini: { label: "Gemini", stance: "s", thinking: "high" },
  },
});

test("fallback: billing then quota failures move to the next engine, sampling and schema reach the engine", async () => {
  const d = tmp();
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
  Bun.spawnSync(["git", "-C", d, "init", "-q", "-b", "main"]);
  const sent: { p: string; o: any }[] = [];
  const engine: Engine = async (p, _prompt, _t, o) => {
    sent.push({ p, o });
    if (p === "google-vertex/gemini-4-carbon")
      return {
        ok: false,
        text: "HTTP 403 billing must be enabled for the project",
        cls: classify("HTTP 403 billing must be enabled for the project"),
        ms: 1,
      };
    if (p === "google/gemini-4-carbon")
      return {
        ok: false,
        text: "HTTP 429 Quota exceeded",
        cls: classify("HTTP 429 Quota exceeded"),
        ms: 1,
      };
    if (p === "agy") return { ok: true, text: "Score: 18/20", ms: 1 }; // markdown refused in strict mode
    return {
      ok: true,
      text: JSON.stringify({ ...good, score: 17, findings: [] }),
      ms: 1,
    };
  };
  const r = await review({
    root: d,
    spec: ["src/a.ts"],
    config: cfg(),
    engine,
    providers: async () => [
      "google-vertex/gemini-4-carbon",
      "google/gemini-4-carbon",
      "agy",
      "codex",
    ],
    sources: null,
    nhitl: null,
    write: false,
    slug: "t",
  });
  const v = r.voices[0]!;
  expect(v.provider).toBe("codex");
  expect(v.attempts.map((a) => [a.provider, a.cls])).toEqual([
    ["google-vertex/gemini-4-carbon", "quota"],
    ["google/gemini-4-carbon", "quota"],
    ["agy", "task"],
    ["codex", undefined],
  ]);
  expect(v.attempts[2]!.note).toContain("structured output");
  expect(r.score).toBe(17);
  expect(r.status).toBe("compliant");
  expect(sent[0]!.o).toMatchObject({
    temperature: 0,
    seed: 42,
    thinking: "high",
    schemaName: "review",
  });
  expect(sent[0]!.o.schema.required).toContain("findings");
  expect(JSON.stringify(sent[0]!.o.schema)).not.toContain(
    "additionalProperties",
  );

  // partial findings never pass the gate
  const partial: Engine = async () => ({
    ok: true,
    text: JSON.stringify({ ...good, score: 19, findings: [{ file: "x" }] }),
    ms: 1,
  });
  const p = await review({
    root: d,
    spec: ["src/a.ts"],
    config: cfg(),
    engine: partial,
    providers: async () => ["e"],
    sources: null,
    nhitl: null,
    write: false,
  });
  expect(p.score).toBe(19);
  expect(p.status).toBe("incomplete");
});

test("engine order: gemini-web first, then ranked and fallback families; cooling engines reported with their class", async () => {
  const d = tmp();
  const health = new Health(join(d, "h.sqlite"));
  const host = { id: "t", local: true, src: ".", roles: [], maxAgents: 1 };
  const all = [
    { id: "agy", kind: "cli" as const, why: "x" },
    { id: "codex", kind: "cli" as const, why: "x" },
    { id: "claude", kind: "cli" as const, why: "x" },
    { id: "openai/gemini-4-carbon", kind: "model" as const, why: "x" },
    { id: "google/gemini-4-carbon", kind: "model" as const, why: "x" },
  ];
  const v = {
    label: "G",
    stance: "s",
    engines: ["gemini-web"],
    only: ["^agy(:|$)", "gemini"],
    ignore: ["^google/"],
    prefer: ["^agy(:|$)"],
    model: "gemini-4-carbon",
    fallback: ["^codex(:|$)"],
  };
  const order = await enginesFor(v, host, health, all);
  expect(order[0]).toBe("gemini-web");
  expect(order[1]).toBe("agy");
  expect(order.at(-1)).toBe("codex");
  expect(order).not.toContain("claude");
  expect(order).not.toContain("google/gemini-4-carbon");
  health.record("t", "gemini-web", false, "login", 1);
  health.record("t", "agy", false, "quota", 1);
  const skipped: Skipped[] = [];
  const next = await enginesFor(v, host, health, all, undefined, skipped);
  expect(next).not.toContain("gemini-web");
  expect(next).not.toContain("agy");
  expect(skipped).toContainEqual({
    provider: "gemini-web",
    reason: "cooling down after login",
  });
  expect(skipped).toContainEqual({
    provider: "agy",
    reason: "cooling down after quota",
  });
  health.close();
});

test("bundle headers and glob targets", async () => {
  expect(
    bundleFiles("===== FILE: a/b.ts =====\nx\n===== c.md =====\ny"),
  ).toEqual(["a/b.ts", "c.md"]);
  const d = tmp();
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "a.ts"), "a\n");
  writeFileSync(join(d, "src", "b.md"), "b\n");
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", d, ...a]);
  g("init", "-q", "-b", "main");
  g("add", ".");
  const t = await collect(["src/*.ts"], { root: d });
  expect(t.files).toEqual(["src/a.ts"]);
  const e = await collect(["src"], {
    root: d,
    globs: { exclude: ["**/*.md"] },
  });
  expect(e.files).toEqual(["src/a.ts"]);
});

test("optional sampling parameters refused by an endpoint are dropped and the call is retried once", async () => {
  const bodies: any[] = [];
  const saved = {
    ep: Bun.env.RELAY_OPENAI_ENDPOINTS,
    cache: Bun.env.RELAY_CACHE,
  };
  Bun.env.RELAY_OPENAI_ENDPOINTS = "seedless=http://127.0.0.1:9";
  Bun.env.RELAY_CACHE = "0";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    if ("seed" in b)
      return Response.json(
        {
          error: {
            code: 400,
            message:
              'Invalid JSON payload received. Unknown name "seed": Cannot find field.',
          },
        },
        { status: 400 },
      );
    return Response.json({
      choices: [
        { message: { content: JSON.stringify(good) }, finish_reason: "stop" },
      ],
    });
  }) as typeof fetch;
  try {
    const r = await llmAsk("seedless/m", "hi", undefined, {
      temperature: 0,
      seed: 9,
    });
    expect(JSON.parse(r.text).score).toBe(12.5);
    expect(bodies).toHaveLength(2);
    expect("seed" in bodies[0]).toBe(true);
    expect("seed" in bodies[1]).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
    saved.ep === undefined
      ? delete Bun.env.RELAY_OPENAI_ENDPOINTS
      : (Bun.env.RELAY_OPENAI_ENDPOINTS = saved.ep);
    saved.cache === undefined
      ? delete Bun.env.RELAY_CACHE
      : (Bun.env.RELAY_CACHE = saved.cache);
  }
});
