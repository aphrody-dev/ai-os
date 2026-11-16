// Orchestrator: failure classification, declarative routing, graph (parallelism, expansion, cycle, fix
// ticket, withheld external effect, limits), runner v1 queue. Local host only, no real engine.
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_HOME = mkdtempSync(join(tmpdir(), "ai-os-orch-"));
const { classify, retryAfterMs, switches } =
  await import("../../src/orch/classify.ts");
const { Health } = await import("../../src/orch/health.ts");
const { rank } = await import("../../src/orch/select.ts");
const { runWorkflow } = await import("../../src/orch/run.ts");
const Q = await import("../../src/orch/queue.ts");
import type { Host } from "../../src/orch/fleet.ts";

const root = mkdtempSync(join(tmpdir(), "ai-os-orch-root-"));
const local: Host = {
  id: "pc",
  local: true,
  src: root,
  roles: ["coder", "reviewer"],
  maxAgents: 2,
};
const opts = { hosts: [local], root, limits: { pollMs: 50 } };

test("failure classes: quota, throttle, auth, missing, context", () => {
  expect(classify("Error: RESOURCE_EXHAUSTED: credits balance is 0")).toBe(
    "quota",
  );
  expect(classify("HTTP 402 Payment Required")).toBe("quota");
  expect(classify("429 Too Many Requests, retry-after: 7")).toBe("throttle");
  expect(retryAfterMs("429 Too Many Requests, retry-after: 7")).toBe(7000);
  expect(classify("Failed to authenticate: OAuth session expired")).toBe(
    "auth",
  );
  expect(classify("", 127)).toBe("missing");
  expect(classify("prompt is too long: 250000 tokens")).toBe("context");
  expect(classify("assertion failed in foo.ts")).toBe("task");
  expect(switches("quota") && switches("auth") && !switches("throttle")).toBe(
    true,
  );
});

test("routing: preferred model followed by its CLI, cooldown and exclusions", () => {
  const h = new Health(join(process.env.AGENT_HOME!, "rank.sqlite"));
  const all = [
    { id: "claude", kind: "cli" as const, why: "" },
    { id: "agy", kind: "cli" as const, why: "" },
    { id: "ollama/m", kind: "model" as const, why: "", cost: 0, context: 8000 },
  ];
  expect(rank("pc", all, { models: ["agy:x-high"] }, h).slice(0, 2)).toEqual([
    "agy:x-high",
    "agy",
  ]);
  expect(rank("pc", all, { edit: true }, h)).not.toContain("ollama/m");
  expect(rank("pc", all, { context: 100_000 }, h)).toContain("claude");
  expect(rank("pc", all, { context: 100_000 }, h)).not.toContain("ollama/m");
  h.record("pc", "claude", false, "auth", 10);
  expect(rank("pc", all, {}, h)).not.toContain("claude");
  expect(rank("pc", all, {}, h, ["agy"])).not.toContain("agy");
  expect(rank("pc", all, { only: ["^ollama/"] }, h)).toEqual(["ollama/m"]);
  // Observed reliability: the engine that succeeds comes first.
  for (let i = 0; i < 3; i++) h.record("pc", "ollama/m", true, null, 100);
  expect(rank("pc", all, { ignore: ["^claude"] }, h)[0]).toBe("ollama/m");
  h.close();
});

test("graph: parallelism, chained outputs, dynamic expansion", async () => {
  const events: string[] = [];
  const r = await runWorkflow(
    {
      name: "t1",
      steps: [
        {
          id: "a",
          do: "cmd",
          run: "bun -e \"await Bun.sleep(300); console.log('A')\"",
        },
        {
          id: "b",
          do: "cmd",
          run: "bun -e \"await Bun.sleep(300); console.log('B')\"",
        },
        {
          id: "gen",
          do: "cmd",
          deps: ["a", "b"],
          expand: true,
          run: `bun -e "console.log(JSON.stringify({steps:[{id:'c',do:'cmd',run:'echo child'}]}))"`,
        },
      ],
    },
    { ...opts, onEvent: (e) => events.push(`${e.event}:${e.step ?? ""}`) },
  );
  expect(r.ok).toBe(true);
  const ids = r.steps.map((s) => s.id);
  expect(ids).toContain("gen.c");
  expect(r.steps.find((s) => s.id === "gen.c")!.output).toContain("child");
  // a and b in parallel: both started before the first finished.
  const firstEnd = events.findIndex((e) => e.startsWith("end:"));
  expect(events.indexOf("start:a")).toBeLessThan(firstEnd);
  expect(events.indexOf("start:b")).toBeLessThan(firstEnd);
});

