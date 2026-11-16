// Python `math` subset.
import { ValueError, TypeError, int } from "./index";
export const pi = Math.PI;
export const e = Math.E;
export const tau = 2 * Math.PI;
export const inf = Infinity;
export const nan = NaN;
const dom = (ok: boolean) => {
  if (!ok) throw new ValueError("math domain error");
};
const num = (x: any): number => (typeof x === "bigint" ? Number(x) : typeof x === "boolean" ? Number(x) : x);
export const sqrt = (x: any) => {
  const v = num(x);
  dom(!(v < 0));
  return Math.sqrt(v);
};
export const floor = (x: any) => (typeof x === "bigint" ? x : Math.floor(x));
export const ceil = (x: any) => (typeof x === "bigint" ? x : Math.ceil(x));
export const trunc = (x: any) => (typeof x === "bigint" ? x : Math.trunc(x));
export const fabs = (x: any) => Math.abs(num(x));
export const exp = (x: any) => Math.exp(num(x));
export const log = (x: any, b?: any) => {
  const v = num(x);
  dom(v > 0);
  if (b === undefined) return Math.log(v);
  dom(num(b) > 0);
  return Math.log(v) / Math.log(num(b));
};
export const log2 = (x: any) => (dom(num(x) > 0), Math.log2(num(x)));
export const log10 = (x: any) => (dom(num(x) > 0), Math.log10(num(x)));
export const sin = (x: any) => (dom(Number.isFinite(num(x)) || Number.isNaN(num(x))), Math.sin(num(x)));
export const cos = (x: any) => (dom(Number.isFinite(num(x)) || Number.isNaN(num(x))), Math.cos(num(x)));
export const tan = (x: any) => (dom(Number.isFinite(num(x)) || Number.isNaN(num(x))), Math.tan(num(x)));
export const asin = (x: any) => (dom(Math.abs(num(x)) <= 1 || Number.isNaN(num(x))), Math.asin(num(x)));
export const acos = (x: any) => (dom(Math.abs(num(x)) <= 1 || Number.isNaN(num(x))), Math.acos(num(x)));
export const atan = (x: any) => Math.atan(num(x));
export const atan2 = (y: any, x: any) => Math.atan2(num(y), num(x));
export const sinh = (x: any) => Math.sinh(num(x));
export const cosh = (x: any) => Math.cosh(num(x));
export const tanh = (x: any) => Math.tanh(num(x));
export const pow = (x: any, y: any) => Math.pow(num(x), num(y));
export const hypot = (...a: any[]) => Math.hypot(...a.map(num));
export const degrees = (x: any) => (num(x) * 180) / Math.PI;
export const radians = (x: any) => (num(x) * Math.PI) / 180;
export const isnan = (x: any) => Number.isNaN(num(x));
export const isinf = (x: any) => num(x) === Infinity || num(x) === -Infinity;
export const isfinite = (x: any) => Number.isFinite(num(x));
export function gcd(...a: any[]): any {
  let g = 0n;
  for (const x of a) {
    const v = int(x);
    if (typeof x === "number" && !Number.isInteger(x)) throw new TypeError("'float' object cannot be interpreted as an integer");
    let y = BigInt(v) < 0n ? -BigInt(v) : BigInt(v);
    while (y) [g, y] = [y, g % y];
  }
  return g <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(g) : g;
}
export const factorial = (n: any): any => {
  if (typeof n === "number" && !Number.isInteger(n)) throw new TypeError("factorial() only accepts integral values");
  if (n < 0) throw new ValueError("factorial() not defined for negative values");
  let r = 1n;
  for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return r <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(r) : r;
};
export const copysign = (x: any, y: any) => (Math.sign(num(y)) < 0 || Object.is(num(y), -0) ? -Math.abs(num(x)) : Math.abs(num(x)));
export const fmod = (a: any, b: any) => {
  const x = num(a);
  const y = num(b);
  if (y === 0 || !Number.isFinite(x)) throw new ValueError("math domain error");
  return x % y;
};
export const isqrt = (n: any): any => {
  const v = typeof n === "bigint" ? n : BigInt(int(n));
  if (v < 0n) throw new ValueError("isqrt() argument must be nonnegative");
  if (v < 2n) return Number(v);
  let x = BigInt(Math.floor(Math.sqrt(Number(v))));
  // Newton correction until x*x <= v < (x+1)^2
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > v) x -= 1n;
  while ((x + 1n) * (x + 1n) <= v) x += 1n;
  return x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x;
};
