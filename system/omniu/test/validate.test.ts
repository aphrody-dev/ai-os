import { expect, test } from "bun:test";
import { appendFileSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isThemeColor, validateAll } from "../src/validate.ts";
import { copyBundle, ROOT } from "./util.ts";

test("the shipped bundle validates", () => {
  expect(validateAll(ROOT)).toEqual([]);
});

test("a framework plugin directory missing from the inventory is drift", () => {
  const root = copyBundle();
  try {
    const f = join(root, "framework-plugins.toml");
    writeFileSync(f, readFileSync(f, "utf8").replace('  "ay",\n', ""));
    const errors = validateAll(root);
    expect(errors.some((e) => e.startsWith("framework plugin inventory drift"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken [bun] entry is reported", () => {
  const root = copyBundle();
  try {
    appendFileSync(join(root, "plugins", "ay", "plugin.toml"), '\n# overwritten below\n');
    const f = join(root, "plugins", "ay", "plugin.toml");
    writeFileSync(f, readFileSync(f, "utf8").replace('entry = "ay.plugin.ts"', 'entry = "missing.plugin.ts"'));
    expect(validateAll(root)).toContain(`framework plugin ay: missing bun entry ${join(root, "plugins", "ay", "missing.plugin.ts")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pack manifest with an unknown kind is reported", () => {
  const root = copyBundle();
  try {
    const f = join(root, "packs", "git", "plugin.toml");
    writeFileSync(f, readFileSync(f, "utf8").replace('kind = "source"', 'kind = "quantum"'));
    expect(validateAll(root)).toContain("git: unknown kind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("theme colors: names, 0-255 and hex", () => {
  expect(isThemeColor("Light-Red")).toBe(true);
  expect(isThemeColor("255")).toBe(true);
  expect(isThemeColor("256")).toBe(false);
  expect(isThemeColor("#a1b2c3")).toBe(true);
  expect(isThemeColor("#a1b2c")).toBe(false);
  expect(isThemeColor("mauve")).toBe(false);
});
