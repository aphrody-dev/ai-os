// @aphrody/py2bun/runtime: Python builtins and operators for py2bun-emitted TypeScript (Bun).
import * as fs from "node:fs";
import { format as fmtSpec, percent, strFormat } from "./format";

export { fmtSpec as format };
export const Ellipsis = Symbol("Ellipsis");

// ---------- exceptions ----------
export class BaseException extends Error {
  args: any[];
  __cause__: any = null;
  constructor(...args: any[]) {
    super(args.length === 1 ? str(args[0]) : args.length ? "(" + args.map(repr).join(", ") + ")" : "");
    this.args = args;
    this.name = new.target.name;
  }
}
export class Exception extends BaseException {}
export class SystemExit extends BaseException {}
export class KeyboardInterrupt extends BaseException {}
export class GeneratorExit extends BaseException {}
export class ArithmeticError extends Exception {}
export class ZeroDivisionError extends ArithmeticError {}
export class OverflowError extends ArithmeticError {}
export class LookupError extends Exception {}
export class KeyError extends LookupError {}
export class IndexError extends LookupError {}
export class ValueError extends Exception {}
export class UnicodeDecodeError extends ValueError {}
export class UnicodeEncodeError extends ValueError {}
export class TypeError extends Exception {}
export class AttributeError extends Exception {}
export class NameError extends Exception {}
export class AssertionError extends Exception {}
export class RuntimeError extends Exception {}
export class NotImplementedError extends RuntimeError {}
export class StopIteration extends Exception {}
export class ImportError extends Exception {}
export class EOFError extends Exception {}
export class OSError extends Exception {}
export { OSError as IOError };
export class FileNotFoundError extends OSError {}
export class PermissionError extends OSError {}
export class FileExistsError extends OSError {}
export class TimeoutError extends OSError {}

export function unsupported(what: string): never {
  throw new NotImplementedError(`py2bun: unsupported construct: ${what}`);
}
export function withCause(e: any, c: any) {
  try {
    e.__cause__ = c;
  } catch {}
  return e;
}
export function catches(e: any, t: any): boolean {
  if (Array.isArray(t)) return t.some((x) => catches(e, x));
  if (t === BaseException) return true;
  if (t === Exception) return !(e instanceof SystemExit || e instanceof KeyboardInterrupt || e instanceof GeneratorExit);
  if (t === undefined || t === null) return false;
  try {
    return e instanceof t;
  } catch {
    return false;
  }
}

// ---------- keyword args ----------
export class Kw {
  constructor(public o: Record<string, any>) {}
}
export const kw = (o: Record<string, any>) => new Kw(o);
export function popkw(a: any[]): Record<string, any> {
  const l = a[a.length - 1];
  if (l instanceof Kw) {
    a.pop();
    return l.o;
  }
  return {};
}
function splitKw(a: any[]): [any[], Record<string, any>] {
  const l = a[a.length - 1];
  return l instanceof Kw ? [a.slice(0, -1), l.o] : [a, {}];
}
export function mapObject(x: any): Record<string, any> {
  if (x instanceof Map) return Object.fromEntries(x);
  return x ?? {};
}

// ---------- slices / ranges ----------
/** slice bound: int, bool, bigint or __index__ only (floats and strings are a TypeError) */
function sliceIdx(v: any): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (v && typeof v.__index__ === "function") return Number(v.__index__());
  throw new TypeError("slice indices must be integers or None or have an __index__ method");
}
export class PySlice {
  constructor(public start: any, public stop: any, public step: any) {}
  indices(len: number): [number, number, number] {
    const step = this.step == null ? 1 : sliceIdx(this.step);
    if (step === 0) throw new ValueError("slice step cannot be zero");
    const norm = (v: any, dflt: number, lo: number, hi: number) => {
      if (v == null) return dflt;
      let n = sliceIdx(v);
      if (n < 0) n += len;
      return Math.min(Math.max(n, lo), hi);
    };
    if (step > 0) return [norm(this.start, 0, 0, len), norm(this.stop, len, 0, len), step];
    return [norm(this.start, len - 1, -1, len - 1), norm(this.stop, -1, -1, len - 1), step];
  }
}
export const slice = (a: any, b?: any, c?: any) => (b === undefined && c === undefined ? new PySlice(null, a, null) : new PySlice(a, b ?? null, c ?? null));

export class PyRange {
  constructor(public start: number, public stop: number, public step: number) {}
  get length(): number {
    const { start, stop, step } = this;
    return step > 0 ? Math.max(0, Math.ceil((stop - start) / step)) : Math.max(0, Math.ceil((start - stop) / -step));
  }
  *[Symbol.iterator]() {
    const { start, stop, step } = this;
    if (step > 0) for (let i = start; i < stop; i += step) yield i;
    else for (let i = start; i > stop; i += step) yield i;
  }
  at(i: number) {
    const n = this.length;
    const j = i < 0 ? i + n : i;
    if (j < 0 || j >= n) throw new IndexError("range object index out of range");
    return this.start + j * this.step;
  }
  has(x: number): boolean {
    const { start, stop, step } = this;
    if (!Number.isInteger(x)) return false;
    return step > 0 ? x >= start && x < stop && (x - start) % step === 0 : x <= start && x > stop && (start - x) % -step === 0;
  }
}
const rangeInt = (x: any): number => {
  const v = int(x);
  if (typeof v === "bigint") throw new OverflowError("Python int too large to convert to C ssize_t");
  return v;
};
export function range(a: number, b?: number, c?: number): PyRange {
  if (b === undefined) return new PyRange(0, rangeInt(a), 1);
  const step = c === undefined ? 1 : rangeInt(c);
  if (step === 0) throw new ValueError("range() arg 3 must not be zero");
  return new PyRange(rangeInt(a), rangeInt(b), step);
}

// ---------- truthiness & logic ----------
export function truth(x: any): boolean {
  if (x == null || x === false) return false;
  switch (typeof x) {
    case "boolean":
      return x;
    case "number":
      return x !== 0;
    case "bigint":
      return x !== 0n;
    case "string":
      return x.length > 0;
    case "object": {
      if (x instanceof DataView) return x.byteLength > 0;
      if (Array.isArray(x) || ArrayBuffer.isView(x)) return (x as any).length > 0;
      if (x instanceof Map || x instanceof Set) return x.size > 0;
      if (x instanceof PyRange) return x.length > 0;
      if (typeof x.__bool__ === "function") return !!x.__bool__();
      if (typeof x.__len__ === "function") return x.__len__() > 0;
      if (typeof x.$list === "function") return true; // JObject proxy: Java truthiness is unknown, non-null
      if (typeof x.isEmpty === "function") return !x.isEmpty();
      return true;
    }
    default:
      return true;
  }
}
export function and(...ts: (() => any)[]) {
  let v: any = true;
  for (const t of ts) {
    v = t();
    if (!truth(v)) return v;
  }
  return v;
}
export function or(...ts: (() => any)[]) {
  let v: any = false;
  for (const t of ts) {
    v = t();
    if (truth(v)) return v;
  }
  return v;
}

// ---------- numeric helpers ----------
const MAXS = BigInt(Number.MAX_SAFE_INTEGER);
const norm = (b: bigint): number | bigint => (b <= MAXS && b >= -MAXS ? Number(b) : b);
const isBig = (x: any) => typeof x === "bigint";
const isInt = (x: any) => typeof x === "number" ? Number.isInteger(x) : isBig(x);
const bi = (x: any): bigint => {
  if (isBig(x)) return x;
  if (typeof x === "boolean") return x ? 1n : 0n;
  if (typeof x === "number" && Number.isInteger(x)) return BigInt(x);
  throw new TypeError(`'${typeName(x)}' object cannot be interpreted as an integer`);
};

