import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CORE_ABI_VERSION,
  blake3Hex,
  classification,
  contentHash,
  facts,
  index,
  indexEach,
  languages,
  loadCore,
  openStore,
  parse,
  query,
  usersOf,
  writeIndex,
} from "../src/index.ts";

const core = loadCore();
const native = core ? describe : describe.skip;
const pkgRoot = join(import.meta.dir, "..");

test("contentHash always reports its real algorithm", () => {
  const h = contentHash("abc");
  expect(h.hex).toHaveLength(64);
  expect(h.algo).toBe(core ? "blake3" : "blake2b256");
});

native("bun:ffi round-trip with aphrody_core_capi", () => {
  test("abi + languages", () => {
    expect(CORE_ABI_VERSION).toBe(1);
    expect(languages()).toContain("rust");
  });

  test("blake3 reference vectors", () => {
    expect(blake3Hex("")).toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
    expect(blake3Hex(new TextEncoder().encode("abc"))).toBe(
      "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
    );
  });

  test("parse returns symbols, unsupported throws", () => {
    const s = parse(
      "a.ts",
      "export function hello(x: number) { return world(x); }",
    );
    expect(s.language).toBe("typescript");
    expect(s.symbols.map((y) => y.name)).toContain("hello");
    expect(() => parse("a.unknown", "")).toThrow();
  });

  test("query captures", () => {
    const caps = query(
      "a.rs",
      "fn alpha() {} fn beta() {}",
      "(function_item name: (identifier) @n)",
    );
    expect(caps).toHaveLength(2);
  });

  test("facts: comments and strings are nodes, a regex literal is not a string", () => {
    const f = facts("a.ts", "import { a } from 'node:zlib'; // note\nconst r = /from 'node:fs'/; const s = \"x\";");
    const cap = (n: string) => f.matches.flatMap((m) => m.c).filter((c) => c.n === n).map((c) => c.t);
    expect(f.lang).toBe("typescript");
    expect(cap("import.source")).toEqual(["'node:zlib'"]);
    expect(cap("import.name")).toEqual(["a"]);
    expect(cap("comment")).toEqual(["// note"]);
    expect(cap("string")).toEqual(["'node:zlib'", '"x"']);
    expect(() => facts("a.unknown", "")).toThrow();
  });

  test("indexEach streams through JSCallback and matches index()", () => {
    const seen: string[] = [];
    const stats = indexEach(pkgRoot, (f) => seen.push(f.path), {
      includes: ["src"],
    });
    const full = index(pkgRoot, { includes: ["src"] });
    expect(stats.files).toBe(full.stats.files);
    expect(seen.sort()).toEqual(full.files.map((f) => f.path).sort());
    expect(seen).toContain("src/ffi.ts");
  });

  test("sqlite store: classification and usersOf", () => {
    const db: Database = openStore(":memory:");
    writeIndex(db, index(pkgRoot, { includes: ["src", "test"] }));
    expect(
      classification(db).some(
        (c) => c.layer === "src" && c.language === "typescript",
      ),
    ).toBe(true);
    expect(usersOf(db, "bun:ffi")).toContain("src/ffi.ts");
  });
});
