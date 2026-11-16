import { describe, expect, test } from "bun:test";
import {
  depotAbiVersion,
  depotLibCandidates,
  detectContent,
  hasDepotFfi,
  helixRopeEdit,
  llvmAnalyzeIr,
  transformSource,
} from "../src/depot.ts";

describe("@aphrody/core Depot / Migration / Toolchain C-ABI bridge", () => {
  test("depotLibCandidates orders env override and target/{release,debug}", () => {
    const candidates = depotLibCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.some((p) => p.includes("aphrody_core_capi"))).toBe(true);
  });

  test("executes real aphrody_core_capi C-ABI when built on host", () => {
    if (!hasDepotFfi()) return;

    expect(depotAbiVersion()).toBe(20261111);
    expect(helixRopeEdit("fn hello() { return 1; }", [[3, 8, "world"]])).toBe(
      "fn world() { return 1; }",
    );

    const tx = transformSource(
      "ts",
      "import { readFileSync } from 'fs';\nexport const x = 1;",
    );
    expect(tx.edits_count).toBe(1);
    expect(tx.transformed_code).toContain("node:fs");

    const ir = llvmAnalyzeIr(
      "vec.ll",
      'target triple = "x86_64-pc-windows-msvc"\ndefine void @vadd() nounwind {\nentry:\n  %1 = add <8 x i32> zeroinitializer, zeroinitializer\n  ret void\n}\n',
    ) as { total_functions: number; simd_vectorized_functions: number };
    expect(ir.total_functions).toBe(1);
    expect(ir.simd_vectorized_functions).toBe(1);

    const mag = detectContent("app.ts", Buffer.from("export const a = 1;")) as {
      label?: string;
    };
    expect(JSON.stringify(mag).toLowerCase()).toContain("typescript");
  });
});
