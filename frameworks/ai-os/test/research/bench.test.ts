import { expect, test } from "bun:test";
import { bench, tune } from "../../bench/retrieval";

test("retrieval bench: tuned fusion >= best single head (in-sample), latency bound", async () => {
  const r = await bench();
  const { lexical, semantic } = r.results;
  expect(r.queries).toBe(30);
  const t = await tune();
  expect(t.inSample.r5).toBeGreaterThanOrEqual(
    Math.max(lexical!.r5, semantic!.r5),
  );
  expect(r.results.rrf!.msPerQuery).toBeLessThan(50);
}, 60_000);
