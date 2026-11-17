// The extraction check is an integrity gate: without its source it fails in CI and anywhere not opted out, and it only
// extracts from the pinned commit. The tool runs in a scratch copy of this layout with an unreachable source.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const base = mkdtempSync(join(tmpdir(), "extract-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const REV = "0123456789abcdef0123456789abcdef01234567";
const toml = (rev: string) => `[source]
repo = "example-org/missing-source"
checkout = ".cache/legacy-rev"
rev = "${rev}"

[select]
seeds = []
stop = []
paths = []
exclude = []

[package-json]
drop-dependencies = []
repository = "https://github.com/example-org/example-repo"
`;

function scratch(name: string, rev = REV): string {
  const dir = join(base, name);
  mkdirSync(join(dir, "tools"), { recursive: true });
  for (const f of ["extract.ts", "closure.ts"]) copyFileSync(join(root, "tools", f), join(dir, "tools", f));
  writeFileSync(join(dir, "extract.toml"), toml(rev));
  return dir;
}

function run(dir: string, env: Record<string, string>) {
  const clean = { ...process.env } as Record<string, string | undefined>;
  for (const k of ["CI", "GITHUB_ACTIONS", "AI_OS_EXTRACT_ALLOW_SKIP", "AI_OS_LEGACY_CHECKOUT"]) delete clean[k];
  const r = Bun.spawnSync([process.execPath, join(dir, "tools", "extract.ts")], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...clean,
      // The source repository is rewritten to a local path that does not exist: the fetch fails without any network.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${join(base, "no-such-remote")}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/",
      ...env,
    },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("source not available", () => {
  test("fails in CI", () => {
    const r = run(scratch("ci"), { CI: "true" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not available");
    expect(r.out).not.toContain("skipped");
  });

  test("fails in GitHub Actions", () => {
    expect(run(scratch("actions"), { GITHUB_ACTIONS: "true" }).code).toBe(1);
  });

  test("fails locally without the explicit opt-in", () => {
    const r = run(scratch("local"), {});
    expect(r.code).toBe(1);
    expect(r.err).toContain("AI_OS_EXTRACT_ALLOW_SKIP=1");
  });

  test("skips locally with the opt-in", () => {
    const r = run(scratch("optin"), { AI_OS_EXTRACT_ALLOW_SKIP: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped");
  });

  test("never skips in CI, whatever the opt-in", () => {
    const r = run(scratch("ci-optin"), { CI: "true", AI_OS_EXTRACT_ALLOW_SKIP: "1" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("skipped");
  });
});

describe("pinned commit", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };

  test("a source checked out at another commit is refused", () => {
    const src = join(base, "source");
    mkdirSync(src, { recursive: true });
    git(src, "init", "-q");
    writeFileSync(join(src, "a.txt"), "a");
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", "first");
    const pinned = git(src, "rev-parse", "HEAD");
    writeFileSync(join(src, "a.txt"), "b");
    git(src, "commit", "-q", "-am", "second");
    const dir = scratch("moved", pinned);
    const r = run(dir, { AI_OS_LEGACY_CHECKOUT: src });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("is not the pinned rev");
  });
});
