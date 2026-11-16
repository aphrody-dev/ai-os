import { expect, test } from "bun:test";
import { spawnSync } from "../src/spawn.ts";

const bun = process.execPath;

test("input reaches stdin, stdout and status are Node-shaped", () => {
  const r = spawnSync(bun, ["-e", "process.stdout.write((await Bun.stdin.text()).toUpperCase()); process.exit(3)"], { input: "abc" });
  expect(r.stdout).toBe("ABC");
  expect(r.status).toBe(3);
  expect(r.error).toBeUndefined();
});

test("a missing binary returns error instead of throwing", () => {
  const r = spawnSync("definitely-not-a-binary-xyz", []);
  expect(r.error).toBeDefined();
  expect(r.status).toBeNull();
});

test("timeout kills the child and reports ETIMEDOUT", () => {
  const r = spawnSync(bun, ["-e", "await Bun.sleep(5000)"], { timeout: 300 });
  expect(r.status).toBeNull();
  expect((r.error as { code?: string }).code).toBe("ETIMEDOUT");
});

test("shell joins the arguments and runs them through the system shell", () => {
  const r = spawnSync("echo", ["a", "&&", "echo", "b"], { shell: true });
  expect(r.stdout.replace(/\r/g, "").trim().split("\n").map((s) => s.trim())).toEqual(["a", "b"]);
});

test("env and stdio ignore", () => {
  const r = spawnSync(bun, ["-e", "process.stdout.write(process.env.EK_X ?? '')"], { env: { ...process.env, EK_X: "1" } });
  expect(r.stdout).toBe("1");
  expect(spawnSync(bun, ["-e", "1"], { stdio: "ignore" }).stdout).toBe("");
});
