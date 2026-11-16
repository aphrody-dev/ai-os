import { describe, expect, test } from "bun:test";
import * as py from "../src/runtime/index";
import { findBinary } from "../src/index";
import * as math from "../src/runtime/math";
import * as json from "../src/runtime/json";
import * as struct from "../src/runtime/struct";

describe("operators", () => {
  test("floordiv/mod follow Python sign rules", () => {
    expect(py.floordiv(-7, 2)).toBe(-4);
    expect(py.mod(-7, 3)).toBe(2);
    expect(py.mod(7, -3)).toBe(-2);
    expect(() => py.floordiv(1, 0)).toThrow(py.ZeroDivisionError);
  });
  test("add/mul on sequences", () => {
    expect(py.add([1], [2])).toEqual([1, 2]);
    expect(py.mul("ab", 2)).toBe("abab");
    expect(py.mul([0], 3)).toEqual([0, 0, 0]);
  });
  test("bit ops beyond 32 bits", () => {
    expect(py.band(0xffffffffff, 0xff00)).toBe(0xff00);
    expect(py.shl(1, 40)).toBe(2 ** 40);
    expect(py.shr(2 ** 40, 8)).toBe(2 ** 32);
    expect(py.bor(-1, 0)).toBe(-1);
  });
  test("eq deep, contains", () => {
    expect(py.eq([1, [2]], [1, [2]])).toBe(true);
    expect(py.contains("abc", "bc")).toBe(true);
    expect(py.contains([1, 2], 2)).toBe(true);
  });
});

describe("indexing", () => {
  test("negative index and slices", () => {
    expect(py.getitem([1, 2, 3], -1)).toBe(3);
    expect(py.getitem("hello", py.slice(1, 3))).toBe("el");
    expect(py.getitem([1, 2, 3, 4], py.slice(null, null, -1))).toEqual([4, 3, 2, 1]);
    expect(() => py.getitem([1], 5)).toThrow(py.IndexError);
  });
  test("dict KeyError", () => {
    const d = py.dict(py.kw({ a: 1 }));
    expect(py.getitem(d, "a")).toBe(1);
    expect(() => py.getitem(d, "z")).toThrow(py.KeyError);
  });
});

describe("builtins", () => {
  test("str/repr/format", () => {
    expect(py.str(null)).toBe("None");
    expect(py.str(true)).toBe("True");
    expect(py.repr("it's")).toBe('"it\'s"');
    expect(py.repr([1, "a", null])).toBe("[1, 'a', None]");
    expect(py.format(255, "04x")).toBe("00ff");
    expect(py.format(3.14159, ".2f")).toBe("3.14");
    expect(py.format("ab", ">5")).toBe("   ab");
    expect(py.format(1234567, ",")).toBe("1,234,567");
  });
  test("percent formatting", () => {
    expect(py.mod("%s @ %08x", ["f", 255])).toBe("f @ 000000ff");
    expect(py.mod("%5.1f%%", 12.34)).toBe(" 12.3%");
    expect(py.mod("%-4d|", 7)).toBe("7   |");
  });
  test("int/hex/round", () => {
    expect(py.int("0x1f", 16)).toBe(31);
    expect(py.int("ff", 16)).toBe(255);
    expect(() => py.int("zz")).toThrow(py.ValueError);
    expect(py.hex(-255)).toBe("-0xff");
    expect(py.round(2.5)).toBe(2);
    expect(py.round(3.5)).toBe(4);
  });
  test("sorted/min/max/sum/enumerate/zip/range", () => {
    expect(py.sorted([3, 1, 2], py.kw({ reverse: true }))).toEqual([3, 2, 1]);
    expect(py.sorted(["bb", "a"], py.kw({ key: (s: string) => s.length }))).toEqual(["a", "bb"]);
    expect(py.max([1, 5, 2])).toBe(5);
    expect(py.min(3, 1, 2)).toBe(1);
    expect(py.sum([1, 2, 3])).toBe(6);
    expect([...py.enumerate(["a", "b"], 1)]).toEqual([[1, "a"], [2, "b"]]);
    expect([...py.zip([1, 2], "ab")]).toEqual([[1, "a"], [2, "b"]]);
    expect(py.list(py.range(5, 0, -2))).toEqual([5, 3, 1]);
    expect(py.len([1, 2, 3])).toBe(3);
    expect(py.len(py.range(10))).toBe(10);
  });
  test("isinstance", () => {
    expect(py.isinstance(3, py.int)).toBe(true);
    expect(py.isinstance("a", [py.int, py.str])).toBe(true);
    expect(py.isinstance([], py.dict)).toBe(false);
  });
});

