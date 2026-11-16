// Deterministic oh-my-niu release bundle (port of tools/package_bundle.py): a zip with fixed timestamps and sorted entries.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { loadToml, validate } from "./validate.ts";

const RELEASE_DIRS = ["lib", "plugins", "packs", "aliases", "completions", "prompts", "keybindings", "themes", "wasm", "docs", "templates", "tools"];
const RELEASE_FILES = ["oh-my-niu.niu", "bundle.toml", "index.toml", "README.md", "CHANGELOG.md", "framework-plugins.toml"];
// DOS date and time of 1980-01-01 00:00:00.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Files of a release, relative to `root`, POSIX separators, sorted. */
export function releasePaths(root: string): string[] {
  const out: string[] = [];
  for (const f of RELEASE_FILES) {
    try {
      if (statSync(join(root, f)).isFile()) out.push(join(root, f));
    } catch {}
  }
  for (const d of RELEASE_DIRS) {
    try {
      walk(join(root, d), out);
    } catch {}
  }
  return out.map((p) => relative(root, p).split(sep).join("/")).sort();
}

/** A zip archive (deflate, fixed dates, mode 0644) of `entries`. */
export function zip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  // Plain ZIP only: 16-bit entry counts and 32-bit sizes and offsets. Past those limits the archive would be silently corrupt, so refuse.
  if (entries.length > 0xffff) throw new Error(`zip: ${entries.length} entries exceed the 65535 of a non-zip64 archive`);
  if (entries.some((e) => e.data.length >= 0xffffffff)) throw new Error("zip: an entry of 4 GiB or more needs zip64");
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const packed = Bun.deflateSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const crc = Bun.hash.crc32(data) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, useDeflate ? 8 : 0, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, (3 << 8) | 20, true); // made by: Unix
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, useDeflate ? 8 : 0, true);
    cd.setUint16(12, DOS_TIME, true);
    cd.setUint16(14, DOS_DATE, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(38, (0o100644 << 16) >>> 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

export interface PackageResult {
  zipPath: string;
  sha256: string;
  checksumPath: string | null;
}

/** Validate, then write `<out>/oh-my-niu-<version>.zip` and (unless `check`) its `.sha256`. */
export function build(root: string, outDir: string, check: boolean): PackageResult {
  const errors = validate(root);
  if (errors.length) throw new Error(errors.map((e) => `error: ${e}`).join("\n"));
  const version = String(loadToml(join(root, "bundle.toml")).version);
  const entries = releasePaths(root).map((name) => ({ name, data: readFileSync(join(root, name)) }));
  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `oh-my-niu-${version}.zip`);
  const bytes = zip(entries);
  writeFileSync(zipPath, bytes);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  let checksumPath: string | null = null;
  if (!check) {
    checksumPath = `${zipPath}.sha256`;
    writeFileSync(checksumPath, `${sha256}  oh-my-niu-${version}.zip\n`);
  }
  return { zipPath, sha256, checksumPath };
}

/** `build` in a throwaway directory (the `--check` mode). */
export function check(root: string): PackageResult {
  const dir = mkdtempSync(join(tmpdir(), "oh-my-niu-package-"));
  try {
    return build(root, dir, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
