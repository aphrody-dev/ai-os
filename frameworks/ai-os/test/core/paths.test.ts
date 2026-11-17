import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  dataDir,
  envFile,
  envFiles,
  requireEnvFiles,
  workspaceRoot,
} from "../../src/core/paths";

const touched = [
  "WORKSPACE_ROOT",
  "SRC_ROOT",
  "AY_DATA_DIR",
  "ENV_FILE",
] as const;
const saved = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
const cwd = process.cwd();
const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "paths-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  process.chdir(cwd);
  for (const k of touched) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("derived locations", () => {
  test("the workspace root and the data directory follow the configuration", () => {
    const root = scratch();
    process.env.WORKSPACE_ROOT = root;
    delete process.env.AY_DATA_DIR;
    expect(workspaceRoot()).toBe(resolve(root));
    expect(dataDir("brain")).toBe(join(resolve(root), "var", "brain"));
    process.env.AY_DATA_DIR = join(root, "data");
    expect(dataDir("brain")).toBe(join(root, "data", "brain"));
  });

  test("the .env comes from the workspace or ENV_FILE, never from the current directory", () => {
    const root = scratch();
    const elsewhere = scratch();
    writeFileSync(join(root, ".env"), "REAL_TOKEN=workspace-secret-value\n");
    writeFileSync(join(elsewhere, ".env"), "LD_PRELOAD=/tmp/evil.so\n");
    process.env.WORKSPACE_ROOT = root;
    delete process.env.ENV_FILE;
    process.chdir(elsewhere);
    expect(envFiles()).toEqual([join(resolve(root), ".env")]);
    expect(envFile()).toBe(join(resolve(root), ".env"));
    expect(requireEnvFiles()).toEqual([join(resolve(root), ".env")]);
  });

  test("ENV_FILE is read first and the workspace .env still counts: every file is used for redaction", () => {
    const root = scratch();
    const extra = join(scratch(), "other.env");
    writeFileSync(join(root, ".env"), "A_TOKEN=aaaaaaaaaaaaaaaa\n");
    writeFileSync(extra, "B_TOKEN=bbbbbbbbbbbbbbbb\n");
    process.env.WORKSPACE_ROOT = root;
    process.env.ENV_FILE = extra;
    expect(envFiles()).toEqual([resolve(extra), join(resolve(root), ".env")]);
    expect(requireEnvFiles()).toEqual([
      resolve(extra),
      join(resolve(root), ".env"),
    ]);
  });

  test("a missing .env fails closed", () => {
    const root = scratch();
    mkdirSync(join(root, "var"));
    process.env.WORKSPACE_ROOT = root;
    delete process.env.ENV_FILE;
    process.chdir(scratch());
    expect(() => requireEnvFiles()).toThrow("no .env found");
  });
});
