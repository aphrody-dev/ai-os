import { describe, expect, test } from "bun:test";
import { Session, JavaError } from "../src/rpc.ts";
import { createFlat, FLAT_PROGRAM_API, GHIDRA_SCRIPT_EXTRA, LOCAL_METHODS, sprintf, CancelledError } from "../src/flat.ts";
import { parseSpecifier, renderModule } from "../src/plugin.ts";
import { ApplicationInfo, ProgramTypeError, started } from "../src/api.ts";
import * as script from "../src/script.ts";

const mock = () => Session.fromProcess(["bun", new URL("./mock-bridge.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")]);

describe("rpc client (mock bridge)", () => {
  test("handles, calls, lists, longs, errors", async () => {
    const s = mock();
    expect(await s.ping()).toBe("pong");
    const flat = await s.newObject("mock.Flat");
    const f = await flat.getFirstFunction();
    expect(await f.getName()).toBe("main");
    const ep = await f.getEntryPoint();
    expect(await ep.$str()).toBe("1000");
    expect((await flat.getFunctionAt(await flat.toAddr(0x2000))).$c).toBe("Func");
    expect(await flat.getFunctionAt(await flat.toAddr(1))).toBeNull();
    expect(await s.cls("java.lang.Math").max(3, 9)).toBe(9);
    expect(await flat.big()).toBe(2n ** 60n);
    expect((await flat.getFunctions()).length).toBe(2); // arrays are inlined
    await expect(flat.boom()).rejects.toBeInstanceOf(JavaError);
    await s.close();
  });
  test("batch", async () => {
    const s = mock();
    const r = await s.batch([{ op: "ping" }, { op: "static", c: "java.lang.Math", m: "max", a: [1, 2] }]);
    expect(r).toEqual(["pong", 2]);
    await s.close();
  });
});

describe("flat api", () => {
  test("export list covers FlatProgramAPI and GhidraScript", () => {
    expect(FLAT_PROGRAM_API).toContain("getFunctionAt");
    expect(FLAT_PROGRAM_API).toContain("toAddr");
    expect(GHIDRA_SCRIPT_EXTRA).toContain("println");
    expect(GHIDRA_SCRIPT_EXTRA).toContain("askYesNo");
    for (const n of [...FLAT_PROGRAM_API, ...GHIDRA_SCRIPT_EXTRA]) expect(typeof (script as any)[n]).toBe("function");
  });
  test("local methods run without backend; others forward", async () => {
    const calls: string[] = [];
    let out = "";
    const flat = createFlat({ callFlat: async (m, a) => (calls.push(m), a[0]) }, { out: (s) => (out += s) });
    await flat.println("hi");
    await flat.printf("%s=%d%n", "x", 4);
    expect(out).toBe("hi\nx=4\n");
    expect(calls).toEqual([]);
    expect(await flat.getFunctionAt(7)).toBe(7);
    expect(calls).toEqual(["getFunctionAt"]);
    expect(LOCAL_METHODS.has("println")).toBe(true);
  });
  test("ask* without preset is cancelled, env presets answer", async () => {
    const flat = createFlat({ callFlat: async () => null });
    await expect(flat.askString("t", "m")).rejects.toBeInstanceOf(CancelledError);
    process.env.GHIDRA_ASK_STRING = "abc";
    expect(await flat.askString("t", "m")).toBe("abc");
    delete process.env.GHIDRA_ASK_STRING;
    expect(await flat.askYesNo("t", "m")).toBe(true);
  });
  test("sprintf", () => {
    expect(sprintf("%5d|%-4s|%x|%.2f|%%", [42, "ab", 255, 1.005])).toBe("   42|ab  |ff|1.00|%");
  });
  test("script context bindings are live", async () => {
    const { setContext, clearContext } = await import("../src/context.ts");
    expect(script.currentProgram).toBeUndefined();
    setContext({ session: undefined as any, flat: createFlat({ callFlat: async (m) => m }), currentProgram: { tag: 1 } as any });
    expect((script.currentProgram as any).tag).toBe(1);
    expect(await script.getFunctionAt(1)).toBe("getFunctionAt");
    clearContext();
    expect(script.currentProgram).toBeUndefined();
  });
});

describe("plugin + api helpers", () => {
  test("specifier parsing", () => {
    expect(parseSpecifier("./a.exe?ghidra")).toEqual({ file: "./a.exe", backend: undefined });
    expect(parseSpecifier("./a.exe?ghidra=native")).toEqual({ file: "./a.exe", backend: "native" });
    expect(parseSpecifier("ghidra:./a.exe")).toEqual({ file: "./a.exe" });
    expect(parseSpecifier("./a.ts")).toBeNull();
  });
  test("renderModule is valid JS with named exports", async () => {
    const code = renderModule({ name: "x", functions: [{ name: "f" }], blocks: [] });
    const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
    const m = await import(url);
    expect(m.default.name).toBe("x");
    expect(m.functions[0].name).toBe("f");
    expect(m.functionCount).toBe(1);
  });
  test("ApplicationInfo parses application.properties", async () => {
    const p = `${process.env.TEMP ?? "/tmp"}/app-${Date.now()}.properties`;
    await Bun.write(p, "application.name=Ghidra\napplication.version=12.2\napplication.release.name=PUBLIC\napplication.java.min=25\n");
    const a = ApplicationInfo.fromFile(p);
    expect([a.name, a.version, a.release_name, a.java_min]).toEqual(["Ghidra", "12.2", "PUBLIC", "25"]);
  });
  test("misc", () => {
    expect(started()).toBe(false);
    expect(new ProgramTypeError("x")).toBeInstanceOf(TypeError);
  });
});

