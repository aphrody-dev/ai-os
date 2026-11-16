// Python `struct` subset: byte order prefixes @ = < > !, formats b B h H i I l L q Q n N P f d x s c ?
// (`p` Pascal strings are not supported). Native mode (`@` or no prefix) aligns fields and uses LP64 sizes.
import { ValueError } from "./index";

export class error extends ValueError {}

const STD: Record<string, number> = { b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, l: 4, L: 4, q: 8, Q: 8, f: 4, d: 8, x: 1, s: 1, "?": 1, c: 1 };
const NATIVE: Record<string, number> = { ...STD, l: 8, L: 8, n: 8, N: 8, P: 8 };

interface Parsed {
  le: boolean;
  native: boolean;
  items: [string, number][];
}
function parse(fmt: string): Parsed {
  let le = true;
  let native = true;
  let i = 0;
  if (fmt.length && "<>=@!".includes(fmt[0]!)) {
    le = fmt[0] !== ">" && fmt[0] !== "!";
    native = fmt[0] === "@";
    i = 1;
  }
  const sizes = native ? NATIVE : STD;
  const items: [string, number][] = [];
  const re = /\s*(\d*)([a-zA-Z?])/y;
  re.lastIndex = i;
  let m: RegExpExecArray | null;
  while (re.lastIndex < fmt.length && (m = re.exec(fmt))) {
    if (m[2] === "p") throw new error("struct: Pascal strings ('p') are not supported");
    if (!(m[2]! in sizes)) throw new error(`bad char in struct format: ${m[2]}`);
    items.push([m[2]!, m[1] ? +m[1] : 1]);
  }
  if (!/^\s*$/.test(fmt.slice(re.lastIndex))) throw new error(`bad char in struct format: ${fmt.slice(re.lastIndex).trim()[0]}`);
  return { le, native, items };
}
const align = (o: number, size: number, native: boolean) => (native && size > 1 ? Math.ceil(o / size) * size : o);

function layout(p: Parsed): { fields: { c: string; off: number; n: number }[]; size: number } {
  const sizes = p.native ? NATIVE : STD;
  const fields: { c: string; off: number; n: number }[] = [];
  let o = 0;
  for (const [c, n] of p.items) {
    const sz = sizes[c]!;
    if (c === "s" || c === "x") {
      fields.push({ c, off: o, n });
      o += n;
      continue;
    }
    for (let k = 0; k < n; k++) {
      o = align(o, sz, p.native);
      fields.push({ c, off: o, n: 1 });
      o += sz;
    }
  }
  return { fields, size: o };
}
export function calcsize(fmt: string) {
  return layout(parse(fmt)).size;
}
export function pack(fmt: string, ...vals: any[]) {
  const p = parse(fmt);
  const { fields, size } = layout(p);
  const expected = fields.filter((f) => f.c !== "x").length;
  if (vals.length !== expected) throw new error(`pack expected ${expected} items for packing (got ${vals.length})`);
  const dv = new DataView(new ArrayBuffer(size));
  const le = p.le;
  let vi = 0;
  for (const { c, off, n } of fields) {
    if (c === "x") continue;
    const v = vals[vi++];
    switch (c) {
      case "s": {
        const b = typeof v === "string" ? new TextEncoder().encode(v) : v;
        if (!(b instanceof Uint8Array)) throw new error("argument for 's' must be a bytes object");
        for (let k = 0; k < n; k++) dv.setUint8(off + k, b[k] ?? 0);
        break;
      }
      case "c": {
        if (!(v instanceof Uint8Array) || v.length !== 1) throw new error("char format requires a bytes object of length 1");
        dv.setUint8(off, v[0]!);
        break;
      }
      case "?": dv.setUint8(off, v ? 1 : 0); break;
      case "b": dv.setInt8(off, v); break;
      case "B": dv.setUint8(off, typeof v === "boolean" ? +v : v); break;
      case "h": dv.setInt16(off, v, le); break;
      case "H": dv.setUint16(off, v, le); break;
      case "i": dv.setInt32(off, v, le); break;
      case "I": dv.setUint32(off, v, le); break;
      case "l": case "n": if (p.native) dv.setBigInt64(off, BigInt(v), le); else dv.setInt32(off, v, le); break;
      case "L": case "N": case "P": if (p.native) dv.setBigUint64(off, BigInt(v), le); else dv.setUint32(off, v, le); break;
      case "q": dv.setBigInt64(off, BigInt(v), le); break;
      case "Q": dv.setBigUint64(off, BigInt(v), le); break;
      case "f": dv.setFloat32(off, v, le); break;
      case "d": dv.setFloat64(off, v, le); break;
    }
  }
  return new Uint8Array(dv.buffer);
}
export function unpack(fmt: string, buf: Uint8Array) {
  const p = parse(fmt);
  const { fields, size } = layout(p);
  if (buf.byteLength !== size) throw new error(`unpack requires a buffer of ${size} bytes`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = p.le;
  const out: any[] = [];
  const num = (b: bigint) => (b >= -9007199254740991n && b <= 9007199254740991n ? Number(b) : b);
  for (const { c, off, n } of fields) {
    switch (c) {
      case "x": break;
      case "s": out.push(buf.slice(off, off + n)); break;
      case "c": out.push(buf.slice(off, off + 1)); break;
      case "?": out.push(!!dv.getUint8(off)); break;
      case "b": out.push(dv.getInt8(off)); break;
      case "B": out.push(dv.getUint8(off)); break;
      case "h": out.push(dv.getInt16(off, le)); break;
      case "H": out.push(dv.getUint16(off, le)); break;
      case "i": out.push(dv.getInt32(off, le)); break;
      case "I": out.push(dv.getUint32(off, le)); break;
      case "l": case "n": out.push(p.native ? num(dv.getBigInt64(off, le)) : dv.getInt32(off, le)); break;
      case "L": case "N": case "P": out.push(p.native ? num(dv.getBigUint64(off, le)) : dv.getUint32(off, le)); break;
      case "q": out.push(num(dv.getBigInt64(off, le))); break;
      case "Q": out.push(num(dv.getBigUint64(off, le))); break;
      case "f": out.push(dv.getFloat32(off, le)); break;
      case "d": out.push(dv.getFloat64(off, le)); break;
    }
  }
  return out;
}
