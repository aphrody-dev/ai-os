import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { ayPlugin, commands, manifest, run, sh } from "../src/ay.ts";
import { discover, loadBunPlugins } from "../src/host.ts";
import { ROOT } from "./util.ts";

const fake = { bin: [process.execPath, join(import.meta.dir, "fixtures", "fake-ay.ts")] };

describe("ay plugin plumbing (stand-in binary)", () => {
  test("manifest and commands come from the binary", async () => {
    const m = await manifest(fake);
    expect(m.version).toBe("9.9.9");
    expect(await commands(fake)).toEqual(["sh", "plugin", "up"]);
  });

  test("a binary speaking another schema major is refused", async () => {
    await expect(manifest({ ...fake, env: { FAKE_AY_API: "aphrody:plugin@1.0.0" } })).rejects.toThrow("unsupported ay plugin api aphrody:plugin@1.0.0");
  });

  test("a binary without the plugin command is reported", async () => {
    await expect(manifest({ bin: [process.execPath, "-e", "process.exit(2)"] })).rejects.toThrow("ay plugin manifest failed");
  });

  test("sh forwards the command and its exit status, and tells the binary which host called", async () => {
    const ok = await sh("echo hi", ["a", "b"], fake);
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.stdout.trim()).toBe("ran:echo hi|ay-sh|a|b:host=bun");
    expect((await sh("exit 7", [], fake)).code).toBe(7);
  });

  test("the virtual module `ay` resolves once the plugin is registered", async () => {
    Bun.plugin(ayPlugin(fake));
    const ay: any = await import("ay" as string);
    expect(ay.API).toBe("aphrody:plugin@0.1.0");
    expect(await ay.commands()).toEqual(["sh", "plugin", "up"]);
    expect((await ay.sh("exit 3")).code).toBe(3);
  });

  test("per-call options add to the plugin defaults instead of replacing them", async () => {
    const plugin = ayPlugin({ ...fake, env: { FAKE_A: "1" } });
    let mod: any;
    plugin.setup({ module: (_n: string, cb: () => any) => (mod = cb().exports) } as any);
    const r = await mod.run(["env"], { env: { FAKE_B: "2" } });
    expect(JSON.parse(r.stdout)).toEqual({ a: "1", b: "2" });
  });

  test("the host finds the ay plugin by its plugin.toml and its [bun] entry", async () => {
    const ay = discover(ROOT).find((p) => p.name === "ay")!;
    expect(ay.bun).toEqual({ entry: "ay.plugin.ts", module: "ay" });
    expect(ay.entry).toBe("ay.plugin.niu");
    expect(await loadBunPlugins(ROOT, ["ay"])).toEqual(["ay"]);
  });
});

// End to end against the real binaries: `AY_BIN=<target>/debug/ay NIU_BIN=<target>/debug/niu bun test system/omniu`
// (built on fr2 with `cargo build -p aphrody -p niubash`). Both hosts must see the same command table.
const AY_BIN = Bun.env.AY_BIN;
const NIU_BIN = Bun.env.NIU_BIN;
describe.skipIf(!AY_BIN || !NIU_BIN)("ay plugin end to end (real ay and niu)", () => {
  test("Bun host: manifest, commands and the embedded engine", async () => {
    const m = await manifest();
    expect(m.api).toBe("aphrody:plugin@0.1.0");
    expect(m.engine.name).toBe("rubash");
    const names = m.commands.map((c) => c.name);
    for (const n of ["sh", "plugin", "up", "gnu"]) expect(names).toContain(n);
    const r = await sh('echo "$1:$((6*7))"; exit 5', ["x"]);
    expect(r.stdout.trim()).toBe("x:42");
    expect(r.code).toBe(5);
  });

  test("niu host: the oh-my-niu loader sources plugins/ay and exposes the same command table", async () => {
    const script = `NIUBASH="${ROOT.replaceAll("\\", "/")}"; NIU_PLUGINS=(ay); source "$NIUBASH/oh-my-niu.niu"; echo "host=$AY_PLUGIN_HOST"; ay_plugin_names; echo ---; ay_sh 'echo from-engine'`;
    const proc = Bun.spawn([NIU_BIN!, "--norc", "-c", script], {
      env: { ...Bun.env, PATH: `${dirname(AY_BIN!)}${process.platform === "win32" ? ";" : ":"}${Bun.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ code, err: err.trim() }).toEqual({ code: 0, err: "" });
    const [head, tail] = out.split("---\n");
    const lines = head!.trim().split("\n");
    expect(lines[0]).toBe("host=niu");
    expect(lines.slice(1)).toEqual(await commands());
    expect(tail!.trim()).toBe("from-engine");
  });
});
