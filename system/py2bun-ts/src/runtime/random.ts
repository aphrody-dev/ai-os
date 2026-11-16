// Python `random` subset (non-reproducible vs CPython).
import { IndexError, ValueError, iter } from "./index";
export const seed = (_: any) => {};
export const random = () => Math.random();
export const randint = (a: number, b: number) => randrange(a, b + 1);
export function randrange(a: number, b?: number, step = 1): number {
  const [start, stop] = b === undefined ? [0, a] : [a, b];
  if (step === 0) throw new ValueError("zero step for randrange()");
  const n = step > 0 ? Math.ceil((stop - start) / step) : Math.ceil((start - stop) / -step);
  if (n <= 0) throw new ValueError("empty range for randrange()");
  return start + step * Math.floor(Math.random() * n);
}
export const uniform = (a: number, b: number) => a + Math.random() * (b - a);
export function choice(s: any) {
  const a = Array.from(iter(s));
  if (!a.length) throw new IndexError("Cannot choose from an empty sequence");
  return a[Math.floor(Math.random() * a.length)];
}
export function shuffle(a: any[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
