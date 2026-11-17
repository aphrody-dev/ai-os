// The POSIX loader reads the .env of its anchor (ENV_KIT_ROOT or the file given); a .env found in the current directory is untrusted.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "load-env-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const sh = Bun.which("sh");
const script = join(import.meta.dir, "..", "loaders", "shell", "load-env.sh").replaceAll("\\", "/");
const fwd = (p: string) => p.replaceAll("\\", "/");

const DANGEROUS = ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "GIT_SSH_COMMAND", "NODE_OPTIONS", "PATH_BACKUP_OPTIONS"];
const ENV_FILE = [
  "KIT_SAFE_VALUE=loaded",
  ...DANGEROUS.map((k) => `${k}=/tmp/injected`),
  "PATH=/tmp/injected-bin",
].join("\n");

function dirWithEnv(name: string): string {
  const d = join(base, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, ".env"), ENV_FILE);
  return d;
}

function load(cwd: string, extraEnv: Record<string, string>, args = "") {
  const clean = { ...process.env } as Record<string, string | undefined>;
  for (const k of ["ENV_KIT_ROOT", "ENV_KIT_OVERRIDE", "KIT_SAFE_VALUE", ...DANGEROUS]) delete clean[k];
  // Positional parameters are set before sourcing: `. file args` is not portable (dash ignores the arguments).
  const probe = [`set -- ${args}`, `. "${script}"`, "echo safe=${KIT_SAFE_VALUE:-}", ...DANGEROUS.map((k) => `echo ${k}=\${${k}:-}`), 'echo path=$PATH'].join("; ");
  const r = Bun.spawnSync([sh!, "-c", probe], { cwd, env: { ...clean, ...extraEnv } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const out = Object.fromEntries(
    r.stdout
      .toString()
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { out, err: r.stderr.toString(), pathBefore: clean.PATH };
}

describe("load-env.sh", () => {
  test("a .env in the current directory is never read", () => {
    const hostile = dirWithEnv("hostile-cwd");
    const r = load(hostile, {});
    expect(r.out.safe).toBe("");
    for (const k of DANGEROUS) expect(r.out[k]).toBe("");
    expect(r.out.path).not.toContain("injected-bin");
  });

  test("the anchor loads its variables but never the ones that change how code is loaded", () => {
    const root = dirWithEnv("trusted-root");
    const cwd = join(base, "unrelated");
    mkdirSync(cwd, { recursive: true });
    const r = load(cwd, { ENV_KIT_ROOT: fwd(root) });
    expect(r.out.safe).toBe("loaded");
    for (const k of DANGEROUS) expect(r.out[k]).toBe("");
    expect(r.out.path).not.toContain("injected-bin");
  });

  test("an explicit file argument is honoured and filtered the same way", () => {
    const root = dirWithEnv("explicit");
    const r = load(base, {}, `"${fwd(join(root, ".env"))}"`);
    expect(r.out.safe).toBe("loaded");
    for (const k of DANGEROUS) expect(r.out[k]).toBe("");
  });
});
