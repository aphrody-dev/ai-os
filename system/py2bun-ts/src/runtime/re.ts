// Python `re` subset on JS RegExp.
export const IGNORECASE = 2, I = 2, MULTILINE = 8, M = 8, DOTALL = 16, S = 16, VERBOSE = 64, X = 64;
/** leading inline flags `(?imsx)` move into the flag word */
function inlineFlags(p: string, f: number): [string, number] {
  const m = /^\(\?([aiLmsux]+)\)/.exec(p);
  if (!m) return [p, f];
  for (const c of m[1]!) f |= c === "i" ? 2 : c === "m" ? 8 : c === "s" ? 16 : c === "x" ? 64 : 0;
  return [p.slice(m[0].length), f];
}
/** verbose mode: drop unescaped whitespace and `#` comments outside character classes */
function unverbose(p: string): string {
  let o = "";
  let cls = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      o += c + (p[i + 1] ?? "");
      i++;
    } else if (cls) {
      if (c === "]") cls = false;
      o += c;
    } else if (c === "[") {
      cls = true;
      o += c;
    } else if (c === "#") {
      while (i < p.length && p[i] !== "\n") i++;
    } else if (!/\s/.test(c)) o += c;
  }
  return o;
}
// tokenize escapes so `\\A` (an escaped backslash followed by A) is not mistaken for the anchor
const conv = (p: string, verbose = false) =>
  (verbose ? unverbose(p) : p)
    .replace(/\(\?P<(\w+)>/g, "(?<$1>")
    .replace(/\(\?P=(\w+)\)/g, "\\k<$1>")
    .replace(/\\(.)/gs, (m, c) => (c === "Z" ? "(?![\\s\\S])" : c === "A" ? "(?<![\\s\\S])" : m));
const mk = (p: string, f = 0, g = false) => {
  [p, f] = inlineFlags(p, f);
  return new RegExp(conv(p, !!(f & 64)), (g ? "g" : "") + "d" + (f & 2 ? "i" : "") + (f & 8 ? "m" : "") + (f & 16 ? "s" : "") + "u");
};
class Match {
  constructor(private m: RegExpExecArray) {}
  group(...a: (number | string)[]) {
    const g = (k: any) => (k === 0 || k === undefined ? this.m[0] : typeof k === "number" ? this.m[k] ?? null : this.m.groups?.[k] ?? null);
    return a.length > 1 ? a.map(g) : g(a[0]);
  }
  groups() {
    return this.m.slice(1).map((x) => x ?? null);
  }
  groupdict() {
    return new Map(Object.entries(this.m.groups ?? {}));
  }
  private idx(g: number | string): [number, number] {
    const ind: any = (this.m as any).indices;
    const r = g === 0 ? ind?.[0] : typeof g === "number" ? ind?.[g] : ind?.groups?.[g];
    return r ? [r[0], r[1]] : [-1, -1];
  }
  start(g: number | string = 0) {
    return this.idx(g)[0];
  }
  end(g: number | string = 0) {
    return this.idx(g)[1];
  }
  span(g: number | string = 0) {
    return this.idx(g);
  }
}
const wrap = (m: RegExpExecArray | null) => (m ? new Match(m) : null);
class Pattern {
  constructor(public pattern: string, public flags = 0) {}
  match(s: string) {
    const m = new RegExp("^(?:" + conv(this.pattern) + ")", mk(this.pattern, this.flags).flags).exec(s);
    return wrap(m);
  }
  fullmatch(s: string) {
    return wrap(new RegExp("^(?:" + conv(this.pattern) + ")$", mk(this.pattern, this.flags).flags).exec(s));
  }
  search(s: string) {
    return wrap(mk(this.pattern, this.flags).exec(s));
  }
  findall(s: string) {
    const out: any[] = [];
    for (const m of s.matchAll(mk(this.pattern, this.flags, true))) out.push(m.length > 2 ? m.slice(1).map((x) => x ?? "") : m.length === 2 ? m[1] ?? "" : m[0]);
    return out;
  }
  finditer(s: string) {
    return [...s.matchAll(mk(this.pattern, this.flags, true))].map((m) => new Match(m as RegExpExecArray));
  }
  sub(r: any, s: string, count = 0) {
    let n = 0;
    return s.replace(mk(this.pattern, this.flags, true), (...a: any[]) => {
      if (count && n >= count) return a[0];
      n++;
      // replace() passes (match, ...groups, offset, string[, namedGroups])
      const last = a[a.length - 1];
      const named = typeof last === "object" && last !== null ? last : undefined;
      const tail = named ? 3 : 2;
      const groups = a.slice(1, a.length - tail + 0);
      const offset = a[a.length - tail] as number;
      if (typeof r === "function") {
        const m: any = Object.assign([a[0], ...groups], { index: offset, groups: named });
        return r(new Match(m));
      }
      return String(r).replace(/\\(\\|g<(\w+)>|(\d{1,2}))/g, (_m, esc: string, name?: string, num?: string) => {
        if (esc === "\\") return "\\";
        if (name !== undefined) return (/^\d+$/.test(name) ? a[+name] : named?.[name]) ?? "";
        return (+num! === 0 ? a[0] : groups[+num! - 1]) ?? "";
      });
    });
  }
  split(s: string, maxsplit = 0) {
    const out: any[] = [];
    let last = 0;
    let n = 0;
    for (const m of s.matchAll(mk(this.pattern, this.flags, true))) {
      if (maxsplit > 0 && n >= maxsplit) break;
      if (m[0] === "" && (m.index === 0 || m.index === s.length)) continue;
      out.push(s.slice(last, m.index));
      for (const g of m.slice(1)) out.push(g ?? null);
      last = m.index! + m[0].length;
      n++;
    }
    out.push(s.slice(last));
    return out;
  }
}
export const compile = (p: string, f = 0) => new Pattern(p, f);
export const match = (p: string, s: string, f = 0) => new Pattern(p, f).match(s);
export const fullmatch = (p: string, s: string, f = 0) => new Pattern(p, f).fullmatch(s);
export const search = (p: string, s: string, f = 0) => new Pattern(p, f).search(s);
export const findall = (p: string, s: string, f = 0) => new Pattern(p, f).findall(s);
export const finditer = (p: string, s: string, f = 0) => new Pattern(p, f).finditer(s);
export const sub = (p: string, r: any, s: string, count = 0, f = 0) => new Pattern(p, f).sub(r, s, count);
export const split = (p: string, s: string, maxsplit = 0, f = 0) => new Pattern(p, f).split(s, maxsplit);
export const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
