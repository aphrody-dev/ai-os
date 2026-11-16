import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmulateFetch, scriptedModel } from "../../src/llm/testing";
import {
  council,
  parseDotEnv,
  redactText,
  route,
  runSandboxedJs,
} from "../../src/core/index";
import { runJustBash } from "../../src/core/shell";
import {
  applyPatch,
  diffToPatches,
  JsonToSseTransformStream,
  UI_MESSAGE_STREAM_HEADERS,
  validateUISpec,
} from "../../src/gateway/index";
import { RetryableHttpError, retryWithBackoff } from "../../src/llm/index";

const say = (text: string) => scriptedModel(text);

test("redactText: tokens, bearer, env literals", () => {
  const out = redactText(
    "k=ghp_abcdefghij1234 Bearer abcdefghijklmnop pw=hunter2hunter2",
    { DB_PASSWORD: "hunter2hunter2" },
  );
  expect(out).not.toContain("ghp_abcdefghij1234");
  expect(out).not.toContain("abcdefghijklmnop");
  expect(out).toContain("[REDACTED:DB_PASSWORD:len=14]");
});

test("parseDotEnv", () => {
  expect(parseDotEnv('# c\nexport A=1\nB="x y"\nC=z # note\n1BAD=no')).toEqual({
    A: "1",
    B: "x y",
    C: "z",
  });
});

test("council and route", async () => {
  const r = await council(
    [
      { id: "a", kind: "model", model: say("yes") },
      { id: "b", kind: "cli", argv: () => ["bun", "-e", "process.exit(3)"] },
    ],
    "q",
  );
  expect(r.succeeded).toBe(1);
  expect(r.summary).toContain("## a (ok");
  const rt = await route(
    [
      { id: "bad", kind: "cli", argv: () => ["bun", "-e", "process.exit(1)"] },
      { id: "good", kind: "model", model: say("ok") },
    ],
    "q",
  );
  expect(rt.output).toBe("ok");
  expect(rt.trail).toEqual(["bad:err", "good:ok"]);
});

test("runJustBash: OverlayFs sandbox reads workspace and isolates writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "just-bash-"));
  try {
    writeFileSync(join(dir, "hello.txt"), "world\n");
    const r = await runJustBash(
      "cat hello.txt && echo temp > scratch.txt && cat scratch.txt",
      dir,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("world");
    expect(r.stdout).toContain("temp");
    expect(await Bun.file(join(dir, "scratch.txt")).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vercel core: retryWithBackoff and UIMessageStream", async () => {
  let calls = 0;
  const res = await retryWithBackoff(
    async () => {
      calls++;
      if (calls < 2) throw new RetryableHttpError("rate", 429);
      return "ok";
    },
    { initialDelayInMs: 1, maxRetries: 2 },
  );
  expect(res).toBe("ok");
  expect(calls).toBe(2);
  expect(UI_MESSAGE_STREAM_HEADERS["x-vercel-ai-ui-message-stream"]).toBe("v1");
  const s = new ReadableStream({
    start(c) {
      c.enqueue({ type: "text-delta", delta: "hi" });
      c.close();
    },
  }).pipeThrough(new JsonToSseTransformStream());
  const chunks = await Array.fromAsync(s);
  expect(chunks[0]).toContain('"type":"text-delta"');
  expect(chunks[1]).toBe("data: [DONE]\n\n");
});

test("vercel-labs/run: runSandboxedJs isolates globals, supports host fns, enforces timeout", async () => {
  const ok = await runSandboxedJs(
    'console.log("hi"); return await host.double(21);',
    { hostFunctions: { double: (n) => Number(n) * 2 } },
  );
  expect(ok.ok).toBe(true);
  expect(ok.value).toBe(42);
  expect(ok.logs).toEqual(["hi"]);

  const blocked = await runSandboxedJs("return process.env;");
  expect(blocked.ok).toBe(false);
  expect(blocked.error).toContain("disallowed");

  const timed = await runSandboxedJs("while (true) {}", { timeoutMs: 40 });
  expect(timed.ok).toBe(false);
  expect(timed.error).toContain("timeout");
});

test("vercel-labs/json-render: diffToPatches, applyPatch, validateUISpec", () => {
  const a = {
    root: "card",
    elements: { card: { type: "Card", props: { title: "A" } } },
  };
  const b = {
    root: "card",
    elements: { card: { type: "Card", props: { title: "B", open: true } } },
  };
  const patches = diffToPatches(a, b);
  expect(patches.length).toBe(2);
  expect(applyPatch(a, patches)).toEqual(b);
  expect(validateUISpec(b, ["Card"]).ok).toBe(true);
  expect(validateUISpec(b, ["Button"]).ok).toBe(false);
});

test("vercel-labs/emulate: createEmulateFetch serves local routes without network", async () => {
  const f = createEmulateFetch([
    { method: "GET", match: "/v1/ping", handle: () => ({ pong: true }) },
  ]);
  const res = await f("https://api.example.invalid/v1/ping");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ pong: true });
  const miss = await f("https://api.example.invalid/v1/other");
  expect(miss.status).toBe(404);
});
