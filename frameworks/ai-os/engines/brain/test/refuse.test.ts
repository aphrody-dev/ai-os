import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "brain-refuse-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// A workspace without .env and a data directory of its own: secrets are unknown, so nothing may be merged or synced.
const env = () => {
  const e = { ...process.env } as Record<string, string | undefined>;
  delete e.ENV_FILE;
  return {
    ...e,
    WORKSPACE_ROOT: join(base, "workspace"),
    AY_DATA_DIR: join(base, "data"),
  } as Record<string, string>;
};
const run = (script: string, ...args: string[]) =>
  Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", script), ...args],
    {
      cwd: base,
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

test("merge refuses to run without a .env and writes nothing", () => {
  const r = run("merge-sessions.ts");
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("brain merge refused");
  expect(existsSync(join(base, "data", "brain"))).toBe(false);
});

test("sync refuses to run without a .env", () => {
  const r = run("cli.ts", "sync");
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("Refusing to sync");
});
