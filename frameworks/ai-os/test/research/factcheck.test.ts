import { expect, test } from "bun:test";
import { scriptedModel } from "../../src/llm/testing";
import {
  factCheck,
  factCheckReport,
  searchLibraries,
} from "../../src/research/index";

const say = (...t: string[]) => scriptedModel(...t);

test("factCheck: claims -> verdicts -> report", async () => {
  const v = await factCheck(
    "The Transformer was published in 2017.",
    say(
      '["Transformer published 2017"]',
      '{"status":"supported","evidence":"arxiv 1706.03762"}',
    ),
  );
  expect(v).toEqual([
    {
      claim: "Transformer published 2017",
      status: "supported",
      evidence: "arxiv 1706.03762",
    },
  ]);
  expect(factCheckReport(v)).toContain("1 supported");
});

test("context7: search parses results", async () => {
  const f = (async (u: URL) => {
    expect(String(u)).toContain("/libs/search?libraryName=bun");
    return Response.json({ results: [{ id: "/oven-sh/bun", title: "Bun" }] });
  }) as unknown as typeof fetch;
  expect(await searchLibraries("bun", "serve", f)).toEqual([
    { id: "/oven-sh/bun", title: "Bun", description: "" },
  ]);
});
