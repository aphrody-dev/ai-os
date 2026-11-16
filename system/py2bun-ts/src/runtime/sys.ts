// Python `sys` subset.
import * as fs from "node:fs";
import { exit as pyexit } from "./index";
export const argv: string[] = [process.argv[1] ?? "", ...process.argv.slice(2)];
export const platform = process.platform === "win32" ? "win32" : process.platform;
export const byteorder = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? "little" : "big";
export const maxsize = Number.MAX_SAFE_INTEGER;
export const version_info = [3, 12, 0];
export const version = "3.12.0 (py2bun/bun)";
export const path: string[] = [];
export const modules = new Map<string, any>();
export const stdout = { write: (s: string) => (process.stdout.write(s), [...s].length), flush() {} };
export const stderr = { write: (s: string) => (process.stderr.write(s), [...s].length), flush() {} };
let inBuf: string | null = null;
let inPos = 0;
const loadIn = () => (inBuf ??= (() => {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
})());
export const stdin = {
  read: () => {
    const b = loadIn();
    const r = b.slice(inPos);
    inPos = b.length;
    return r;
  },
  readline: () => {
    const b = loadIn();
    if (inPos >= b.length) return "";
    const i = b.indexOf("\n", inPos);
    const e = i < 0 ? b.length : i + 1;
    const r = b.slice(inPos, e);
    inPos = e;
    return r;
  },
};
export const exit = (c?: any) => pyexit(c);
