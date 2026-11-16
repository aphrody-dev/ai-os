// Python `time` subset.
import { ValueError } from "./index";
export const time = () => Date.now() / 1000;
export const perf_counter = () => performance.now() / 1000;
export const monotonic = perf_counter;
export const sleep = (s: number) => {
  if (s < 0) throw new ValueError("sleep length must be non-negative");
  void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
};
const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sun Jun  9 12:00:00 2024" (C asctime layout, local time) */
export const ctime = (secs?: number) => {
  const d = new Date((secs ?? Date.now() / 1000) * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${D[d.getDay()]} ${M[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
};
