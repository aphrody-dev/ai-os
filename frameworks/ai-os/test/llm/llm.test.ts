// Single model bridge: schema validation, tool loop, OpenAI-compatible provider discovered at run time.
import { afterAll, expect, test } from "bun:test";
import {
  generateText,
  listModels,
  resolveModel,
  s,
  tool,
  validate,
} from "../../src/llm/index";
import { call, scriptedModel } from "../../src/llm/testing";

const seen: any[] = [];
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/v1/models": () =>
      Response.json({ data: [{ id: "tiny-1", context_length: 4096 }] }),
    "/v1/chat/completions": {
      POST: async (req) => {
        const j: any = await req.json();
        seen.push(j);
        const last = j.messages.at(-1);
        if (last.role === "tool")
          return Response.json({
            choices: [
              {
                message: { role: "assistant", content: `sum=${last.content}` },
                finish_reason: "stop",
              },
            ],
          });
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "add", arguments: '{"a":2,"b":3}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        });
      },
    },
    "/v1/embeddings": {
      POST: async (req) =>
        Response.json({
          data: ((await req.json()) as any).input.map(
            (_: string, i: number) => ({ embedding: [i, 1] }),
          ),
        }),
    },
  },
});
process.env.RELAY_OPENAI_ENDPOINTS = `fake=${fake.url.origin}/v1`;
afterAll(() => fake.stop(true));

const add = tool({
  description: "Add two numbers",
  inputSchema: s.object({ a: s.number(), b: s.number() }),
  execute: ({ a, b }: { a: number; b: number }) => a + b,
});

test("schema: required, types, enum, url", () => {
  const sc = s.object(
    {
      u: s.string(undefined, { format: "uri" }),
      k: s.enum(["x", "y"]),
      n: s.array(s.number(), { minItems: 1 }),
    },
    ["n"],
  );
  expect(validate(sc, { u: "https://a.b", k: "x" })).toEqual([]);
  expect(validate(sc, { u: "nope", k: "z", n: [] }).length).toBe(3);
  expect(validate(sc, { k: "x" })).toEqual(["$.u: required"]);
});

test("generateText: tool loop, invalid input reported to the model", async () => {
  const m = scriptedModel(
    { toolCalls: [call("1", "add", { a: 1 })] },
    { toolCalls: [call("2", "add", { a: 1, b: 2 })] },
    "3",
  );
  const r = await generateText({
    model: m,
    prompt: "1+2",
    tools: { add },
    maxSteps: 5,
  });
  expect(r.text).toBe("3");
  expect(r.steps[0]!.toolResults[0]!.error).toContain("$.b: required");
  expect(r.steps[1]!.toolResults[0]!.output).toBe(3);
  expect(r.response.map((x) => x.role)).toEqual([
    "assistant",
    "tool",
    "assistant",
    "tool",
    "assistant",
  ]);
});

test("discovered OpenAI-compatible provider: models listed, tool calls over the wire, embeddings", async () => {
  const fakeModels = (await listModels("fake/")).find(
    (p) => p.provider === "fake",
  );
  expect(fakeModels?.models.map((x) => x.id)).toEqual(["fake/tiny-1"]);
  const model = await resolveModel("fake/tiny-1");
  const r = await generateText({
    model,
    system: "be brief",
    prompt: "2+3",
    tools: { add },
    maxSteps: 3,
  });
  expect(r.text).toBe("sum=5");
  expect(seen[0].model).toBe("tiny-1");
  expect(seen[0].tools[0].function.name).toBe("add");
  expect(seen[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "c1",
    content: "5",
  });
  const { resolveEmbedder } = await import("../../src/core/model");
  expect(await resolveEmbedder("fake/tiny-1").embed(["a", "b"])).toEqual([
    [0, 1],
    [1, 1],
  ]);
});

test("echo model and unknown provider", async () => {
  expect(
    (
      await (
        await resolveModel("echo/e")
      ).chat({ messages: [{ role: "user", content: "hi" }] })
    ).text,
  ).toBe("e: hi");
  expect(resolveModel("nope/x")).rejects.toThrow(
    "unknown or inactive provider",
  );
});

test("schema: own keys only, optional undefined, finite numbers; tool loop ignores prototype names", async () => {
  const sc = s.object({ a: s.number(), b: s.string() }, ["b"]);
  expect(validate(sc, { a: 1, b: undefined })).toEqual([]);
  expect(validate(sc, { a: Number.NaN })).toEqual([
    "$.a: expected number, got number",
  ]);
  expect(validate(sc, JSON.parse('{"a":1,"constructor":1}'))).toEqual([
    "$.constructor: unexpected",
  ]);
  const m = scriptedModel({ toolCalls: [call("1", "toString", {})] }, "ok");
  const r = await generateText({
    model: m,
    prompt: "x",
    tools: { add },
    maxSteps: 3,
  });
  expect(r.steps[0]!.toolResults[0]!.error).toBe("unknown tool toString");
  expect(r.text).toBe("ok");
});
