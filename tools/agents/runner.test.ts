import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accepts,
  defaultClis,
  type Fleet,
  place,
  providerCmd,
  routeTarget,
} from "./runner.ts";

const NASTY = `a & b | c ^ d %PATH% "q" < in > out ; $(x) \`y\``;
const task = {
  v: 1,
  id: "t",
  role: "coder",
  host: "any",
  prompt: NASTY,
} as const;
const WIN = process.platform === "win32";
const RUNNER = join(import.meta.dir, "runner.ts").replace(/\\/g, "/");

// Bun.which reads PATH at process start: shim resolution runs in a child with the test PATH.
function inChild(dir: string, code: string) {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], {
    env: {
      ...process.env,
      PATH: `${dir}${WIN ? ";" : ":"}${process.env.PATH}`,
      AGENTS_HOME: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exit: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  };
}

test("no shell in provider argv, prompt intact", () => {
  for (const p of [
    "opencode",
    "pi",
    "agy:gemini-4",
    "codex",
    "claude",
    "jules",
    "jules:aphrody-labs/src",
  ]) {
    let built: { cmd: string[]; stdin?: string };
    try {
      built = providerCmd(p, { ...task }, 1);
    } catch {
      continue; // CLI absent or unresolvable shim: refused, never shelled
    }
    expect(built.cmd[0]).not.toMatch(
      /(^|[\\/])(cmd|cmd\.exe|sh|bash|niu|niu\.exe)$/i,
    );
    expect(built.cmd.includes(NASTY) || built.stdin === NASTY).toBe(true);
  }
});

test("a shim is spawned as its target executable, special characters reach the program unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-shim-"));
  if (WIN)
    writeFileSync(
      join(dir, "fakecli.cmd"),
      `@echo off\r\n"${process.execPath}" %*\r\n`,
    );
  else symlinkSync(process.execPath, join(dir, "fakecli"));
  const r = inChild(
    dir,
    `const { argv0 } = await import(${JSON.stringify(RUNNER)});
     const cmd = argv0("fakecli", ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ${JSON.stringify(NASTY)}]);
     const r = Bun.spawnSync(cmd, { stdout: "pipe" });
     console.log(JSON.stringify({ exe: cmd[0], got: JSON.parse(r.stdout.toString()) }));`,
  );
  expect(r.err).not.toMatch(/error/i);
  const j = JSON.parse(r.out.trim().split("\n").at(-1)!);
  expect(j.exe).not.toMatch(/\.(cmd|bat)$/i);
  expect(j.got).toContain(NASTY);
});

test("an unresolvable .cmd shim is refused, never run through cmd.exe", () => {
  if (!WIN) return;
  const dir = mkdtempSync(join(tmpdir(), "agents-shim-"));
  writeFileSync(join(dir, "badcli.cmd"), "@echo off\r\ncall something %*\r\n");
  const r = inChild(
    dir,
    `const { argv0 } = await import(${JSON.stringify(RUNNER)}); argv0("badcli", ["x"]);`,
  );
  expect(r.exit).not.toBe(0);
  expect(r.err).toMatch(/no shell fallback/);
});

const FLEET = Bun.TOML.parse(
  await Bun.file(join(import.meta.dir, "fleet.toml")).text(),
) as Fleet;

test("heavy roles run on fr1 only, prd keeps light prod roles", () => {
  for (const r of [
    "coder",
    "tester",
    "linter",
    "build",
    "chromium",
    "training",
  ]) {
    expect(FLEET.roles[r]?.heavy).toBe(true);
    expect(accepts(FLEET, "fr1", r)).toBe(true);
    for (const h of ["prd", "fr2", "pc"])
      expect(accepts(FLEET, h, r)).toBe(false);
    expect(place(FLEET, r)).toBe("fr1");
    expect(() => place(FLEET, r, "prd")).toThrow();
  }
  for (const r of FLEET.hosts.prd!.roles)
    expect(FLEET.roles[r]?.heavy).toBeFalsy();
  expect(place(FLEET, "deployer", "prd")).toBe("prd");
  // a heavy role listed by mistake on prd is still refused
  const bad = {
    ...FLEET,
    hosts: { ...FLEET.hosts, prd: { ...FLEET.hosts.prd!, roles: ["coder"] } },
  };
  expect(accepts(bad, "prd", "coder")).toBe(false);
});

test("route: prd forwards heavy and foreign tasks", () => {
  expect(routeTarget(FLEET, "prd", { role: "coder", host: "prd" })).toBe("fr1");
  expect(routeTarget(FLEET, "prd", { role: "reviewer", host: "prd" })).toBe(
    "fr1",
  );
  expect(routeTarget(FLEET, "fr1", { role: "deployer", host: "any" })).toBe(
    "prd",
  );
  expect(routeTarget(FLEET, "fr1", { role: "coder", host: "any" })).toBeNull();
});

test("jules provider runs ai-os jules run --wait with the repo from the model slot", () => {
  const b = providerCmd("jules:aphrody-labs/src", { ...task }, 1);
  expect(b.cmd.slice(2)).toEqual([
    "jules",
    "run",
    "--wait",
    "--repo",
    "aphrody-labs/src",
    "-",
  ]);
  expect(b.cmd[1]).toMatch(/packages[\\/]ai-os[\\/]src[\\/]cli\.ts$/);
  expect(b.stdin).toBe(task.prompt);
});

test("default CLIs: claude, codex, opencode, installed and logged in only", () => {
  const home = mkdtempSync(join(tmpdir(), "clis-"));
  expect(
    defaultClis(
      () => true,
      { CLAUDE_CODE_OAUTH_TOKEN: "x", OPENAI_API_KEY: "y" },
      home,
    ),
  ).toEqual(["claude", "codex"]);
  expect(
    defaultClis(
      (c) => c !== "claude",
      { CLAUDE_CODE_OAUTH_TOKEN: "x", OPENAI_API_KEY: "y" },
      home,
    ),
  ).toEqual(["codex"]);
  expect(defaultClis(() => true, {}, home)).toEqual([]);
});