test("cycle detected, missing dependency rejected", async () => {
  const r = await runWorkflow(
    {
      name: "t2",
      steps: [
        { id: "x", do: "cmd", deps: ["y"], run: "echo x" },
        { id: "y", do: "cmd", deps: ["x"], run: "echo y" },
      ],
    },
    opts,
  );
  expect(r.ok).toBe(false);
  expect(r.steps.every((s) => s.status === "skipped")).toBe(true);
  expect(
    runWorkflow(
      {
        name: "t3",
        steps: [{ id: "z", do: "cmd", deps: ["nope"], run: "echo" }],
      },
      opts,
    ),
  ).rejects.toThrow();
});

test("command failure: fix ticket, dependents wait then are skipped without a worker", async () => {
  const r = await runWorkflow(
    {
      name: "t4",
      steps: [
        { id: "lint", do: "cmd", run: 'bun -e "process.exit(3)"' },
        { id: "after", do: "cmd", deps: ["lint"], run: "echo after" },
      ],
    },
    opts,
  );
  const lint = r.steps.find((s) => s.id === "lint")!;
  expect(lint.fixedBy).toBe("lint#fix1");
  const fix = r.steps.find((s) => s.id === "lint#fix1")!;
  expect(fix.status).toBe("failed"); // no coder worker: an edit step does not run outside the queue
  expect(r.steps.find((s) => s.id === "after")!.status).toBe("skipped");
  expect(r.ok).toBe(false);
});

test("external effect: withheld without an owner rule, allowed with one", async () => {
  const wf = {
    name: "t5",
    steps: [
      {
        id: "publish-x",
        do: "cmd" as const,
        effect: "external" as const,
        run: "echo published",
      },
    ],
  };
  const r = await runWorkflow(wf, opts);
  const s = r.steps[0]!;
  expect(s.status).toBe("held");
  expect(existsSync(join(root, s.note!))).toBe(true);
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "owner-rules.json"),
    JSON.stringify({ rules: [{ effect: "external", step: "publish-x" }] }),
  );
  const r2 = await runWorkflow(wf, opts);
  expect(r2.steps[0]!.status).toBe("done");
  expect(r2.steps[0]!.output).toContain("published");
});

test("guardrails: stop after consecutive failures, step limit", async () => {
  const steps = ["f1", "f2", "f3"].map((id) => ({
    id,
    do: "cmd" as const,
    run: 'bun -e "process.exit(1)"',
    onFail: "stop" as const,
  }));
  const r = await runWorkflow(
    {
      name: "t6",
      steps: [...steps, { id: "later", do: "cmd", deps: ["f1"], run: "echo" }],
    },
    { ...opts, limits: { ...opts.limits, maxConsecutiveFailures: 2 } },
  );
  expect(r.ok).toBe(false);
  expect(
    runWorkflow(
      {
        name: "t7",
        steps: Array.from({ length: 5 }, (_, i) => ({
          id: `s${i}`,
          do: "cmd" as const,
          run: "echo",
        })),
      },
      { ...opts, limits: { maxSteps: 3 } },
    ),
  ).rejects.toThrow(/step limit/);
});

