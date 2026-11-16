// Minimal protocol-compatible mock of bridge/Bridge.java for local tests (no JVM needed).
import { createInterface } from "node:readline";
const objs = new Map<number, any>();
const idOf = new Map<any, number>(); // identity map, like Bridge.java's IdentityHashMap
let n = 1;
const enc = (v: any): any => {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return { $long: v.toString() };
  if (Array.isArray(v)) return v.map(enc);
  let id = idOf.get(v);
  if (id === undefined) {
    id = n++;
    idOf.set(v, id);
    objs.set(id, v);
  }
  return { $h: id, c: v.constructor?.name ?? "Object" };
};
const dec = (v: any): any => (v && typeof v === "object" && "$h" in v ? objs.get(v.$h) : v && typeof v === "object" && "$long" in v ? BigInt(v.$long) : v);
class Addr { constructor(public off: number) {} toString() { return this.off.toString(16); } getOffset() { return this.off; } }
class Func { constructor(public nm: string, public a: Addr) {} getName() { return this.nm; } getEntryPoint() { return this.a; } }
class FlatMock {
  fns = [new Func("main", new Addr(0x1000)), new Func("helper", new Addr(0x2000))];
  getFirstFunction() { return this.fns[0]; }
  getFunctionAt(a: Addr) { return this.fns.find((f) => f.a.off === a.off) ?? null; }
  toAddr(x: number) { return new Addr(x); }
  getFunctions() { return this.fns; }
  big() { return 2n ** 60n; }
  boom() { throw Object.assign(new Error("kaboom"), { type: "java.lang.IllegalStateException" }); }
}
const classes: Record<string, any> = { "mock.Flat": FlatMock, "java.lang.Math": { max: Math.max } };
const dispatch = (r: any): any => {
  const a = (r.a ?? []).map(dec);
  switch (r.op) {
    case "ping": return "pong";
    case "batch": return r.reqs.map((q: any) => { try { return { id: q.id, result: dispatch(q) }; } catch (e: any) { return { id: q.id, error: { type: e.type ?? "Error", message: e.message, trace: "" } }; } });
    case "new": return enc(new classes[r.c](...a));
    case "static": return enc(classes[r.c][r.m](...a));
    case "call": return enc(objs.get(r.h)[r.m](...a));
    case "list": return objs.get(r.h).map(enc);
    case "str": return String(objs.get(r.h));
    case "release": for (const h of r.hs) { idOf.delete(objs.get(h)); objs.delete(h); } return null;
    default: throw new Error("op " + r.op);
  }
};
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const r = JSON.parse(line);
  try {
    console.log(JSON.stringify({ id: r.id, result: dispatch(r) }));
  } catch (e: any) {
    console.log(JSON.stringify({ id: r.id, error: { type: e.type ?? "Error", message: e.message, trace: "" } }));
  }
}
