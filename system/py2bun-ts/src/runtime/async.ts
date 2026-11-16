// Async-aware variants used by py2bun in async mode (Ghidra scripts: every call crosses to the JVM).
// JObject proxies (frameworks/re-ts/ghidra) expose `$list()` / `$str()`; anything else behaves as in the sync runtime.
import * as py from "./index";

const isJ = (x: any) => x != null && typeof x === "object" && typeof x.$list === "function";

/** Resolve promises and turn Java iterables / async iterables into arrays; other values pass through. */
export async function materialize(x: any): Promise<any> {
  x = await x;
  if (isJ(x)) return await x.$list();
  if (x != null && typeof x === "object" && typeof x[Symbol.asyncIterator] === "function") {
    const out: any[] = [];
    for await (const v of x) out.push(v);
    return out;
  }
  return x;
}

export async function* aiter(x: any): AsyncGenerator<any> {
  x = await x;
  if (x != null && typeof x === "object" && typeof x[Symbol.asyncIterator] === "function") {
    yield* x;
    return;
  }
  yield* py.iter(isJ(x) ? await x.$list() : x);
}

export async function a_str(x: any): Promise<string> {
  x = await x;
  if (isJ(x) && typeof x.$str === "function") return await x.$str();
  return py.str(x);
}

export async function a_len(x: any) {
  return py.len(await materialize(x));
}
export const a_list = async (x?: any) => py.list(x === undefined ? undefined : await materialize(x));
export const a_tuple = a_list;
export const a_set = async (x?: any) => py.set(x === undefined ? undefined : await materialize(x));
export const a_frozenset = a_set;
const kwOf = (a: any[]): [any[], Record<string, any>] => (a[a.length - 1] instanceof py.Kw ? [a.slice(0, -1), a[a.length - 1].o] : [a, {}]);
/** keys may be async (Java proxy calls): resolve them before ordering */
async function keyed(items: any[], key: any): Promise<[any, any][]> {
  return Promise.all(items.map(async (v) => [key ? await key(v) : v, v] as [any, any]));
}
export async function a_sorted(it: any, ...rest: any[]) {
  const [, k] = kwOf(rest);
  const items = await materialize(it);
  if (!k.key) return py.sorted(items, ...rest);
  const ks = await keyed(items, k.key);
  const dir = py.truth(k.reverse) ? -1 : 1;
  return ks.map((x, i) => [x[0], x[1], i] as const).sort((x, y) => dir * (py.cmp(x[0], y[0]) || 0) || x[2] - y[2]).map((x) => x[1]);
}
export const a_sum = async (it: any, ...a: any[]) => py.sum(await materialize(it), ...a);
async function a_minmax(sign: number, a: any[]) {
  const [pos, k] = kwOf(a);
  const items = pos.length === 1 ? await materialize(pos[0]) : await Promise.all(pos.map((x) => x));
  if (!items.length) {
    if ("default" in k) return k.default;
    throw new py.ValueError(`${sign > 0 ? "max" : "min"}() arg is an empty sequence`);
  }
  const ks = await keyed(items, k.key);
  let best = ks[0]!;
  for (const x of ks.slice(1)) if (py.cmp(x[0], best[0]) * sign > 0) best = x;
  return best[1];
}
export const a_min = (...a: any[]) => a_minmax(-1, a);
export const a_max = (...a: any[]) => a_minmax(1, a);
export const a_any = async (it: any) => py.any(await materialize(it));
export const a_all = async (it: any) => py.all(await materialize(it));
export const a_reversed = async (it: any) => py.reversed(await materialize(it));
export async function a_dict(...a: any[]) {
  return py.dict(...(await Promise.all(a.map((x) => (x instanceof py.Kw ? x : materialize(x))))));
}

export async function* a_enumerate(it: any, ...a: any[]) {
  const [pos, k] = a[a.length - 1] instanceof py.Kw ? [a.slice(0, -1), a[a.length - 1].o] : [a, {}];
  let i = pos[0] ?? k.start ?? 0;
  for await (const v of aiter(it)) yield [i++, v];
}
export async function* a_zip(...its: any[]) {
  const [pos, k] = kwOf(its);
  const arrs = await Promise.all(pos.map(materialize));
  if (py.truth(k.strict) && arrs.some((x) => x.length !== arrs[0].length)) throw new py.ValueError("zip() argument lengths differ");
  yield* py.zip(...arrs);
}
export async function* a_map(f: any, ...its: any[]) {
  const arrs = await Promise.all(its.map(materialize));
  for (const v of py.map(f, ...arrs)) yield await v;
}
export async function* a_filter(f: any, it: any) {
  for await (const v of aiter(it)) if (f == null ? py.truth(v) : py.truth(await f(v))) yield v;
}

/** "fmt" % args with Java objects rendered through `$str()`. */
export async function a_mod(fmt: any, args: any): Promise<any> {
  fmt = await fmt;
  if (typeof fmt !== "string") return py.mod(fmt, await args);
  const conv = async (v: any) => (isJ(await v) ? await a_str(v) : await v);
  if (Array.isArray(args)) return py.mod(fmt, await Promise.all(args.map(conv)));
  return py.mod(fmt, await conv(args));
}

export async function a_contains(c: any, x: any): Promise<boolean> {
  c = await c;
  x = await x;
  if (isJ(c) && typeof c.contains === "function") return !!(await c.contains(x));
  return py.contains(c, x);
}

export async function a_eq(a: any, b: any): Promise<boolean> {
  a = await a;
  b = await b;
  if (isJ(a) && typeof a.equals === "function") return !!(await a.equals(b));
  if (isJ(b) && typeof b.equals === "function") return !!(await b.equals(a));
  return py.eq(a, b);
}

export async function a_and(...ts: (() => Promise<any>)[]) {
  let v: any = true;
  for (const t of ts) {
    v = await t();
    if (!py.truth(v)) return v;
  }
  return v;
}
export async function a_or(...ts: (() => Promise<any>)[]) {
  let v: any = false;
  for (const t of ts) {
    v = await t();
    if (py.truth(v)) return v;
  }
  return v;
}
