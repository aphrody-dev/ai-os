import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWithoutDotenv } from "../src/lib.ts";

const dir = mkdtempSync(join(tmpdir(), "nhitl-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("launcher: .env entries loaded by bun never reach claude", () => {
  writeFileSync(
    join(dir, ".env"),
    'export ANTHROPIC_API_KEY="fake-test-value"\nURL=${HOST}/x\n# c\nPLAIN=a # note\n',
  );
  writeFileSync(join(dir, ".env.local"), "LOCAL_ONLY='l'\n");
  const env = {
    ANTHROPIC_API_KEY: "fake-test-value",
    URL: "h/x",
    PLAIN: "a",
    LOCAL_ONLY: "l",
    PATH: "/bin",
    HOME: "/home/x",
  };
  expect(envWithoutDotenv(env, dir, true)).toEqual({
    PATH: "/bin",
    HOME: "/home/x",
  });
  // a real environment value that differs from the file is the caller's own: kept
  expect(
    envWithoutDotenv({ ...env, PLAIN: "from-shell" }, dir, true).PLAIN,
  ).toBe("from-shell");
  // under --no-env-file nothing was injected: nothing is dropped
  expect(envWithoutDotenv(env, dir, false)).toEqual(env);
});

test("launcher: shebang disables .env loading, root never forces IS_SANDBOX", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "../bin/claude-nhitl.ts"),
  ).text();
  expect(src.split("\n")[0]).toBe("#!/usr/bin/env -S bun --no-env-file");
  expect(src).not.toMatch(/IS_SANDBOX\s*=\s*["']1/);
  expect(src).toContain('"runuser", "-u"');
});

import {
  resolveSandbox,
  SECRET_READ_DENY,
  sandboxSettings,
  toWslPath,
  wslArgv,
} from "../src/sandbox.ts";

test("sandbox: default is wsl on Windows only, bad value refused", () => {
  expect(resolveSandbox(undefined, "win32")).toBe("wsl");
  expect(resolveSandbox(undefined, "linux")).toBe("off");
  expect(resolveSandbox("native", "linux")).toBe("native");
  expect(() => resolveSandbox("docker", "win32")).toThrow();
});

test("sandbox: settings fail closed and hide secrets", () => {
  const s = JSON.parse(
    sandboxSettings({
      writeRoots: ["/mnt/c/src"],
      protectedGit: ["/mnt/c/src/.git"],
    }),
  ).sandbox;
  expect(s.enabled).toBe(true);
  expect(s.allowUnsandboxedCommands).toBe(false);
  expect(s.failIfUnavailable).toBe(true);
  expect(s.excludedCommands).toEqual([]);
  expect(s.filesystem.allowWrite).toEqual(["/mnt/c/src"]);
  expect(s.filesystem.denyRead).toEqual(SECRET_READ_DENY);
  expect(s.filesystem.denyRead).toContain("~/**/.env");
  expect(s.filesystem.denyWrite).toEqual([
    "/mnt/c/src/.git/hooks",
    "/mnt/c/src/.git/config",
  ]);
});

test("sandbox: Windows paths map to /mnt, UNC refused", () => {
  expect(toWslPath("C:\\aphrody\\packages")).toBe("/mnt/c/src/packages");
  expect(toWslPath("D:/x")).toBe("/mnt/d/x");
  expect(toWslPath("/home/a")).toBe("/home/a");
  expect(() => toWslPath("\\\\srv\\share")).toThrow();
});

test("sandbox: wsl argv runs claude via --exec, no shell string", () => {
  const a = wslArgv({
    distro: "Arch",
    cwd: "C:\\aphrody",
    env: { NHITL_RUN: "1" },
    claudeArgs: ["claude", "-p", "a b; rm -rf ~"],
  });
  expect(a).toEqual([
    "wsl.exe",
    "-d",
    "Arch",
    "--cd",
    "/mnt/c/src",
    "--exec",
    "env",
    "NHITL_RUN=1",
    "claude",
    "-p",
    "a b; rm -rf ~",
  ]);
});

test("launcher: wsl mode refuses off-Windows, passes --settings", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "../bin/claude-nhitl.ts"),
  ).text();
  expect(src).toContain('"--settings"');
  const r = Bun.spawnSync(
    [
      "bun",
      "--no-env-file",
      join(import.meta.dir, "../bin/claude-nhitl.ts"),
      "--sandbox",
      "wsl",
      "hi",
    ],
    {
      stderr: "pipe",
      stdout: "pipe",
      env: { ...process.env, NHITL_RUN_AS: "" },
    },
  );
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("needs Windows");
});

// Measured proxy for the WSL2 sandbox (same bubblewrap): the two N4 probes must be blocked,
// bun/git/just must keep working. Skipped where bwrap is absent (Windows, CI without userns).
const hasBwrap = process.platform === "linux" && Bun.which("bwrap") !== null;
test.skipIf(!hasBwrap)(
  "sandbox: bwrap blocks rmSync and printf-built cat .env, tools still run",
  () => {
    const d = mkdtempSync(join(tmpdir(), "nhitl-bw-"));
    try {
      const proj = join(d, "proj"),
        home = join(d, "home");
      Bun.spawnSync(["mkdir", "-p", proj, home]);
      writeFileSync(join(proj, ".env"), "SECRET=1\n");
      writeFileSync(join(home, "victim"), "x");
      const bw = [
        "bwrap",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--bind",
        proj,
        proj,
        "--ro-bind",
        "/dev/null",
        join(proj, ".env"),
      ];
      const run = (cmd: string[]) =>
        Bun.spawnSync([...bw, ...cmd], {
          cwd: proj,
          stdout: "pipe",
          stderr: "pipe",
        });
      run([
        "bun",
        "-e",
        `require("node:fs").rmSync(${JSON.stringify(join(home, "victim"))})`,
      ]);
      expect(Bun.file(join(home, "victim")).size).toBe(1);
      const cat = run(["bash", "-c", "cat $(printf .en; printf v)"]);
      expect(cat.stdout.toString()).not.toContain("SECRET");
      expect(cat.exitCode).not.toBe(0);
      expect(
        run(["bun", "-e", "console.log(2)"]).stdout.toString().trim(),
      ).toBe("2");
      expect(run(["git", "init", "-q", "."]).exitCode).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  },
);