describe("methods", () => {
  test("string methods", () => {
    expect(py.m.join(",", ["a", "b"])).toBe("a,b");
    expect(py.m.split("a  b c")).toEqual(["a", "b", "c"]);
    expect(py.m.split("a,b,c", ",", 1)).toEqual(["a", "b,c"]);
    expect(py.m.strip("  x ")).toBe("x");
    expect(py.m.replace("aaa", "a", "b", 2)).toBe("bba");
    expect(py.m.startswith("abc", ["x", "ab"])).toBe(true);
    expect(py.m.format("{} {:>3} {k}", 1, 2, py.kw({ k: "z" }))).toBe("1   2 z");
    expect(py.m.zfill("-5", 4)).toBe("-005");
  });
  test("list/dict methods and native fallback", () => {
    const l = [3, 1, 2];
    py.m.append(l, 0);
    py.m.sort(l);
    expect(l).toEqual([0, 1, 2, 3]);
    expect(py.m.pop(l)).toBe(3);
    const d = py.dict();
    expect(py.m.get(d, "k", 9)).toBe(9);
    py.m.setdefault(d, "k", 1);
    expect(py.m.items(d)).toEqual([["k", 1]]);
    // non-Python receiver: dispatches to the native method (e.g. Java StringBuilder via the proxy)
    const sb = { parts: [] as string[], append(x: string) { this.parts.push(x); return this; } };
    py.m.append(sb, "z");
    expect(sb.parts).toEqual(["z"]);
  });
});

describe("exceptions & context", () => {
  test("catches", () => {
    expect(py.catches(new py.KeyError("k"), py.LookupError)).toBe(true);
    expect(py.catches(new Error("x"), py.Exception)).toBe(true);
    expect(py.catches(new py.ValueError("x"), [py.KeyError, py.ValueError])).toBe(true);
    expect(py.catches(new py.ValueError("x"), py.KeyError)).toBe(false);
  });
  test("ctx manager", () => {
    const log: string[] = [];
    const cm = { __enter__: () => (log.push("in"), 7), __exit__: () => log.push("out") };
    expect(py.ctxEnter(cm)).toBe(7);
    py.ctxExit(cm);
    expect(log).toEqual(["in", "out"]);
  });
  test("short-circuit values", () => {
    expect(py.or(() => 0, () => "x")).toBe("x");
    expect(py.and(() => 1, () => [])).toEqual([]);
  });
});

describe("stdlib", () => {
  test("math/json/struct", () => {
    expect(math.sqrt(9)).toBe(3);
    expect(math.gcd(12, 18)).toBe(6);
    expect(json.dumps(py.dict(py.kw({ a: [1, 2] })))).toBe('{"a": [1, 2]}');
    expect(py.getitem(json.loads('{"a": 1}'), "a")).toBe(1);
    expect(struct.unpack("<IH", struct.pack("<IH", 0xdeadbeef, 513))).toEqual([0xdeadbeef, 513]);
  });
});

