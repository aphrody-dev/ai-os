// fr2: prove the Rust onBeforeParse plugin runs under bun.
//   bun scripts/native-proof.ts <addon.node> <binary>
// 1. NAPI fast path: addon.analyze(binary)  2. Bun.build with onBeforeParse on <binary>.ghidra.js stub.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeGhidraPlugin } from "../src/plugin.ts";

const [addon, bin] = process.argv.slice(2) as [string, string];
if (!addon || !bin) throw new Error("usage: bun scripts/native-proof.ts <addon.node> <binary>");
const napi = require(addon) as { analyze(p: string, n?: number): string; version(): string };
console.log("version:", napi.version());
const t0 = performance.now();
const rep = JSON.parse(napi.analyze(bin, 16));
console.log("napi analyze ms:", (performance.now() - t0).toFixed(1), "format:", rep.format, "functions:", rep.decompiled_functions.length, "entry:", rep.entry_point_va);

const dir = mkdtempSync(join(tmpdir(), "native-proof-")); // fresh dir: no stale bundle can satisfy the checks below
writeFileSync(join(dir, "target.ghidra.js"), bin); // stub text = binary path
writeFileSync(join(dir, "app.ts"), `import report, { functions, entry } from "./target.ghidra.js";\nconsole.log(JSON.stringify({ n: functions.length, entry, format: report.format, first: functions[0]?.name }));\n`);
const res = await Bun.build({ entrypoints: [join(dir, "app.ts")], outdir: join(dir, "out"), target: "bun", plugins: [nativeGhidraPlugin(addon)] });
console.log("build success:", res.success, res.logs.map(String).join("|"));
if (!res.success) throw new Error("Bun.build failed");
const outFile = join(dir, "out", "app.js");
if (!existsSync(outFile)) throw new Error("bundle missing: " + outFile);
const code = readFileSync(outFile, "utf8");
const has = code.includes("decompiled_functions");
console.log("bundle contains analysis:", has);
if (!has) throw new Error("bundle does not contain the analysis");
const run = Bun.spawnSync(["bun", outFile]);
console.log("bundle run:", run.stdout.toString().trim(), run.stderr.toString().trim());
if (run.exitCode !== 0) throw new Error("bundle run failed");
