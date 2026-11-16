import { describe, expect, test } from "bun:test";
import { hasReFfi, lua52TranscodeHex, reAuditBytes } from "../src/re.ts";

describe("@aphrody/core RE / Ghidra / Lua52 C-ABI bridge", () => {
  test("executes real aphrody_core_capi RE C-ABI when built on host", () => {
    if (!hasReFfi()) return;

    const peHdr = new Uint8Array(128);
    peHdr[0] = 0x4d;
    peHdr[1] = 0x5a;
    const audit = reAuditBytes("stub.exe", peHdr) as Record<string, unknown>;
    expect(audit).toBeDefined();

    const chunk = new Uint8Array([
      0x1b, 0x4c, 0x75, 0x61, 0x52, 0x00, 1, 4, 8, 4, 8, 0, 0x19, 0x93, 0x0d,
      0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0x1f, 0x00,
      0x80, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const trans = lua52TranscodeHex(chunk, 4, 4);
    expect(trans.ok).toBe(true);
    expect(typeof trans.hex).toBe("string");
  });
});
