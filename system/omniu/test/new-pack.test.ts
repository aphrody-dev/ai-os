import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addPack, removePack, validateAfterChange } from "../src/new-pack.ts";
import { copyBundle } from "./util.ts";

const registered = (root: string) => ["bundle.toml", "index.toml", "framework-plugins.toml"].map((f) => readFileSync(join(root, f), "utf8"));

test("add wires every registration and remove undoes it exactly", () => {
  const root = copyBundle();
  try {
    const before = registered(root);
    addPack(root, "demo-pack", { summary: "A demo", requiredBinary: "demo", withCompletions: true });
    validateAfterChange(root);
    for (const p of ["packs/demo-pack/plugin.toml", "packs/demo-pack/init.niu", "plugins/demo-pack/plugin.toml", "plugins/demo-pack/demo-pack.plugin.niu", "completions/demo-pack.toml"]) {
      expect(existsSync(join(root, p))).toBe(true);
    }
    const [bundle, index, inventory] = registered(root);
    expect(bundle).toContain('"demo-pack",');
    expect(index).toContain('name = "demo-pack"');
    expect(inventory).toContain('"demo-pack",');
    removePack(root, "demo-pack");
    validateAfterChange(root);
    expect(registered(root)).toEqual(before);
    expect(existsSync(join(root, "packs", "demo-pack"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add refuses a bad or existing name", () => {
  const root = copyBundle();
  try {
    expect(() => addPack(root, "Bad Name")).toThrow("invalid pack name");
    expect(() => addPack(root, "git")).toThrow("already exists");
    expect(() => removePack(root, "nope")).toThrow("not found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quotes, backslashes and unicode in the summary stay data: the manifests parse back to the same text", () => {
  const root = copyBundle();
  try {
    const summary = 'He said "hi" \\ and left \u00e9 # not a comment';
    addPack(root, "my-pack", { summary, requiredBinary: "my-tool" });
    const m = Bun.TOML.parse(readFileSync(join(root, "packs", "my-pack", "plugin.toml"), "utf8")) as any;
    expect(m.summary).toBe(summary);
    expect(m.permissions).toContain("process:run:my-tool");
    const idx = Bun.TOML.parse(readFileSync(join(root, "index.toml"), "utf8")) as any;
    expect(idx.packs.find((p: any) => p.name === "my-pack").summary).toBe(summary);
    validateAfterChange(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("injection through the options is refused, and hyphenated names give valid shell function names", () => {
  const root = copyBundle();
  try {
    expect(() => addPack(root, "inj", { requiredBinary: 'x"]\nbad = 1\n[evil' })).toThrow("invalid required binary");
    expect(() => addPack(root, "inj", { summary: "a\nb" })).toThrow("single line");
    expect(() => addPack(root, "inj", { category: 'x"\n[evil]' })).toThrow("unknown category");
    expect(existsSync(join(root, "packs", "inj"))).toBe(false);
    addPack(root, "two-words", {});
    const body = readFileSync(join(root, "plugins", "two-words", "two-words.plugin.niu"), "utf8");
    expect(body).toContain("two_words_hello() {");
    expect(body).not.toContain("two-words_hello");
    const m = Bun.TOML.parse(readFileSync(join(root, "plugins", "two-words", "plugin.toml"), "utf8")) as any;
    expect(m.exports.functions).toEqual(["two_words_hello"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