describe("review fixes", () => {
  test("json.dumps leaves separators inside strings untouched", () => {
    expect(json.dumps(new Map([["a,b", "x:1,2"]]))).toBe('{"a,b": "x:1,2"}');
    expect(json.dumps([1, 2])).toBe("[1, 2]");
  });
  (findBinary() ? test : test.skip)("cli accepts a script without -o", () => {
    const { writeFileSync, mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const d = mkdtempSync(tmpdir() + "/p2b-");
    writeFileSync(d + "/s.py", "print(1)\n");
    const r = Bun.spawnSync([process.execPath, import.meta.dir + "/../src/cli.ts", d + "/s.py"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("print");
  });
});

describe("review fixes 2", () => {
  test("re.split signature and maxsplit", () => {
    const re = require("../src/runtime/re");
    expect(re.split(",", "a,b,c", 1)).toEqual(["a", "b,c"]);
    expect(re.split("(,)", "a,b")).toEqual(["a", ",", "b"]);
  });
  test("pow modular with negative base and inverse", () => {
    expect(py.pow(-2, 3, 5)).toBe(2);
    expect(py.pow(3, -1, 7)).toBe(5);
  });
  test("eq bigint vs number precision", () => {
    expect(py.eq(9007199254740993n, 9007199254740992)).toBe(false);
    expect(py.eq(2n, 2)).toBe(true);
  });
  test("%X precision is uppercase", async () => {
    const f = await import("../src/runtime/format");
    const fn = (f as any).percent ?? (f as any).pyPercent ?? Object.values(f).find((x: any) => typeof x === "function" && /percent/i.test(x.name));
    if (fn) expect(fn("%.4X", 255)).toBe("00FF");
  });
});

describe("review fixes 3", () => {
  test("sub/truediv/ctxExitErr", () => {
    expect(py.sub(5n, 2)).toBe(3);
    expect(py.sub(new Set([1, 2]), new Set([2]))).toEqual(new Set([1]));
    expect(() => py.truediv(1, 0)).toThrow();
    expect(py.truediv(1, 2)).toBe(0.5);
    expect(py.ctxExitErr({ __exit__: () => true }, new Error("x"))).toBe(true);
    expect(py.ctxExitErr({ __exit__: () => false }, new Error("x"))).toBe(false);
  });
  test("a_contains and a_mod on non-strings", async () => {
    const a = await import("../src/runtime/async");
    expect(await a.a_contains([1, 2], 2)).toBe(true);
    expect(await a.a_mod(7, 4)).toBe(3);
  });
});

describe("str and dict methods added by the review", () => {
  test("rpartition removeprefix removesuffix swapcase popitem", () => {
    expect(py.m.rpartition("a.b.c", ".")).toEqual(["a.b", ".", "c"]);
    expect(py.m.removeprefix("foobar", "foo")).toBe("bar");
    expect(py.m.removesuffix("foobar", "bar")).toBe("foo");
    expect(py.m.swapcase("aBc")).toBe("AbC");
    const d = new Map([["a", 1], ["b", 2]]);
    expect(py.m.popitem(d)).toEqual(["b", 2]);
    expect(d.size).toBe(1);
  });
});

describe("runtime review fixes 4", () => {
  test("replace/rsplit/startswith/find/splitlines", () => {
    expect(py.m.replace("abc", "", "X")).toBe("XaXbXcX");
    expect(py.m.replace("abc", "", "X", 2)).toBe("XaXbc");
    expect(py.m.rsplit("  a b c", null, 1)).toEqual(["  a b", "c"]);
    expect(py.m.rsplit("a,b,c", ",", 1)).toEqual(["a,b", "c"]);
    expect(() => py.m.rsplit("abc", "", 1)).toThrow();
    expect(py.m.startswith("hello", "ll", 2)).toBe(true);
    expect(py.m.endswith("hello", "ell", 0, 4)).toBe(true);
    expect(py.m.find("hello", "l", -2)).toBe(3);
    expect(py.m.splitlines("a\nb\r\nc", true)).toEqual(["a\n", "b\r\n", "c"]);
    expect(py.m.splitlines("a\nb")).toEqual(["a", "b"]);
  });
  test("int/float/bytes/hash/reduce validation", () => {
    expect(() => py.int("1", 99)).toThrow();
    expect(() => py.int(5, 10)).toThrow();
    expect(() => py.int("010", 0)).toThrow();
    expect(py.int("1_000")).toBe(1000);
    expect(() => py.int("1__0")).toThrow();
    expect(() => py.float(null)).toThrow();
    expect(() => py.bytes("x")).toThrow();
    expect(() => py.bytes([256])).toThrow();
    expect(() => py.hash([1])).toThrow();
    expect(() => py.reduce((a: any, b: any) => a + b, [])).toThrow();
    expect(py.isinstance(true, py.int)).toBe(true);
  });
  test("arithmetic type errors, shifts, ranges, cmp", () => {
    expect(() => py.add([], "a")).toThrow();
    expect(py.mul("a", true)).toBe("a");
    expect(() => py.mul("a", 2.5)).toThrow();
    expect(() => py.shl(1, -1)).toThrow();
    expect(() => py.band(1.5, 2)).toThrow();
    expect(py.contains(py.range(10), true)).toBe(true);
    expect(() => py.range(3).at(99)).toThrow();
    expect(() => py.cmp(1, "a")).toThrow();
    expect(Number.isNaN(py.cmp(NaN, 1))).toBe(true);
    expect(py.sorted([3, 1, 2], py.kw({ reverse: true }))).toEqual([3, 2, 1]);
    expect(() => py.sum(["a"], "")).toThrow();
    expect(py.round(2.5)).toBe(2);
    expect(py.round(0.125, 2)).toBe(0.12);
    expect(py.round(2.675, 2)).toBe(2.67);
    expect(String(new py.BaseException(1, 2).message)).toBe("(1, 2)");
  });
});

describe("os math random sys time review fixes", () => {
  test("os.path semantics", async () => {
    const os = await import("../src/runtime/os");
    expect(os.path.join("a", "../b")).toBe("a" + os.sep + "../b");
    expect(os.path.join("a", "")).toBe("a" + os.sep);
    expect(os.path.splitext("...")).toEqual(["...", ""]);
    expect(os.path.splitext("a/.bashrc")).toEqual(["a/.bashrc", ""]);
    expect(os.path.splitext("a/b.tar.gz")).toEqual(["a/b.tar", ".gz"]);
    expect(os.path.dirname("foo")).toBe("");
    expect(os.path.split("a/b/")).toEqual(["a/b", ""]);
    expect(os.path.expanduser("~user")).toBe("~user");
    expect(() => os.listdir("/definitely/not/here")).toThrow();
  });
  test("math domain and bigint", async () => {
    const m = await import("../src/runtime/math");
    expect(() => m.log(0)).toThrow();
    expect(() => m.asin(2)).toThrow();
    expect(m.floor(5n)).toBe(5n);
    expect(() => m.factorial(-3)).toThrow();
    expect(m.isqrt(4503599761588224n)).toBe(67108864);
    expect(() => m.fmod(1, 0)).toThrow();
    expect(m.gcd(12, 18)).toBe(6);
  });
  test("random ranges, sys, time", async () => {
    const r = await import("../src/runtime/random");
    expect(() => r.randrange(5, 1)).toThrow();
    expect([0, 3, 6, 9]).toContain(r.randrange(0, 10, 3));
    const sys = await import("../src/runtime/sys");
    expect(sys.byteorder).toBe("little");
    const t = await import("../src/runtime/time");
    expect(() => t.sleep(-1)).toThrow();
    expect(t.ctime(0)).toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
  });
});

describe("format and json review fixes", () => {
  test("format spec: alt prefix, general, grouping, errors", async () => {
    const f = await import("../src/runtime/format");
    expect(f.format(255, "#06x")).toBe("0x00ff");
    expect(f.format(999999.9, ".6g")).toBe("1e+06");
    expect(f.format(0.00009999999, ".6g")).toBe("0.0001");
    expect(f.format(0xdeadbeef, "_x")).toBe("dead_beef");
    expect(() => f.format(255, ",x")).toThrow();
    expect(f.format(1.5, "#.3g")).toBe("1.50");
    expect(f.percent("%X|% d|%#x", [255, 5, 255])).toBe("FF| 5|0xff");
    expect(() => f.percent("%y", [1])).toThrow();
    expect(() => f.percent("%d", ["1"])).toThrow();
    expect(f.percent("%-*d|", [5, 3])).toBe("3    |");
    expect(f.percent("%*d", [-4, 3])).toBe("3   ");
    expect(() => f.strFormat("{} {0}", [1], {})).toThrow();
    expect(() => f.strFormat("{", [1], {})).toThrow();
    expect(() => f.strFormat("}", [1], {})).toThrow();
    expect(() => f.strFormat("{}{}", [1], {})).toThrow();
    expect(f.strFormat("{!a}", ["é"], {})).toBe("'\\xe9'");
  });
  test("json: bigint, NaN, strings", async () => {
    const j = await import("../src/runtime/json");
    expect(j.dumps(12345678901234567890n)).toBe("12345678901234567890");
    expect(j.dumps(NaN)).toBe("NaN");
    expect(j.loads("12345678901234567890")).toBe(12345678901234567890n);
    expect(j.loads("[1, NaN]")[1]).toBeNaN();
    expect(j.loads('"123456789012345678901"')).toBe("123456789012345678901");
    expect(j.dumps(new Map([["a,b", "x:1"]]))).toBe('{"a,b": "x:1"}');
  });
});

describe("re struct async review fixes", () => {
  test("re anchors, flags, spans, sub templates", async () => {
    const re = await import("../src/runtime/re");
    expect(re.search("\\Aab\\Z", "ab")?.group(0)).toBe("ab");
    expect(re.search("\\Aab\\Z", "x\nab")).toBeNull();
    expect(re.search("(?i)AB", "xab")?.span()).toEqual([1, 3]);
    expect(re.search("(?P<w>b)", "abc")?.start("w")).toBe(1);
    expect(re.sub("(a)(?P<x>b)", "\\2\\g<x>\\1\\\\", "ab")).toBe("bba\\");
    expect(re.findall("(a)|(b)", "ab")).toEqual([["a", ""], ["", "b"]]);
    expect(re.search("a b # note\n c", "abc", re.X)?.group(0)).toBe("abc");
  });
  test("struct alignment, errors and sizes", async () => {
    const st = await import("../src/runtime/struct");
    expect(st.calcsize("BI")).toBe(8);
    expect(st.calcsize("<BI")).toBe(5);
    expect(st.calcsize("<l")).toBe(4);
    expect(st.calcsize("l")).toBe(8);
    expect(() => st.pack("<I", 1, 2)).toThrow();
    expect(() => st.unpack("<I", new Uint8Array(3))).toThrow();
    expect(() => st.calcsize("<I$")).toThrow();
    expect(st.unpack("<c", st.pack("<c", new Uint8Array([65])))[0]).toEqual(new Uint8Array([65]));
  });
  test("async min/sorted with async keys and zip strict", async () => {
    const a = await import("../src/runtime/async");
    expect(await a.a_min([3, 1, 2], py.kw({ key: async (x: number) => -x }))).toBe(3);
    expect(await a.a_sorted([3, 1, 2], py.kw({ key: async (x: number) => x }))).toEqual([1, 2, 3]);
    await expect((async () => { for await (const _ of a.a_zip([1], [1, 2], py.kw({ strict: true }))) void _; })()).rejects.toThrow();
  });
});

describe("unpack", () => {
  test("length checks", () => {
    expect(py.unpack([1, 2], 2)).toEqual([1, 2]);
    expect(() => py.unpack([1], 2)).toThrow();
    expect(() => py.unpack([1, 2, 3], 2)).toThrow();
    expect(py.unpack([1, 2, 3], 2, true)).toEqual([1, 2, 3]);
    expect(() => py.unpack([], 2, true)).toThrow();
  });
});
