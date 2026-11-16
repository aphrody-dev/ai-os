// Python `json` subset (dict -> Map).
import { ValueError, Kw } from "./index";

/** bigint markers: serialized exactly, without the intermediate Number (precision) */
const BIGSTART = "\u0001big:";
function plain(x: any, allowNan: boolean): any {
  if (x instanceof Map) return Object.fromEntries([...x].map(([k, v]) => [String(k), plain(v, allowNan)]));
  if (x instanceof Set) return [...x].map((v) => plain(v, allowNan));
  if (Array.isArray(x)) return x.map((v) => plain(v, allowNan));
  if (typeof x === "bigint") return BIGSTART + x.toString();
  if (typeof x === "number" && !Number.isFinite(x)) {
    if (!allowNan) throw new ValueError("Out of range float values are not JSON compliant");
    return `\u0001num:${Number.isNaN(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity"}`;
  }
  return x;
}
function revive(x: any): any {
  if (Array.isArray(x)) return x.map(revive);
  if (x && typeof x === "object") return new Map(Object.entries(x).map(([k, v]) => [k, revive(v)]));
  return x;
}
export function dumps(o: any, ...a: any[]): string {
  const k = a.find((x) => x instanceof Kw)?.o ?? {};
  const ind = k.indent ?? undefined;
  let s = JSON.stringify(plain(o, k.allow_nan ?? true), null, ind);
  // unquote the exact bigint / non-finite markers
  s = s.replace(/"\\u0001big:(-?\d+)"/g, "$1").replace(/"\\u0001num:(NaN|-?Infinity)"/g, "$1");
  // skip string literals so "," and ":" inside them are untouched
  if (ind === undefined) s = s.replace(/"(?:[^"\\]|\\.)*"|([,:])/g, (m, p) => (p ? p + " " : m));
  return s;
}
export function loads(s: string): any {
  try {
    // integers beyond 2^53 keep full precision; NaN/Infinity are accepted like CPython
    const quoted = s.replace(/"(?:[^"\\]|\\.)*"|(-?\d{16,})(?![\d.eE])|\b(NaN|-?Infinity)\b/g, (m, big, nn) => (big ? `"\\u0001big:${big}"` : nn ? `"\\u0001num:${nn}"` : m));
    return revive(
      JSON.parse(quoted, (_k, v) => {
        if (typeof v !== "string") return v;
        if (v.startsWith(BIGSTART)) {
          const b = BigInt(v.slice(BIGSTART.length));
          return b <= BigInt(Number.MAX_SAFE_INTEGER) && b >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
        }
        if (v.startsWith("\u0001num:")) return Number(v.slice(5));
        return v;
      }),
    );
  } catch (e: any) {
    throw new ValueError(`json: ${e.message}`);
  }
}
export const dump = (o: any, f: any, ...a: any[]) => f.write(dumps(o, ...a));
export const load = (f: any) => loads(f.read());