export function add(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (typeof a === "string" && typeof b === "string") return a + b;
  if (isBig(a) || isBig(b)) {
    if (typeof a !== "number" || Number.isInteger(a)) if (typeof b !== "number" || Number.isInteger(b)) return norm(bi(a) + bi(b));
    return Number(a) + Number(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  if (typeof a === "object" && a && typeof a.__add__ === "function") return a.__add__(b);
  if (b && typeof b === "object" && typeof b.__radd__ === "function") return b.__radd__(a);
  if (typeof a === "bigint" || typeof b === "bigint") {
    if ((isInt(a) || typeof a === "boolean") && (isInt(b) || typeof b === "boolean")) return norm(bi(a) + bi(b));
    if (typeof a === "number" || typeof b === "number") return Number(a) + Number(b);
  }
  if (typeof a === "number" && typeof b === "boolean") return a + Number(b);
  if (typeof a === "boolean" && (typeof b === "number" || typeof b === "boolean")) return Number(a) + Number(b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const o = new Uint8Array(a.length + b.length);
    o.set(a);
    o.set(b, a.length);
    return o;
  }
  throw new TypeError(`unsupported operand type(s) for +: '${typeName(a)}' and '${typeName(b)}'`);
}
export function iadd(a: any, b: any): any {
  if (a && typeof a === "object" && typeof a.__iadd__ === "function") return a.__iadd__(b);
  if (Array.isArray(a)) {
    a.push(...iter(b));
    return a;
  }
  return add(a, b);
}
export function mul(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return a * b;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  const cnt = (n: any): number => {
    if (isBig(n)) return Number(n);
    if (typeof n === "number" && Number.isInteger(n)) return n;
    throw new TypeError("can't multiply sequence by non-int of type 'float'");
  };
  if (typeof a === "string" && (isInt(b))) return cnt(b) > 0 ? a.repeat(cnt(b)) : "";
  if (typeof b === "string" && (isInt(a))) return cnt(a) > 0 ? b.repeat(cnt(a)) : "";
  if (Array.isArray(a) && isInt(b)) return Array.from({ length: Math.max(0, cnt(b)) }, () => a).flat(1);
  if (Array.isArray(b) && isInt(a)) return mul(b, a);
  if (a && typeof a === "object" && typeof a.__mul__ === "function") return a.__mul__(b);
  if (b && typeof b === "object" && typeof b.__rmul__ === "function") return b.__rmul__(a);
  if (typeof a === "number" && typeof b === "number") return a * b;
  if (isBig(a) || isBig(b)) {
    if (isInt(a) && isInt(b)) return norm(bi(a) * bi(b));
    if (typeof a === "number" || typeof b === "number") return Number(a) * Number(b);
  }
  if ((typeof a === "string" && typeof b === "number") || (typeof b === "string" && typeof a === "number")) throw new TypeError("can't multiply sequence by non-int of type 'float'");
  throw new TypeError(`unsupported operand type(s) for *: '${typeName(a)}' and '${typeName(b)}'`);
}
export function sub(a: any, b: any): any {
  if (a instanceof Set && b instanceof Set) return new Set([...a].filter((x) => !b.has(x)));
  if (isBig(a) || isBig(b)) return norm(bi(a) - bi(b));
  return a - b;
}
export function truediv(a: any, b: any): number {
  if (b === 0 || b === 0n || b === false) throw new ZeroDivisionError("division by zero");
  return Number(a) / Number(b);
}
export function floordiv(a: any, b: any): any {
  if ((isBig(a) || isBig(b)) && !(isInt(a) && isInt(b))) return floordiv(Number(a), Number(b));
  if (isBig(a) || isBig(b)) {
    const [x, y] = [bi(a), bi(b)];
    if (y === 0n) throw new ZeroDivisionError("integer division or modulo by zero");
    let q = x / y;
    if ((x % y !== 0n) && ((x < 0n) !== (y < 0n))) q -= 1n;
    return norm(q);
  }
  if (b === 0) throw new ZeroDivisionError("integer division or modulo by zero");
  return Math.floor(a / b);
}
export function mod(a: any, b: any): any {
  if (typeof a === "string") return percent(a, b);
  if ((isBig(a) || isBig(b)) && isInt(a) && isInt(b)) {
    const [x, y] = [bi(a), bi(b)];
    if (y === 0n) throw new ZeroDivisionError("integer division or modulo by zero");
    return norm(((x % y) + y) % y);
  }
  if (isBig(a) || isBig(b)) return mod(Number(a), Number(b));
  if (b === 0) throw new ZeroDivisionError("integer division or modulo by zero");
  if (!Number.isFinite(b)) return Number.isFinite(a) ? (a === 0 || Math.sign(a) === Math.sign(b) ? a : b) : NaN;
  return ((a % b) + b) % b;
}
export function pow(a: any, b: any, m?: any): any {
  if (m !== undefined && m !== null) {
    const mm = bi(m);
    if (mm === 0n) throw new ValueError("pow() 3rd argument cannot be 0");
    const am = ((bi(a) % mm) + mm) % mm;
    let e = bi(b);
    let base = am;
    if (e < 0n) {
      // modular inverse by extended Euclid
      let [t, nt, r0, nr] = [0n, 1n, mm < 0n ? -mm : mm, am];
      while (nr !== 0n) {
        const q = r0 / nr;
        [t, nt] = [nt, t - q * nt];
        [r0, nr] = [nr, r0 - q * nr];
      }
      if (r0 !== 1n) throw new ValueError("base is not invertible for the given modulus");
      base = ((t % mm) + mm) % mm;
      e = -e;
    }
    let r = 1n % mm;
    while (e > 0n) {
      if (e & 1n) r = (r * base) % mm;
      base = (base * base) % mm;
      e >>= 1n;
    }
    return norm(((r % mm) + mm) % mm);
  }
  if (isBig(a) || isBig(b)) {
    if (isInt(a) && isInt(b) && bi(b) >= 0n) return norm(bi(a) ** bi(b));
  }
  return a ** b;
}
const bitop = (a: any, b: any, f: (x: bigint, y: bigint) => bigint, g: (x: number, y: number) => number) => {
  if (typeof a === "number" && typeof b === "number" && Number.isInteger(a) && Number.isInteger(b) && Math.abs(a) < 2 ** 31 && Math.abs(b) < 2 ** 31) return g(a, b);
  return norm(f(bi(a), bi(b)));
};
export const band = (a: any, b: any) => bitop(a, b, (x, y) => x & y, (x, y) => x & y);
export const bor = (a: any, b: any) => bitop(a, b, (x, y) => x | y, (x, y) => x | y);
export const bxor = (a: any, b: any) => bitop(a, b, (x, y) => x ^ y, (x, y) => x ^ y);
const shiftCount = (b: any): bigint => {
  const n = bi(b);
  if (n < 0n) throw new ValueError("negative shift count");
  return n;
};
export const shl = (a: any, b: any) => norm(bi(a) << shiftCount(b));
export const shr = (a: any, b: any) => norm(bi(a) >> shiftCount(b));
export const inv = (a: any) => norm(~bi(a));

export function eq(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const ta = typeof a;
  const tb = typeof b;
  if ((ta === "number" || ta === "bigint" || ta === "boolean") && (tb === "number" || tb === "bigint" || tb === "boolean")) {
    const x = ta === "boolean" ? Number(a) : a;
    const y = tb === "boolean" ? Number(b) : b;
    if (typeof x === "bigint" && typeof y === "bigint") return x === y;
    if (typeof x === "bigint") return Number.isInteger(y) && BigInt(y as number) === x;
    if (typeof y === "bigint") return Number.isInteger(x) && BigInt(x as number) === y;
    return x === y;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && eq(v, b.get(k)));
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((x) => b.has(x));
  if (ta === "object" && typeof a.equals === "function") return !!a.equals(b);
  if (ta === "object" && typeof a.__eq__ === "function") return !!a.__eq__(b);
  return false;
}
export function contains(c: any, x: any): boolean {
  if (typeof c === "string") {
    if (typeof x !== "string") throw new TypeError("'in <string>' requires string as left operand");
    return c.includes(x);
  }
  if (Array.isArray(c)) return c.some((y) => eq(y, x));
  if (c instanceof Set || c instanceof Map) return c.has(x);
  if (c instanceof PyRange) return c.has(typeof x === "boolean" ? Number(x) : x);
  if (ArrayBuffer.isView(c)) return (c as any).includes(x);
  if (c && typeof c.contains === "function") return !!c.contains(x);
  if (c && typeof c.__contains__ === "function") return !!c.__contains__(x);
  if (c && typeof c[Symbol.iterator] === "function") {
    for (const y of c) if (eq(y, x)) return true;
    return false;
  }
  if (c && typeof c === "object") return x in c;
  throw new TypeError(`argument of type '${typeName(c)}' is not iterable`);
}

// ---------- indexing ----------
function seqIndex(len: number, k: any, what: string): number {
  let i: number;
  if (typeof k === "boolean") i = k ? 1 : 0;
  else if (typeof k === "bigint") i = Number(k);
  else if (typeof k === "number") i = k;
  else if (k && typeof k.__index__ === "function") i = Number(k.__index__());
  else throw new TypeError(`${what} indices must be integers or slices, not ${typeName(k)}`);
  if (!Number.isInteger(i)) throw new TypeError(`${what} indices must be integers or slices, not ${typeName(k)}`);
  if (i < 0) i += len;
  if (i < 0 || i >= len) throw new IndexError(`${what} index out of range`);
  return i;
}
export function getitem(o: any, k: any): any {
  if (o == null) throw new TypeError(`'NoneType' object is not subscriptable`);
  if (k instanceof PySlice) {
    if (typeof o === "string" || Array.isArray(o) || ArrayBuffer.isView(o)) {
      const [s, e, st] = k.indices((o as any).length);
      if (st === 1) return typeof o === "string" ? o.slice(s, e) : (o as any).slice(s, Math.max(s, e));
      const out: any[] = [];
      if (st > 0) for (let i = s; i < e; i += st) out.push((o as any)[i]);
      else for (let i = s; i > e; i += st) out.push((o as any)[i]);
      return typeof o === "string" ? out.join("") : out;
    }
    if (typeof o.__getitem__ === "function") return o.__getitem__(k);
    throw new TypeError(`'${typeName(o)}' object is not subscriptable`);
  }
  if (typeof o === "string") return [...o].length === o.length ? o[seqIndex(o.length, k, "string")] : [...o][seqIndex([...o].length, k, "string")];
  if (Array.isArray(o) || ArrayBuffer.isView(o)) return (o as any)[seqIndex((o as any).length, k, "list")];
  if (o instanceof Map) {
    if (!o.has(k)) throw new KeyError(repr(k));
    return o.get(k);
  }
  if (o instanceof PyRange) return o.at(seqIndex(o.length, k, "range"));
  if (typeof o.__getitem__ === "function") return o.__getitem__(k);
  if (typeof o.get === "function" && typeof k === "number" && typeof o.size === "function") return o.get(seqIndex(o.size(), k, "list"));
  if (typeof o.get === "function") return o.get(k);
  return o[k];
}
export function setitem(o: any, k: any, v: any): void {
  if (Array.isArray(o) || ArrayBuffer.isView(o)) {
    if (k instanceof PySlice) {
      const [s, e] = k.indices((o as any).length);
      (o as any[]).splice(s, Math.max(0, e - s), ...iter(v));
    } else (o as any)[seqIndex((o as any).length, k, "list")] = v;
    return;
  }
  if (o instanceof Map) {
    o.set(k, v);
    return;
  }
  if (typeof o.__setitem__ === "function") return o.__setitem__(k, v);
  if (typeof o.put === "function") return void o.put(k, v);
  if (typeof o.set === "function") return void o.set(k, v);
  o[k] = v;
}
export function delitem(o: any, k: any): void {
  if (Array.isArray(o)) {
    if (k instanceof PySlice) {
      const [s, e] = k.indices(o.length);
      o.splice(s, Math.max(0, e - s));
    } else o.splice(seqIndex(o.length, k, "list"), 1);
  } else if (o instanceof Map || o instanceof Set) {
    if (!o.delete(k)) throw new KeyError(repr(k));
  } else if (typeof o.__delitem__ === "function") o.__delitem__(k);
  else delete o[k];
}

// ---------- iteration ----------
export function iter(x: any): any {
  if (x == null) throw new TypeError("'NoneType' object is not iterable");
  if (typeof x === "string" || Array.isArray(x)) return x;
  if (x instanceof Map) return x.keys();
  if (typeof x[Symbol.iterator] === "function") return x;
  if (typeof x.iterator === "function") {
    const it = x.iterator();
    return (function* () {
      while (it.hasNext()) yield it.next();
    })();
  }
  if (typeof x.hasNext === "function") {
    return (function* () {
      while (x.hasNext()) yield x.next();
    })();
  }
  if (typeof x.__iter__ === "function") return x.__iter__();
  if (typeof x === "object" && typeof x.next === "function") return { [Symbol.iterator]: () => x };
  throw new TypeError(`'${typeName(x)}' object is not iterable`);
}
/** Destructuring with CPython's length checks (`a, b = x`; `a, *b = x` needs at least n - 1 values). */
export function unpack(v: any, n: number, star = false): any[] {
  const a = Array.isArray(v) ? v : Array.from(iter(v));
  if (star ? a.length < n - 1 : a.length !== n) {
    const want = star ? `at least ${n - 1}` : String(n);
    throw new ValueError(a.length < (star ? n - 1 : n) ? `not enough values to unpack (expected ${want}, got ${a.length})` : `too many values to unpack (expected ${want})`);
  }
  return a;
}
export function* enumerate(it: any, ...a: any[]) {
  const [pos, k] = splitKw(a);
  let i = pos[0] ?? k.start ?? 0;
  for (const v of iter(it)) yield [i++, v];
}
export function* zip(...a: any[]) {
  const [pos] = splitKw(a);
  const its = pos.map((x: any) => iter(x)[Symbol.iterator]());
  if (!its.length) return;
  while (true) {
    const row: any[] = [];
    for (const it of its) {
      const r = it.next();
      if (r.done) return;
      row.push(r.value);
    }
    yield row;
  }
}
export function* map(f: any, ...its: any[]) {
  if (its.length === 1) for (const v of iter(its[0])) yield f(v);
  else for (const row of zip(...its)) yield f(...row);
}
export function* filter(f: any, it: any) {
  for (const v of iter(it)) if (f == null ? truth(v) : truth(f(v))) yield v;
}
export function reversed(x: any): any[] {
  if (x && typeof x.__reversed__ === "function") return x.__reversed__();
  return Array.from(iter(x)).reverse();
}
export function next(it: any, ...d: any[]) {
  if (it == null || typeof it.next !== "function") throw new TypeError(`'${typeName(it)}' object is not an iterator`);
  const r = it.next();
  if (r.done) {
    if (d.length) return d[0];
    throw new StopIteration();
  }
  return r.value;
}
export function len(x: any): number {
  if (typeof x === "string") return [...x].length === x.length ? x.length : [...x].length;
  if (Array.isArray(x) || ArrayBuffer.isView(x)) return (x as any).length;
  if (x instanceof Map || x instanceof Set) return x.size;
  if (x instanceof PyRange) return x.length;
  if (x && typeof x.__len__ === "function") return x.__len__();
  if (x && typeof x.size === "function") return x.size();
  if (x && typeof x.length === "number") return x.length;
  if (x && typeof x.length === "function") return x.length();
  throw new TypeError(`object of type '${typeName(x)}' has no len()`);
}
export const list = (x?: any) => (x === undefined ? [] : Array.from(iter(x)));
export const tuple = list;
export const set = (x?: any) => new Set(x === undefined ? [] : iter(x));
export const frozenset = set;
export function dict(...a: any[]): Map<any, any> {
  const [pos, k] = splitKw(a);
  const m = new Map<any, any>();
  if (pos.length) {
    const x = pos[0];
    if (x instanceof Map) x.forEach((v, kk) => m.set(kk, v));
    else for (const p of iter(x)) m.set(p[0], p[1]);
  }
  for (const [kk, v] of Object.entries(k)) m.set(kk, v);
  return m;
}
export function items(x: any): any[] {
  if (x instanceof Map) return [...x.entries()].map(([k, v]) => [k, v]);
  if (Array.isArray(x)) return x;
  return Object.entries(x);
}

// ---------- ordering ----------
export function cmp(a: any, b: any): number {
  const numish = (x: any) => typeof x === "number" || typeof x === "bigint" || typeof x === "boolean";
  if (numish(a) && numish(b)) {
    if (a !== a || b !== b) return NaN; // every ordering comparison with NaN is false
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if ((numish(a) || typeof a === "string") && (numish(b) || typeof b === "string" || b == null))
    throw new TypeError(`'<' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (a && typeof a.compareTo === "function") return a.compareTo(b);
  if (a && typeof a.__lt__ === "function") return a.__lt__(b) ? -1 : b.__lt__?.(a) ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}
export function sorted(it: any, ...a: any[]) {
  const [, k] = splitKw(a);
  const arr = Array.from(iter(it));
  return sortArr(arr, k.key, k.reverse);
}
function sortArr(arr: any[], key?: any, reverse?: any) {
  const keyed = arr.map((v, i) => [key ? key(v) : v, v, i] as const);
  const dir = truth(reverse) ? -1 : 1; // stable in both directions: ties keep the original order
  keyed.sort((x, y) => dir * (cmp(x[0], y[0]) || 0) || x[2] - y[2]);
  for (let i = 0; i < arr.length; i++) arr[i] = keyed[i][1];
  return arr;
}
function minmax(name: string, sign: number, a: any[]) {
  const [pos, k] = splitKw(a);
  const items = pos.length === 1 ? Array.from(iter(pos[0])) : pos;
  if (!items.length) {
    if ("default" in k) return k.default;
    throw new ValueError(`${name}() arg is an empty sequence`);
  }
  let best = items[0];
  let bk = k.key ? k.key(best) : best;
  for (let i = 1; i < items.length; i++) {
    const kk = k.key ? k.key(items[i]) : items[i];
    if (cmp(kk, bk) * sign > 0) {
      best = items[i];
      bk = kk;
    }
  }
  return best;
}
export const min = (...a: any[]) => minmax("min", -1, a);
export const max = (...a: any[]) => minmax("max", 1, a);
export function sum(it: any, ...a: any[]) {
  const [pos, k] = splitKw(a);
  const start = pos[0] ?? k.start ?? 0;
  if (typeof start === "string") throw new TypeError("sum() can't sum strings [use ''.join(seq) instead]");
  let t = start;
  for (const v of iter(it)) t = add(t, v);
  return t;
}
export const any = (it: any) => {
  for (const v of iter(it)) if (truth(v)) return true;
  return false;
};
export const all = (it: any) => {
  for (const v of iter(it)) if (!truth(v)) return false;
  return true;
};
export const abs = (x: any) => (isBig(x) ? (x < 0n ? -x : x) : Math.abs(x));
export function round(x: any, n?: number): any {
  if (isBig(x)) {
    if (n == null || n >= 0) return x;
    const p = 10n ** BigInt(-n);
    let q = x / p;
    const r = x - q * p;
    const twice = (r < 0n ? -r : r) * 2n;
    if (twice > p || (twice === p && q % 2n !== 0n)) q += x < 0n ? -1n : 1n;
    return norm(q * p);
  }
  if (n != null && n > 308) return x;
  if (n != null && n < -308) return 0;
  if (n != null && n > 0 && Number.isFinite(x)) {
    // exact decimal expansion of the double decides ties (2.675 is below the tie, 0.125 is one)
    const ax = Math.abs(x);
    const full = /^(\d+)\.(\d+)$/.exec(ax.toFixed(Math.min(100, n + 30)))!;
    const digits = full[2]!;
    if (/^50*$/.test(digits.slice(n))) {
      const head = full[1] + "." + digits.slice(0, n);
      const lastEven = Number(head[head.length - 1]) % 2 === 0;
      const r = lastEven ? Number(head) : Number(ax.toFixed(n));
      return x < 0 ? -r : r;
    }
    return Number(x.toFixed(Math.min(n, 100)));
  }
  if (n == null) {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  const p = 10 ** n;
  const y = x * p;
  const f = Math.floor(y);
  const d = y - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return r / p;
}
export function divmod(a: any, b: any) {
  return [floordiv(a, b), mod(a, b)];
}

// ---------- conversions ----------
export function typeName(x: any): string {
  if (x === null || x === undefined) return "NoneType";
  switch (typeof x) {
    case "number":
      return Number.isInteger(x) ? "int" : "float";
    case "bigint":
      return "int";
    case "boolean":
      return "bool";
    case "string":
      return "str";
  }
  if (Array.isArray(x)) return "list";
  if (x instanceof Map) return "dict";
  if (x instanceof Set) return "set";
  return x.constructor?.name ?? "object";
}
export function int(x?: any, base?: any): any {
  if (x === undefined) return 0;
  if (base !== undefined && base !== null && typeof x !== "string") throw new TypeError("int() can't convert non-string with explicit base");
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number") {
    if (!isFinite(x)) throw new (isNaN(x) ? ValueError : OverflowError)(`cannot convert float ${x} to integer`);
    return Math.trunc(x);
  }
  if (typeof x === "bigint") return norm(x);
  if (typeof x === "string") {
    let s = x.trim();
    let b = base == null ? 10 : Number(base);
    if (!(b === 0 || (b >= 2 && b <= 36)) || !Number.isInteger(b)) throw new ValueError("int() base must be >= 2 and <= 36, or 0");
    let neg = false;
    if (s.startsWith("-")) (neg = true), (s = s.slice(1));
    else if (s.startsWith("+")) s = s.slice(1);
    const pre = /^0([xob])/i.exec(s);
    if (pre && (b === 0 || b === { x: 16, o: 8, b: 2 }[pre[1].toLowerCase() as "x"])) {
      b = { x: 16, o: 8, b: 2 }[pre[1].toLowerCase() as "x"];
      s = s.slice(2);
      if (s.startsWith("_")) s = s.slice(1);
    } else if (b === 0) {
      if (/^0+[1-9]/.test(s)) throw new ValueError(`invalid literal for int() with base 0: ${repr(x)}`);
      b = 10;
    }
    // `_` is only allowed between two digits
    if (/(^_|_$|__)/.test(s)) throw new ValueError(`invalid literal for int() with base ${base ?? 10}: ${repr(x)}`);
    s = s.replace(/_/g, "");
    const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, b);
    if (!s.length || ![...s.toLowerCase()].every((c) => digits.includes(c))) throw new ValueError(`invalid literal for int() with base ${base ?? 10}: ${repr(x)}`);
    let v = 0n;
    for (const c of s.toLowerCase()) v = v * BigInt(b) + BigInt(digits.indexOf(c));
    return norm(neg ? -v : v);
  }
  if (x && typeof x.__int__ === "function") return x.__int__();
  if (x && typeof x.longValue === "function") return norm(BigInt(x.longValue()));
  if (x && typeof x.intValue === "function") return x.intValue();
  throw new TypeError(`int() argument must be a string or a real number, not '${typeName(x)}'`);
}
export function float(x?: any): number {
  if (x === undefined) return 0;
  if (typeof x === "string") {
    const raw = x.trim().toLowerCase();
    if (/(^|[^0-9])_|_($|[^0-9])/.test(raw)) throw new ValueError(`could not convert string to float: ${repr(x)}`);
    const s = raw.replace(/_/g, "");
    if (/^[+-]?(inf|infinity)$/.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(s)) return NaN;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s)) throw new ValueError(`could not convert string to float: ${repr(x)}`);
    return parseFloat(s);
  }
  if (typeof x === "bigint") {
    const f = Number(x);
    if (!Number.isFinite(f)) throw new OverflowError("int too large to convert to float");
    return f;
  }
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (x && typeof x.__float__ === "function") return x.__float__();
  throw new TypeError(`float() argument must be a string or a real number, not '${typeName(x)}'`);
}
export const bool = (x?: any) => truth(x);
export const object = class PyObject {};
export function str(x?: any): string {
  if (x === undefined) return "";
  if (x === null) return "None";
  switch (typeof x) {
    case "string":
      return x;
    case "boolean":
      return x ? "True" : "False";
    case "number":
      if (Number.isInteger(x)) return Object.is(x, -0) ? "-0.0" : String(x);
      if (isNaN(x)) return "nan";
      if (!isFinite(x)) return x < 0 ? "-inf" : "inf";
      return String(x);
    case "bigint":
      return x.toString();
    case "symbol":
      return x === Ellipsis ? "Ellipsis" : x.toString();
    case "function":
      return `<function ${x.name}>`;
  }
  if (x instanceof BaseException) return x.args.length === 1 ? str(x.args[0]) : x.args.length ? repr(x.args) : "";
  if (Array.isArray(x) || x instanceof Map || x instanceof Set || ArrayBuffer.isView(x)) return repr(x);
  if (x instanceof PyRange) return `range(${x.start}, ${x.stop}${x.step !== 1 ? ", " + x.step : ""})`;
  if (typeof x.__str__ === "function") return x.__str__();
  return String(x);
}
function reprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let o = q;
  for (const c of s) {
    if (c === q || c === "\\") o += "\\" + c;
    else if (c === "\n") o += "\\n";
    else if (c === "\r") o += "\\r";
    else if (c === "\t") o += "\\t";
    else if (c.codePointAt(0)! < 0x20 || c === "\x7f") o += "\\x" + c.codePointAt(0)!.toString(16).padStart(2, "0");
    else o += c;
  }
  return o + q;
}
export function repr(x: any): string {
  if (typeof x === "string") return reprStr(x);
  if (Array.isArray(x)) return "[" + x.map(repr).join(", ") + "]";
  if (x instanceof Map) return "{" + [...x].map(([k, v]) => repr(k) + ": " + repr(v)).join(", ") + "}";
  if (x instanceof Set) return x.size ? "{" + [...x].map(repr).join(", ") + "}" : "set()";
  if (x instanceof BaseException) return `${x.name}(${x.args.map(repr).join(", ")})`;
  if (ArrayBuffer.isView(x)) {
    const u = new Uint8Array((x as any).buffer, (x as any).byteOffset, (x as any).byteLength);
    let o = "";
    for (const c of u) o += c === 0x5c ? "\\\\" : c === 0x27 ? "\\'" : c === 10 ? "\\n" : c === 13 ? "\\r" : c === 9 ? "\\t" : c < 0x20 || c >= 0x7f ? "\\x" + c.toString(16).padStart(2, "0") : String.fromCharCode(c);
    return "b'" + o + "'";
  }
  if (x && typeof x.__repr__ === "function") return x.__repr__();
  return str(x);
}
const radix = (x: any, r: number, p: string) => {
  const b = bi(isBig(x) ? x : int(x));
  return (b < 0n ? "-" : "") + p + (b < 0n ? -b : b).toString(r);
};
export const hex = (x: any) => radix(x, 16, "0x");
export const oct = (x: any) => radix(x, 8, "0o");
export const bin = (x: any) => radix(x, 2, "0b");
export const chr = (n: number) => String.fromCodePoint(n);
export function ord(c: string): number {
  if ([...c].length !== 1) throw new TypeError(`ord() expected a character, but string of length ${[...c].length} found`);
  return c.codePointAt(0)!;
}
export const bytes = (x?: any, encoding?: any): Uint8Array => {
  if (x === undefined) return new Uint8Array(0);
  if (typeof x === "number") return new Uint8Array(x);
  if (typeof x === "string") {
    if (encoding === undefined) throw new TypeError("string argument without an encoding");
    return new TextEncoder().encode(x);
  }
  return Uint8Array.from(iter(x) as Iterable<number>, (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new ValueError("bytes must be in range(0, 256)");
    return n;
  });
};
export const bytearray = bytes;

// ---------- reflection ----------
const BUILTIN_TYPES: [any, (x: any) => boolean][] = [];
export function isinstance(x: any, t: any): boolean {
  if (Array.isArray(t)) return t.some((y) => isinstance(x, y));
  switch (t) {
    case int:
      return (typeof x === "number" && Number.isInteger(x)) || typeof x === "bigint" || typeof x === "boolean";
    case float:
      return typeof x === "number" && !Number.isInteger(x);
    case bool:
      return typeof x === "boolean";
    case str:
      return typeof x === "string";
    case list:
    case tuple:
      return Array.isArray(x);
    case dict:
      return x instanceof Map;
    case set:
    case frozenset:
      return x instanceof Set;
    case bytes:
    case bytearray:
      return x instanceof Uint8Array;
    case object:
      return true;
  }
  void BUILTIN_TYPES;
  try {
    return x instanceof t;
  } catch {
    return false;
  }
}
export function issubclass(a: any, b: any): boolean {
  if (Array.isArray(b)) return b.some((y) => issubclass(a, y));
  if (b === object) return true;
  if (a === bool && b === int) return true;
  return a === b || (typeof a === "function" && a.prototype instanceof b);
}
export function type(x: any): any {
  switch (typeof x) {
    case "number":
      return Number.isInteger(x) ? int : float;
    case "bigint":
      return int;
    case "boolean":
      return bool;
    case "string":
      return str;
  }
  if (Array.isArray(x)) return list;
  if (x instanceof Map) return dict;
  if (x instanceof Set) return set;
  return x?.constructor ?? object;
}
export function getattr(o: any, n: string, ...d: any[]) {
  const v = o?.[n];
  if (v === undefined && !(o != null && n in Object(o))) {
    if (d.length) return d[0];
    throw new AttributeError(`'${typeName(o)}' object has no attribute '${n}'`);
  }
  return v;
}
export const setattr = (o: any, n: string, v: any) => void (o[n] = v);
export const hasattr = (o: any, n: string) => o != null && n in Object(o);
export const callable = (x: any) => typeof x === "function";
const ids = new WeakMap<object, number>();
let idc = 0x1000;
export function id(x: any): number {
  if (x === null || (typeof x !== "object" && typeof x !== "function")) return typeof x === "number" ? x : 0;
  if (!ids.has(x)) ids.set(x, (idc += 16));
  return ids.get(x)!;
}
export function hash(x: any): number {
  if (Array.isArray(x) || x instanceof Map || x instanceof Set) throw new TypeError(`unhashable type: '${typeName(x)}'`);
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "bigint") return Number(BigInt.asIntN(32, x));
  if (typeof x === "number") return Number.isInteger(x) ? x | 0 : Math.trunc(x * 1000003) | 0;
  const s = str(x);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
export const vars = (o: any) => new Map(Object.entries(o));
export const dir = (o: any) => {
  const names = new Set<string>();
  for (let p = Object(o); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) Object.getOwnPropertyNames(p).forEach((n) => names.add(n));
  return [...names].sort();
};
Object.defineProperty(Function.prototype, "__name__", { get() { return this.name; }, configurable: true });

// ---------- I/O ----------
export function print(...a: any[]) {
  const [pos, k] = splitKw(a);
  const sep = k.sep ?? " ";
  const end = k.end ?? "\n";
  const s = pos.map(str).join(sep) + end;
  const f = k.file;
  if (f && typeof f.write === "function") f.write(s);
  else process.stdout.write(s);
}
export function input(prompt = "") {
  const p = (globalThis as any).prompt;
  return p ? (p(prompt) ?? "") : "";
}
export function exit(code: any = 0): never {
  const c = typeof code === "number" ? code : code == null ? 0 : (process.stderr.write(str(code) + "\n"), 1);
  process.exit(c);
}
export const quit = exit;

/** Lazy `from pkg import *`: first module in `paths` exporting `name` wins (NameError otherwise). */
export async function starPick(paths: string[], name: string): Promise<any> {
  for (const p of paths) {
    try {
      const mod = await import(p);
      if (name in mod) return mod[name];
    } catch {}
  }
  throw new NameError(`name '${name}' is not defined (star imports: ${paths.join(", ")})`);
}

// Python 2 names still used by Jython-era Ghidra scripts
export { open as file };
export const xrange = range;
export const unicode = str;
export const long = int;
export const raw_input = input;
export const unichr = chr;
export const basestring = str;
export function reduce(f: any, it: any, ...init: any[]) {
  const a = Array.from(iter(it));
  if (!init.length && !a.length) throw new TypeError("reduce() of empty iterable with no initial value");
  let acc = init.length ? init[0] : a.shift();
  for (const x of a) acc = f(acc, x);
  return acc;
}

class PyFile {
  private pos = 0;
  private buf: string | Uint8Array | null = null;
  private out: any[] = [];
  closed = false;
  constructor(private path: string, private mode: string) {
    const bin = mode.includes("b");
    if (mode.startsWith("r") || mode.startsWith("a") || (mode.includes("+") && !mode.startsWith("w"))) {
      try {
        this.buf = bin ? new Uint8Array(fs.readFileSync(path)) : fs.readFileSync(path, "utf8");
      } catch (e: any) {
        if (mode.startsWith("a")) this.buf = bin ? new Uint8Array(0) : "";
        else if (e?.code === "EACCES" || e?.code === "EPERM") throw new PermissionError(`[Errno 13] Permission denied: ${repr(path)}`);
        else if (e?.code === "EISDIR") throw new OSError(`[Errno 21] Is a directory: ${repr(path)}`);
        else throw new FileNotFoundError(`[Errno 2] No such file or directory: ${repr(path)}`);
      }
    }
    if (mode.startsWith("w") && mode.includes("+")) this.buf = bin ? new Uint8Array(0) : "";
    if (mode.startsWith("w")) fs.writeFileSync(path, bin ? new Uint8Array(0) : "");
  }
  private check() {
    if (this.closed) throw new ValueError("I/O operation on closed file");
  }
  read(n?: number): any {
    this.check();
    const b = this.buf as any;
    if (b == null) throw new OSError("not readable");
    const e = n == null || n < 0 ? b.length : Math.min(b.length, this.pos + n);
    const r = b.slice(this.pos, e);
    this.pos = e;
    return r;
  }
  readline(): any {
    this.check();
    const b = this.buf as any;
    if (b == null) throw new OSError("not readable");
    if (this.pos >= b.length) return b instanceof Uint8Array ? new Uint8Array(0) : "";
    const i = b instanceof Uint8Array ? b.indexOf(10, this.pos) : b.indexOf("\n", this.pos);
    const e = i < 0 ? b.length : i + 1;
    const r = b.slice(this.pos, e);
    this.pos = e;
    return r;
  }
  readlines(): any[] {
    const r: any[] = [];
    for (let l = this.readline(); l.length; l = this.readline()) r.push(l);
    return r;
  }
  *[Symbol.iterator]() {
    for (let l = this.readline(); l.length; l = this.readline()) yield l;
  }
  write(s: any): number {
    this.check();
    if (this.mode.startsWith("r") && !this.mode.includes("+")) throw new OSError("not writable");
    const data = typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
    if (this.mode.startsWith("a")) fs.appendFileSync(this.path, data);
    else {
      // write at the current position (r+, w, w+), keeping the read buffer in sync
      const fd = fs.openSync(this.path, fs.existsSync(this.path) ? "r+" : "w+");
      try {
        fs.writeSync(fd, data, 0, data.length, this.pos);
      } finally {
        fs.closeSync(fd);
      }
      this.pos += typeof s === "string" ? s.length : data.length;
    }
    if (this.buf != null) {
      this.buf = this.mode.includes("b") ? new Uint8Array(fs.readFileSync(this.path)) : fs.readFileSync(this.path, "utf8");
    }
    return typeof s === "string" ? s.length : s.length;
  }
  writelines(l: any) {
    for (const s of iter(l)) this.write(s);
  }
  flush() {}
  close() {
    this.closed = true;
  }
  __enter__() {
    return this;
  }
  __exit__() {
    this.close();
  }
}
export function open(path: string, mode: any = "r", ...rest: any[]) {
  const [pos, k] = splitKw([mode, ...rest]);
  return new PyFile(String(path), String(k.mode ?? pos[0] ?? "r"));
}

// ---------- context managers ----------
export function ctxEnter(cm: any) {
  if (cm && typeof cm.__enter__ === "function") return cm.__enter__();
  return cm;
}
/** `__exit__(type, exc, tb)` on the exception path: true means the exception is suppressed. */
export function ctxExitErr(cm: any, e: any): boolean {
  if (cm && typeof cm.__exit__ === "function") return !!cm.__exit__(e?.constructor ?? null, e, null);
  ctxExit(cm);
  return false;
}
export async function ctxAEnter(cm: any) {
  if (cm && typeof cm.__aenter__ === "function") return await cm.__aenter__();
  return ctxEnter(cm);
}
export async function ctxAExit(cm: any) {
  if (cm && typeof cm.__aexit__ === "function") return await cm.__aexit__(null, null, null);
  if (cm && typeof (cm as any)[Symbol.asyncDispose] === "function") return await (cm as any)[Symbol.asyncDispose]();
  return ctxExit(cm);
}
export async function ctxAExitErr(cm: any, e: any): Promise<boolean> {
  if (cm && typeof cm.__aexit__ === "function") return !!(await cm.__aexit__(e?.constructor ?? null, e, null));
  await ctxAExit(cm);
  return false;
}
export function ctxExit(cm: any) {
  if (cm && typeof cm.__exit__ === "function") return cm.__exit__(null, null, null);
  if (cm && typeof cm.close === "function") return cm.close();
  if (cm && typeof (cm as any)[Symbol.dispose] === "function") return (cm as any)[Symbol.dispose]();
}

// ---------- str / list / dict methods (dispatch by receiver, fall back to native) ----------
const stripKw = (a: any[]) => a.filter((x) => !(x instanceof Kw));
const native = (o: any, n: string, a: any[]) => {
  if (o == null) throw new AttributeError(`'NoneType' object has no attribute '${n}'`);
  const f = o[n];
  if (typeof f !== "function") throw new AttributeError(`'${typeName(o)}' object has no attribute '${n}'`);
  return f.apply(o, stripKw(a));
};
const ws = /^[\s\u0085]+|[\s\u0085]+$/g;
function stripChars(s: string, chars: string | null | undefined, l: boolean, r: boolean) {
  if (chars == null) return s.replace(l && r ? ws : l ? /^[\s\u0085]+/ : /[\s\u0085]+$/, "");
  const set = new Set([...chars]);
  const cs = [...s];
  let a = 0;
  let b = cs.length;
  if (l) while (a < b && set.has(cs[a])) a++;
  if (r) while (b > a && set.has(cs[b - 1])) b--;
  return cs.slice(a, b).join("");
}
/** Python-style `s[start:end]` normalization (negative bounds, clamping). */
function sliceStr(o: string, s?: any, e?: any): string {
  const n = o.length;
  const fix = (v: any, d: number) => (v == null ? d : Math.min(Math.max(v < 0 ? v + n : v, 0), n));
  return o.slice(fix(s, 0), fix(e, n));
}
function bounds(n: number, s?: any, e?: any): [number, number] {
  const fix = (v: any, d: number) => (v == null ? d : Math.min(Math.max(v < 0 ? v + n : v, 0), n));
  return [fix(s, 0), fix(e, n)];
}
export const m = {
  join(o: any, it?: any) {
    if (typeof o !== "string") return native(o, "join", [it]);
    const parts: string[] = [];
    for (const x of iter(it)) {
      if (typeof x !== "string") throw new TypeError(`sequence item ${parts.length}: expected str instance, ${typeName(x)} found`);
      parts.push(x);
    }
    return parts.join(o);
  },
  replace(o: any, a?: any, b?: any, n?: any) {
    if (typeof o !== "string") return native(o, "replace", [a, b, n]);
    if (a === "") {
      // Python inserts `b` before every character and at the end, at most n times
      const cs = [...o];
      const lim = n == null || n < 0 ? cs.length + 1 : n;
      let out = "";
      for (let i = 0; i <= cs.length; i++) out += (i < lim ? b : "") + (cs[i] ?? "");
      return out;
    }
    if (n == null || n < 0) return o.split(a).join(b);
    let idx = 0;
    let c = 0;
    let res = "";
    while (c < n) {
      const i = o.indexOf(a, idx);
      if (i < 0) break;
      res += o.slice(idx, i) + b;
      idx = i + a.length;
      c++;
    }
    return res + o.slice(idx);
  },
  split(o: any, ...a: any[]) {
    if (typeof o !== "string") return native(o, "split", a);
    const [pos, k] = splitKw(a);
    const sep = pos[0] ?? k.sep ?? null;
    const max = pos[1] ?? k.maxsplit ?? -1;
    if (sep === null) {
      const t = o.replace(/^[\s\u0085]+/, "");
      if (!t) return [];
      const out: string[] = [];
      let rest = t;
      while (rest.length && (max < 0 || out.length < max)) {
        const mm = /[\s\u0085]+/.exec(rest);
        if (!mm) break;
        out.push(rest.slice(0, mm.index));
        rest = rest.slice(mm.index + mm[0].length);
        if (!rest.length) return out;
      }
      out.push(rest);
      return out;
    }
    if (sep === "") throw new ValueError("empty separator");
    if (max < 0) return o.split(sep);
    const out: string[] = [];
    let rest = o;
    while (out.length < max) {
      const i = rest.indexOf(sep);
      if (i < 0) break;
      out.push(rest.slice(0, i));
      rest = rest.slice(i + sep.length);
    }
    out.push(rest);
    return out;
  },
  rsplit(o: any, ...a: any[]) {
    if (typeof o !== "string") return native(o, "rsplit", a);
    const [pos, k] = splitKw(a);
    const sep = pos[0] ?? k.sep ?? null;
    const max = pos[1] ?? k.maxsplit ?? -1;
    if (sep === "") throw new ValueError("empty separator");
    if (max < 0) return sep === null ? m.split(o) : m.split(o, sep);
    // scan from the right so spacing and leading whitespace are preserved
    const out: string[] = [];
    let rest = o;
    if (sep === null) {
      rest = rest.replace(/[\s\u0085]+$/, "");
      while (out.length < max) {
        const mm = /[\s\u0085]+([^\s\u0085]+)$/.exec(rest);
        if (!mm) break;
        out.unshift(mm[1]!);
        rest = rest.slice(0, mm.index);
      }
      if (out.length === max) out.unshift(rest);
      else if (rest.trim() !== "") out.unshift(rest.replace(/^[\s\u0085]+/, ""));
      return out;
    }
    while (out.length < max) {
      const i = rest.lastIndexOf(sep);
      if (i < 0) break;
      out.unshift(rest.slice(i + sep.length));
      rest = rest.slice(0, i);
    }
    out.unshift(rest);
    return out;
  },
  format(o: any, ...a: any[]) {
    if (typeof o !== "string") return native(o, "format", a);
    const [pos, k] = splitKw(a);
    return strFormat(o, pos, k);
  },
  strip: (o: any, c?: any) => (typeof o === "string" ? stripChars(o, c, true, true) : native(o, "strip", [c])),
  lstrip: (o: any, c?: any) => (typeof o === "string" ? stripChars(o, c, true, false) : native(o, "lstrip", [c])),
  rstrip: (o: any, c?: any) => (typeof o === "string" ? stripChars(o, c, false, true) : native(o, "rstrip", [c])),
  upper: (o: any) => (typeof o === "string" ? o.toUpperCase() : native(o, "upper", [])),
  lower: (o: any) => (typeof o === "string" ? o.toLowerCase() : native(o, "lower", [])),
  startswith(o: any, p: any, s?: any, e?: any) {
    if (typeof o !== "string") return native(o, "startswith", [p, s, e]);
    const t = sliceStr(o, s, e);
    return Array.isArray(p) ? p.some((x) => t.startsWith(x)) : t.startsWith(p);
  },
  endswith(o: any, p: any, s?: any, e?: any) {
    if (typeof o !== "string") return native(o, "endswith", [p, s, e]);
    const t = sliceStr(o, s, e);
    return Array.isArray(p) ? p.some((x) => t.endsWith(x)) : t.endsWith(p);
  },
  append(o: any, x: any) {
    if (Array.isArray(o)) return void o.push(x);
    return native(o, "append", [x]);
  },
  extend(o: any, x: any) {
    if (Array.isArray(o)) return void o.push(...iter(x));
    return native(o, "extend", [x]);
  },
  insert(o: any, i: number, x: any) {
    if (Array.isArray(o)) {
      if (i < 0) i = Math.max(0, o.length + i);
      return void o.splice(i, 0, x);
    }
    return native(o, "insert", [i, x]);
  },
  remove(o: any, x: any) {
    if (Array.isArray(o)) {
      const i = o.findIndex((y) => eq(y, x));
      if (i < 0) throw new ValueError("list.remove(x): x not in list");
      return void o.splice(i, 1);
    }
    return native(o, "remove", [x]);
  },
  pop(o: any, ...a: any[]) {
    if (Array.isArray(o)) {
      if (!o.length) throw new IndexError("pop from empty list");
      return a.length ? o.splice(seqIndex(o.length, a[0], "pop"), 1)[0] : o.pop();
    }
    if (o instanceof Map) {
      if (o.has(a[0])) {
        const v = o.get(a[0]);
        o.delete(a[0]);
        return v;
      }
      if (a.length > 1) return a[1];
      throw new KeyError(repr(a[0]));
    }
    if (o instanceof Set) {
      if (!o.size) throw new KeyError("pop from an empty set");
      const v = o.values().next().value;
      o.delete(v);
      return v;
    }
    return native(o, "pop", a);
  },
  get(o: any, k: any, d?: any) {
    if (o instanceof Map) return o.has(k) ? o.get(k) : d ?? null;
    const v = native(o, "get", [k]);
    return v === undefined ? d ?? null : v;
  },
  setdefault(o: any, k: any, d: any = null) {
    if (o instanceof Map) {
      if (!o.has(k)) o.set(k, d);
      return o.get(k);
    }
    return native(o, "setdefault", [k, d]);
  },
  update(o: any, ...a: any[]) {
    if (o instanceof Map) {
      const [pos, k] = splitKw(a);
      if (pos.length > 1) throw new TypeError(`update expected at most 1 argument, got ${pos.length}`);
      if (pos.length) for (const [kk, v] of pos[0] instanceof Map ? pos[0] : iter(pos[0])) o.set(kk, v);
      for (const [kk, v] of Object.entries(k)) o.set(kk, v);
      return;
    }
    if (o instanceof Set) {
      for (const x of stripKw(a)) for (const y of iter(x)) o.add(y);
      return;
    }
    return native(o, "update", a);
  },
  items: (o: any) => (o instanceof Map ? [...o].map(([k, v]) => [k, v]) : native(o, "items", [])),
  copy(o: any) {
    if (Array.isArray(o)) return o.slice();
    if (o instanceof Map) return new Map(o);
    if (o instanceof Set) return new Set(o);
    return native(o, "copy", []);
  },
  clear(o: any) {
    if (Array.isArray(o)) return void (o.length = 0);
    if (o instanceof Map || o instanceof Set) return o.clear();
    return native(o, "clear", []);
  },
  discard(o: any, x: any) {
    if (o instanceof Set) return void o.delete(x);
    return native(o, "discard", [x]);
  },
  index(o: any, x: any, ...r: any[]) {
    if (Array.isArray(o)) {
      const [s, e] = bounds(o.length, r[0], r[1]);
      for (let i = s; i < e; i++) if (eq(o[i], x)) return i;
      throw new ValueError(`${repr(x)} is not in list`);
    }
    if (typeof o === "string") {
      const [s, e] = bounds(o.length, r[0], r[1]);
      const i = o.slice(0, e).indexOf(x, s);
      if (i < 0) throw new ValueError("substring not found");
      return i;
    }
    return native(o, "index", [x, ...r]);
  },
  find(o: any, x: any, s?: any, e?: any) {
    if (typeof o === "string") {
      const [a, b] = bounds(o.length, s, e);
      return o.slice(0, b).indexOf(x, a);
    }
    return native(o, "find", [x, s, e]);
  },
  rfind(o: any, x: any, s?: any, e?: any) {
    if (typeof o === "string") {
      const [a, b] = bounds(o.length, s, e);
      const i = o.slice(0, b).lastIndexOf(x);
      return i >= a ? i : -1;
    }
    return native(o, "rfind", [x, s, e]);
  },
  count(o: any, x: any) {
    if (Array.isArray(o)) return o.filter((y) => eq(y, x)).length;
    if (typeof o === "string") return x === "" ? o.length + 1 : o.split(x).length - 1;
    return native(o, "count", [x]);
  },
  sort(o: any, ...a: any[]) {
    if (Array.isArray(o)) {
      const [, k] = splitKw(a);
      sortArr(o, k.key, k.reverse);
      return;
    }
    return native(o, "sort", a);
  },
  encode: (o: any, enc?: any) => (typeof o === "string" ? new TextEncoder().encode(o) : native(o, "encode", [enc])),
  decode: (o: any, enc?: any) => (o instanceof Uint8Array ? new TextDecoder(enc ?? "utf-8").decode(o) : native(o, "decode", [enc])),
  isdigit: (o: any) => (typeof o === "string" ? /^[\p{Nd}\p{No}]+$/u.test(o) : native(o, "isdigit", [])),
  isalpha: (o: any) => (typeof o === "string" ? /^\p{L}+$/u.test(o) : native(o, "isalpha", [])),
  isalnum: (o: any) => (typeof o === "string" ? /^[\p{L}\p{N}]+$/u.test(o) : native(o, "isalnum", [])),
  isspace: (o: any) => (typeof o === "string" ? /^[\s\x1c-\x1f\x85]+$/.test(o) : native(o, "isspace", [])),
  isupper: (o: any) => (typeof o === "string" ? o !== o.toLowerCase() && o === o.toUpperCase() : native(o, "isupper", [])),
  islower: (o: any) => (typeof o === "string" ? o !== o.toUpperCase() && o === o.toLowerCase() : native(o, "islower", [])),
  zfill(o: any, w: number) {
    if (typeof o !== "string") return native(o, "zfill", [w]);
    const sg = /^[+-]/.test(o) ? o[0] : "";
    return sg + o.slice(sg.length).padStart(w - sg.length, "0");
  },
  ljust: (o: any, w: number, f = " ") => (typeof o === "string" ? o.padEnd(w, f) : native(o, "ljust", [w, f])),
  rjust: (o: any, w: number, f = " ") => (typeof o === "string" ? o.padStart(w, f) : native(o, "rjust", [w, f])),
  center(o: any, w: number, f = " ") {
    if (typeof o !== "string") return native(o, "center", [w, f]);
    const n = Math.max(0, w - o.length);
    const l = Math.floor(n / 2) + (n % 2 && w % 2 ? 1 : 0);
    return f.repeat(l) + o + f.repeat(n - l);
  },
  title: (o: any) => (typeof o === "string" ? o.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_a, p, c) => p + c.toUpperCase()) : native(o, "title", [])),
  capitalize: (o: any) => (typeof o === "string" ? o.charAt(0).toUpperCase() + o.slice(1).toLowerCase() : native(o, "capitalize", [])),
  splitlines(o: any, ...a: any[]) {
    if (typeof o !== "string") return native(o, "splitlines", a);
    const [pos, k] = splitKw(a);
    const keep = truth(pos[0] ?? k.keepends ?? false);
    const out: string[] = [];
    for (const mm of o.matchAll(/([^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*)(\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/g)) {
      if (mm[0] === "") break;
      out.push(keep ? mm[0] : mm[1]!);
    }
    return out;
  },
  partition(o: any, sep: string) {
    if (typeof o !== "string") return native(o, "partition", [sep]);
    if (sep === "") throw new ValueError("empty separator");
    const i = o.indexOf(sep);
    return i < 0 ? [o, "", ""] : [o.slice(0, i), sep, o.slice(i + sep.length)];
  },
  rpartition(o: any, sep: string) {
    if (typeof o !== "string") return native(o, "rpartition", [sep]);
    if (sep === "") throw new ValueError("empty separator");
    const i = o.lastIndexOf(sep);
    return i < 0 ? ["", "", o] : [o.slice(0, i), sep, o.slice(i + sep.length)];
  },
  removeprefix: (o: any, p: string) => (typeof o === "string" ? (o.startsWith(p) ? o.slice(p.length) : o) : native(o, "removeprefix", [p])),
  removesuffix: (o: any, p: string) => (typeof o === "string" ? (p && o.endsWith(p) ? o.slice(0, o.length - p.length) : o) : native(o, "removesuffix", [p])),
  swapcase: (o: any) => (typeof o === "string" ? [...o].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("") : native(o, "swapcase", [])),
  popitem(o: any) {
    if (o instanceof Map) {
      if (!o.size) throw new KeyError("popitem(): dictionary is empty");
      const k = [...o.keys()].pop();
      const v = o.get(k);
      o.delete(k);
      return [k, v];
    }
    return native(o, "popitem", []);
  },
};

export * from "./async";
