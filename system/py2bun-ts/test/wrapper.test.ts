import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findBinary, transpile } from "../src/index";

const bin = findBinary();
const t = bin ? test : test.skip;
const runtimeDir = resolve(import.meta.dir, "../src/runtime");

/** Transpile, rewrite the package specifiers to local paths, run under bun, return stdout. */
async function run(py: string): Promise<string> {
  const r = transpile(py, bin);
  expect(r.ok).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "py2bun-"));
  try {
    const ts = r.ts.replaceAll('"@aphrody/py2bun/runtime', `"${runtimeDir.replaceAll("\\", "/")}`);
    const f = join(dir, "out.ts");
    await Bun.write(f, ts);
    const p = Bun.spawnSync([process.execPath, f], { stdout: "pipe", stderr: "pipe" });
    expect(p.stderr.toString()).toBe("");
    return p.stdout.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("wrapper + end to end", () => {
  t("transpile returns diagnostics", () => {
    const r = transpile("print(undefined_thing)\n", bin);
    expect(r.diagnostics.some((d) => d.message.includes("undefined_thing"))).toBe(true);
  });
  t("syntax error", () => {
    const r = transpile("def (:\n", bin);
    expect(r.ok).toBe(false);
    expect(r.ts).toBe("");
  });
  t("runs: functions, classes, comprehensions, f-strings, try", async () => {
    const out = await run(`
class Counter:
    def __init__(self, n=0):
        self.n = n
    def inc(self, by=1):
        self.n += by
        return self.n

def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

c = Counter()
c.inc(); c.inc(5)
print(c.n, fib(10), [x * x for x in range(4) if x % 2 == 0])
d = {"a": 1}
try:
    d["z"]
except KeyError as e:
    print("KeyError", e)
print(f"{c.n:04d}|{'x'!r}|{7 // 2}|{-7 % 3}|{hex(255)}")
for i in range(3):
    if i == 5:
        break
else:
    print("else ran")
print(sorted(["b", "A", "c"], key=lambda s: s.lower(), reverse=True), "%s-%d" % ("k", 3))
`);
    expect(out).toBe(
      ["6 55 [0, 4]", "KeyError 'z'", "0006|'x'|3|2|0xff", "else ran", "['c', 'b', 'A'] k-3", ""].join("\n"),
    );
  });
  t("runs: python 2 print statements via fallback", async () => {
    const out = await run('print "a", 1\nx = 3\nprint x\n');
    expect(out).toBe("a 1\n3\n");
  });
});
