import { expect, test } from "bun:test";
import { planEnvMerge } from "../src/index";

test("adds new keys, keeps local on conflict, skips identical and shell noise", () => {
  const plan = planEnvMerge(
    { A: "1", B: "2", B__FR1: "9" },
    { A: "1", B: "3", C: "4", PATH: "/bin", D: "" },
    "fr1",
  );
  expect(plan.added).toEqual({ C: "4" });
  expect(plan.conflicts).toEqual({ B__FR1: "3" });
  expect(plan.same).toEqual(["A"]);
});

test("conflict already recorded under the source tag is identical", () => {
  const plan = planEnvMerge({ B: "2", B__USA: "3" }, { B: "3" }, "usa");
  expect(plan.conflicts).toEqual({});
  expect(plan.same).toEqual(["B"]);
});
