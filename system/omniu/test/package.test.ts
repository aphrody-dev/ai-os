import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { build, check, releasePaths, zip } from "../src/package.ts";
import { ROOT } from "./util.ts";

/** Minimal zip reader: the central directory, then each entry inflated. */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    const raw = bytes.subarray(start, start + csize);
    const data = method === 8 ? Bun.inflateSync(raw) : raw;
    expect(data.length).toBe(size);
    expect(Bun.hash.crc32(data) >>> 0).toBe(crc);
    out.set(name, data);
    p += 46 + nlen;
  }
  return out;
}

test("zip round-trips and is deterministic", () => {
  const entries = [
    { name: "a.txt", data: new TextEncoder().encode("hello hello hello hello hello") },
    { name: "d/b.bin", data: new Uint8Array([1, 2, 3]) },
  ];
  const a = zip(entries);
  expect(Buffer.from(a).equals(Buffer.from(zip(entries)))).toBe(true);
  const files = readZip(a);
  expect([...files.keys()]).toEqual(["a.txt", "d/b.bin"]);
  expect(new TextDecoder().decode(files.get("a.txt")!)).toBe("hello hello hello hello hello");
});

test("the bundle packages: every release file is in the zip, bytes unchanged, same digest twice", () => {
  const first = check(ROOT);
  const second = check(ROOT);
  expect(first.sha256).toBe(second.sha256);
  const out = join(ROOT, "dist-test");
  try {
    const r = build(ROOT, out, false);
    expect(dirname(r.zipPath)).toBe(out);
    expect(readFileSync(r.checksumPath!, "utf8")).toBe(`${r.sha256}  oh-my-niu-${(Bun.TOML.parse(readFileSync(`${ROOT}/bundle.toml`, "utf8")) as any).version}.zip\n`);
    const files = readZip(readFileSync(r.zipPath));
    const names = releasePaths(ROOT);
    expect([...files.keys()]).toEqual(names);
    expect(names).toContain("plugins/ay/plugin.toml");
    expect(Buffer.from(files.get("bundle.toml")!).equals(readFileSync(`${ROOT}/bundle.toml`))).toBe(true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("zip refuses what plain zip cannot hold instead of writing a corrupt archive", () => {
  const many = Array.from({ length: 0x10000 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) }));
  expect(() => zip(many)).toThrow("65535");
  expect(zip(many.slice(0, 0xffff)).length).toBeGreaterThan(0);
});
