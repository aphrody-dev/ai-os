import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "brain", "cli.ts");

function run(home: string, ...args: string[]) {
  return Bun.spawnSync(["bun", CLI, ...args, "--home", join(home, ".agent")], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

function fixture() {
  const h = mkdtempSync(join(tmpdir(), "brain-"));
  const proj = join(h, ".claude", "projects", "C--aphrody");
  mkdirSync(join(proj, "memory"), { recursive: true });
  mkdirSync(join(h, ".agent"), { recursive: true });
  mkdirSync(join(h, ".gemini", "antigravity-cli"), { recursive: true });
  return { h, proj };
}

test("rejects a non-numeric --days without touching files", () => {
  const { h, proj } = fixture();
  const f = join(proj, "s.jsonl");
  Bun.write(f, "{}\n");
  expect(run(h, "absorb", "--days", "abc").exitCode).not.toBe(0);
  expect(run(h, "absorb", "--days", "").exitCode).not.toBe(0);
  expect(existsSync(f)).toBe(true);
});

test("packs cold files, keeps memory, restores bytes and mtime", async () => {
  const { h, proj } = fixture();
  const f = join(proj, "s.jsonl");
  const body = `${JSON.stringify({ type: "user", message: { role: "user", content: "hello brain" } })}\n`;
  await Bun.write(f, body);
  await Bun.write(join(proj, "memory", "m.md"), "fact");
  const old = Date.now() / 1000 - 3 * 86400;
  utimesSync(f, old, old);
  expect(run(h, "absorb", "--days", "1").exitCode).toBe(0);
  expect(existsSync(f)).toBe(false);
  expect(existsSync(join(proj, "memory", "m.md"))).toBe(true);
  expect(
    run(h, "restore", join(".claude", "projects", "C--aphrody", "s.jsonl"))
      .exitCode,
  ).toBe(0);
  expect(await Bun.file(f).text()).toBe(body);
  expect(Math.abs(Bun.file(f).lastModified / 1000 - old)).toBeLessThan(2);
});

test("sync replaces the managed block once and sets NHITL keys", async () => {
  const { h } = fixture();
  await Bun.write(join(h, ".claude", "CLAUDE.md"), "rule $& $1");
  await Bun.write(join(h, ".gemini", "GEMINI.md"), "head\n");
  expect(run(h, "sync").exitCode).toBe(0);
  expect(run(h, "sync").exitCode).toBe(0);
  const g = await Bun.file(join(h, ".gemini", "GEMINI.md")).text();
  expect(g.split("ai-os brain sync: begin").length).toBe(2);
  expect(g).toContain("rule $& $1");
  const s = await Bun.file(
    join(h, ".gemini", "antigravity-cli", "settings.json"),
  ).json();
  expect(s.toolPermission).toBe("always-proceed");
});