test("queue v1: atomic drop, final result read, output of the accepted attempt", async () => {
  const id = "t-queue-1";
  await Q.enqueue(local, {
    v: 1,
    id,
    prompt: "p",
    role: "coder",
    host: "pc",
    providers: ["claude"],
  });
  const base = join(root, "var", "agents");
  expect(existsSync(join(base, "queue", "new", `${id}.json`))).toBe(true);
  expect(
    JSON.parse(readFileSync(join(base, "queue", "new", `${id}.json`), "utf8"))
      .v,
  ).toBe(1);
  expect(await Q.poll(local, id)).toBeNull();
  // Simulates the runner: done + result.json + log of attempt 0.
  mkdirSync(join(base, "queue", "done"), { recursive: true });
  mkdirSync(join(base, "results", id), { recursive: true });
  writeFileSync(join(base, "queue", "done", `${id}.json`), "{}");
  const attempt = {
    provider: "claude:m",
    exit: 0,
    reason: "ok",
    started: "",
    ended: "",
  };
  writeFileSync(
    join(base, "results", id, "result.json"),
    JSON.stringify({ id, status: "done", host: "pc", attempts: [attempt] }),
  );
  writeFileSync(join(base, "results", id, "0-claude_m.log"), "sortie");
  const r = await Q.poll(local, id);
  expect(r?.status).toBe("done");
  expect(await Q.output(local, r!)).toBe("sortie");
  mkdirSync(join(base, "state"), { recursive: true });
  writeFileSync(join(base, "state", "heartbeat-coder"), "1");
  writeFileSync(join(base, "state", "cooldown-agy_x"), "1");
  const s = await Q.runnerState(local);
  expect(s.roles).toEqual(["coder"]);
  expect(s.cooling).toEqual(["agy_x"]);
});

test("review: dated Retry-After, HTTP codes without context, balanced JSON", async () => {
  const { balancedSteps } = await import("../../src/orch/run.ts");
  const now = Date.parse("2026-11-13T10:00:00Z");
  expect(retryAfterMs("Retry-After: Fri, 13 Nov 2026 10:00:20 GMT", now)).toBe(
    20_000,
  );
  expect(retryAfterMs("retry-after-ms: 1500")).toBe(1500);
  // An agent that quotes "line 401" or "500 ms" in its output is not an authentication failure.
  expect(classify("see line 401 and a delay of 500 ms")).toBe("task");
  expect(classify("HTTP 401 Unauthorized")).toBe("auth");
  expect(classify("status: 503 Service Unavailable")).toBe("overload");
  expect(classify("RESOURCE_EXHAUSTED: requests per minute")).toBe("throttle");
  expect(
    balancedSteps(
      'before {"x":1} then {"steps":[{"id":"a","run":"echo }"}]} after {"y":2}',
    ),
  ).toBe('{"steps":[{"id":"a","run":"echo }"}]}');
});

test("expansion: the parent's dependents wait for the generated steps", async () => {
  const events: string[] = [];
  const r = await runWorkflow(
    {
      name: "t8",
      steps: [
        {
          id: "gen",
          do: "cmd",
          expand: true,
          run: `bun -e "console.log(JSON.stringify({steps:[{id:'slow',do:'cmd',run:'bun -e \\\\'await Bun.sleep(300)\\\\''}]}))"`,
        },
        { id: "after", do: "cmd", deps: ["gen"], run: "echo after" },
      ],
    },
    { ...opts, onEvent: (e) => events.push(`${e.event}:${e.step ?? ""}`) },
  );
  expect(r.ok).toBe(true);
  expect(events.indexOf("end:gen.slow")).toBeLessThan(
    events.indexOf("start:after"),
  );
});

test("routing: Jules only on explicit request, repository in the template location", () => {
  const h = new Health(join(process.env.AGENT_HOME!, "rank-jules.sqlite"));
  const all = [{ id: "claude", kind: "cli" as const, why: "" }];
  expect(rank("pc", all, { edit: true }, h)).not.toContain("jules");
  expect(
    rank(
      "pc",
      all,
      { edit: true, models: ["jules:aphrody-labs/src"] },
      h,
    ).slice(0, 2),
  ).toEqual(["jules:aphrody-labs/src", "jules"]);
  expect(rank("pc", all, { only: ["^jules"] }, h)).toEqual(["jules"]);
  h.close();
});