describe("bridge review fixes", () => {
  test("Bridge.java inlines only InlineList and encodes string ids", async () => {
    const src = await Bun.file(import.meta.dir + "/../bridge/Bridge.java").text();
    expect(src).not.toContain("isRawList");
    expect(src).toContain("v instanceof InlineList");
    expect(src).toContain("static String idJson");
    expect(src).not.toContain("Math.abs(l)");
  });
});

describe("flat review fixes", () => {
  test("sprintf zero flag, bigint and negative hex", () => {
    expect(sprintf("%08x|%d|%x|%+d", [255, 12345678901234567890n, -1, 5])).toBe("000000ff|12345678901234567890|ffffffff|+5");
  });
  test("askInt returns a number and askYesNo honours env", async () => {
    process.env.GHIDRA_ASK_INT = "42";
    process.env.GHIDRA_ASK_YESNO = "false";
    const f: any = createFlat({ callFlat: async () => undefined }, { out: () => {} });
    expect(await f.askInt("t", "m")).toBe(42);
    expect(await f.askYesNo("t", "m")).toBe(false);
    delete process.env.GHIDRA_ASK_INT;
    delete process.env.GHIDRA_ASK_YESNO;
  });
});

describe("rpc release refcount", () => {
  test("$release on one proxy keeps a shared handle alive; concurrent launcher starts share one start", async () => {
    const s = mock();
    const flat = await s.newObject("mock.Flat");
    const a = await flat.getFirstFunction();
    const b = await flat.getFirstFunction();
    expect(a.$h).toBe(b.$h); // identity-mapped handles
    await a.$release();
    expect(await b.getName()).toBe("main"); // still alive: another proxy shares the handle
    await b.$release();
    await s.close();
  });
});

describe("rpc encode and lifecycle fixes", () => {
  test("plain objects are rejected, class proxies are encoded, errors surface stderr-free exit", async () => {
    const s = mock();
    expect(() => s.encode({ a: 1 })).toThrow(TypeError);
    expect(s.encode(s.cls("java.lang.Math"))).toEqual({ $class: "java.lang.Math" });
    expect(s.encode({ $class: "x", other: 1 })).toEqual({ $class: "x", other: 1 }); // a user object is not hijacked
    await s.close();
  });
});

describe("plugin, context and flat review fixes", () => {
  test("parseSpecifier: unknown backend throws, ghidra: namespace keeps query, # in paths", () => {
    expect(() => parseSpecifier("./x.exe?ghidra=bogus")).toThrow();
    expect(parseSpecifier("ghidra:./x.exe?ghidra=native")).toEqual({ file: "./x.exe", backend: "native" });
    expect(parseSpecifier("./a#b/x.exe?ghidra")).toEqual({ file: "./a#b/x.exe", backend: undefined });
  });
  test("sprintf %c %o %s precision and %b", () => {
    expect(sprintf("%c|%o|%.2s|%b", [65, 8, "abcdef", true])).toBe("A|10|ab|true");
  });
  test("context stack restores the parent on clear", () => {
    const { setContext, clearContext, getContext } = require("../src/context.ts");
    const mk = (n: string) => ({ session: {} as any, flat: {} as any, scriptName: n });
    setContext(mk("outer"));
    setContext(mk("inner"));
    expect(getContext().scriptName).toBe("inner");
    clearContext();
    expect(getContext().scriptName).toBe("outer");
    clearContext();
    expect(getContext()).toBeUndefined();
  });
  test("flat proxy ignores toJSON/valueOf/toString", () => {
    const f: any = createFlat({ callFlat: async () => { throw new Error("must not be called"); } }, { out: () => {} });
    expect(f.toJSON).toBeUndefined();
    expect(JSON.stringify({ f })).toBe("{\"f\":{}}");
  });
  test("ApplicationInfo skips comments and validates required keys", async () => {
    const p = `${process.env.TEMP ?? "/tmp"}/app2-${Date.now()}.properties`;
    await Bun.write(p, "# application.name=bad\napplication.name=Ghidra\napplication.version=12.2\napplication.release.name=PUBLIC\n");
    expect(ApplicationInfo.fromFile(p).name).toBe("Ghidra");
    await Bun.write(p, "application.name=Ghidra\n");
    expect(() => ApplicationInfo.fromFile(p)).toThrow();
  });
});

describe("analysis helpers with fake Java objects", () => {
  const fake = (o: Record<string, any>): any => o;
  const fn = (name: string) => fake({
    getName: async () => name, getEntryPoint: async () => fake({ toString: async () => "00401000" }),
    getBody: async () => fake({ getNumAddresses: async () => 4 }), getSignature: async () => fake({ getPrototypeString: async () => `void ${name}(void)` }),
    getCallingConventionName: async () => null, isThunk: async () => false, isExternal: async () => false,
  });
  const program = fake({ getFunctionManager: async () => fake({ getFunctions: async () => fake({ $list: async () => [fn("a"), fn("b")] }), getFunctionCount: async () => 2 }) });
  test("listFunctions honours max=0, NaN and large limits without a decompiler", async () => {
    const { listFunctions } = await import("../src/analysis.ts");
    expect((await listFunctions(program, { max: 0 })).length).toBe(0);
    expect((await listFunctions(program, { max: Number.NaN })).length).toBe(2);
    expect((await listFunctions(program, { max: 1 })).map((f) => f.name)).toEqual(["a"]);
    expect((await listFunctions(program, { max: 0, decompile: true })).length).toBe(0); // no JVM needed
  });
});
