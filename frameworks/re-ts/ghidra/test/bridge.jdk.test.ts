// Runs the JDK-only Bridge.java protocol tests; skipped when javac/java are not on PATH (run on fr1/fr2).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const javac = Bun.which("javac");
const t = javac ? test : test.skip;
const bridgeDir = join(import.meta.dir, "..", "bridge");

function build(): string {
  const out = mkdtempSync(join(tmpdir(), "bridge-"));
  const r = Bun.spawnSync([javac!, "-d", out, join(bridgeDir, "Bridge.java")], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return out;
}

function talk(cp: string, reqs: string[]): any[] {
  const r = Bun.spawnSync(["java", "-cp", cp, "Bridge"], { stdin: new TextEncoder().encode(reqs.join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().trim().split("\n").map((l) => JSON.parse(l));
}

describe("Bridge.java protocol (JDK only)", () => {
  t("string ids, stale handles, trailing text, lists as handles, BigInteger, Float", () => {
    const cp = build();
    const res = talk(cp, [
      '{"id":"a,b","op":"ping"}',
      '{"id":2,"op":"list","h":999}',
      '{"id":3,"op":"ping"} junk',
      '{"id":4,"op":"static","c":"java.util.List","m":"of","a":[1,2]}',
      '{"id":5,"op":"static","c":"java.math.BigInteger","m":"valueOf","a":[{"$long":"9007199254740993"}]}',
      '{"id":6,"op":"static","c":"java.lang.Float","m":"valueOf","a":[0.1]}',
      '{"id":7,"op":"static","c":"java.lang.Math","m":"abs","a":[{"$long":"-9223372036854775808"}]}',
      '{"id":8,"op":"class","c":"byte[]"}',
      '{"id":9,"op":"ping"',
    ]);
    expect(res[0].id).toBe("a,b");
    expect(res[0].result).toBe("pong");
    expect(res[1].error.message).toContain("stale handle");
    expect(res[2].error.message).toContain("trailing text");
    expect(res[3].result.$h).toBeDefined(); // immutable List.of is a handle, not inlined
    expect(res[4].result.$long).toBe("9007199254740993");
    expect(res[5].result).toBe(0.1);
    expect(res[6].result.$long).toBe("-9223372036854775808");
    expect(res[8].error).toBeDefined();
  });
});
