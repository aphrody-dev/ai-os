// Python `os` / `os.path` subset.
import * as fs from "node:fs";
import * as p from "node:path";
import { FileNotFoundError, FileExistsError, PermissionError, OSError, Kw } from "./index";

export const sep = p.sep;
export const linesep = process.platform === "win32" ? "\r\n" : "\n";
export const name = process.platform === "win32" ? "nt" : "posix";
export const environ = new Map<string, string>(Object.entries(process.env) as [string, string][]);
export const getenv = (k: string, d: any = null) => process.env[k] ?? d;
export const getcwd = () => process.cwd();

/** Node errno errors become Python OSError subclasses (so `except OSError` / `FileNotFoundError` match). */
function wrap<T>(f: () => T, path?: string): T {
  try {
    return f();
  } catch (e: any) {
    const tail = path === undefined ? "" : `: '${path}'`;
    switch (e?.code) {
      case "ENOENT":
        throw new FileNotFoundError(`[Errno 2] No such file or directory${tail}`);
      case "EACCES":
      case "EPERM":
        throw new PermissionError(`[Errno 13] Permission denied${tail}`);
      case "EEXIST":
        throw new FileExistsError(`[Errno 17] File exists${tail}`);
      default:
        if (e?.code) throw new OSError(`[Errno ${e.errno ?? 0}] ${e.code}${tail}`);
        throw e;
    }
  }
}
export const listdir = (d = ".") => wrap(() => fs.readdirSync(d), d);
export const makedirs = (d: string, ...a: any[]) => {
  const k = a.find((x) => x instanceof Kw)?.o ?? {};
  const existOk = k.exist_ok ?? (typeof a[1] === "boolean" ? a[1] : false);
  if (!existOk && fs.existsSync(d)) throw new FileExistsError(`[Errno 17] File exists: '${d}'`);
  wrap(() => void fs.mkdirSync(d, { recursive: true }), d);
};
export const mkdir = (d: string) => wrap(() => void fs.mkdirSync(d), d);
export const remove = (f: string) => wrap(() => void fs.rmSync(f), f);
export const unlink = remove;
export const rename = (a: string, b: string) => wrap(() => void fs.renameSync(a, b), a);
export const getpid = () => process.pid;

const isSep = (c: string) => c === "/" || (process.platform === "win32" && c === "\\");
export const path = {
  // concatenate with the separator; no normalization ("a", "../b" stays "a/../b"), "a" + "" gives "a/"
  join: (...a: string[]) => {
    let acc = "";
    let first = true;
    for (const x of a) {
      if (first || p.isAbsolute(x)) acc = x;
      else acc = acc === "" || isSep(acc[acc.length - 1]!) ? acc + x : acc + p.sep + x;
      first = false;
    }
    if (a.length && a[a.length - 1] === "" && acc !== "" && !isSep(acc[acc.length - 1]!)) acc += p.sep;
    return acc;
  },
  basename: (x: string) => {
    const i = Math.max(x.lastIndexOf("/"), process.platform === "win32" ? x.lastIndexOf("\\") : -1);
    return x.slice(i + 1);
  },
  dirname: (x: string) => {
    const i = Math.max(x.lastIndexOf("/"), process.platform === "win32" ? x.lastIndexOf("\\") : -1);
    if (i < 0) return "";
    const head = x.slice(0, i + 1);
    return /^[\\/]+$/.test(head) ? head : head.replace(/[\\/]+$/, "");
  },
  exists: (x: string) => fs.existsSync(x),
  isfile: (x: string) => fs.existsSync(x) && fs.statSync(x).isFile(),
  isdir: (x: string) => fs.existsSync(x) && fs.statSync(x).isDirectory(),
  abspath: (x: string) => p.resolve(x),
  normpath: (x: string) => p.normalize(x),
  splitext: (x: string) => {
    const i = Math.max(x.lastIndexOf("/"), process.platform === "win32" ? x.lastIndexOf("\\") : -1);
    const base = x.slice(i + 1);
    const lead = base.length - base.replace(/^\.+/, "").length; // leading dots belong to the name
    const dot = base.lastIndexOf(".");
    if (dot <= lead - 1 || dot < 0 || dot < lead) return [x, ""];
    const cut = x.length - (base.length - dot);
    return [x.slice(0, cut), x.slice(cut)];
  },
  split: (x: string) => {
    const i = Math.max(x.lastIndexOf("/"), process.platform === "win32" ? x.lastIndexOf("\\") : -1);
    const head = x.slice(0, i + 1);
    return [/^[\\/]+$/.test(head) ? head : head.replace(/[\\/]+$/, ""), x.slice(i + 1)];
  },
  expanduser: (x: string) => x.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? "~"),
  getsize: (x: string) => wrap(() => fs.statSync(x).size, x),
  sep: p.sep,
};
