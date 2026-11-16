#!/usr/bin/env bun
// bun ghidra analyze <binary> [--decompile] [--max N] | functions <binary> | decompile <binary> <name> | script <binary> <script.ts> [args]
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProgram, stop, runScript } from "./api.ts";
import { summarize, listFunctions, decompile } from "./analysis.ts";

const [cmd, bin, ...rest] = process.argv.slice(2);
const flag = (n: string) => rest.includes(n);
const opt = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const projectLocation = process.env.GHIDRA_PROJECTS ?? join(tmpdir(), "bun-ghidra-projects");

if (!cmd || !bin) {
  console.error("usage: bun-ghidra analyze|functions|decompile|script <binary> ...");
  process.exit(2);
}
let max: number | undefined;
if (opt("--max") !== undefined) {
  max = Number(opt("--max"));
  if (!Number.isInteger(max) || max < 0) {
    console.error("bun-ghidra: --max needs a non-negative integer");
    process.exit(2);
  }
}
if ((cmd === "script" || cmd === "decompile") && !rest[0]) {
  console.error(`bun-ghidra: ${cmd} needs ${cmd === "script" ? "a script path" : "a function name or address"}`);
  process.exit(2);
}
try {
  if (cmd === "script") {
    await runScript(bin, rest[0]!, { projectLocation, scriptArgs: rest.slice(1), analyze: !flag("--no-analyze") });
  } else {
    const h = await openProgram(bin, { projectLocation, analyze: !flag("--no-analyze") });
    try {
      if (cmd === "analyze") console.log(JSON.stringify(await summarize(h.program, { max, decompile: flag("--decompile") }), null, 2));
      else if (cmd === "functions") console.log(JSON.stringify(await listFunctions(h.program, { max, decompile: flag("--decompile") }), null, 2));
      else if (cmd === "decompile") {
        const want = rest[0]!.replace(/^0x/i, "").toLowerCase();
        const fns = await (await (await h.program.getFunctionManager()).getFunctions(true)).$list();
        let found = false;
        for (const f of fns) {
          const entry = String(await (await f.getEntryPoint()).toString()).replace(/^0x/i, "").toLowerCase();
          if (String(await f.getName()) === rest[0] || entry === want) {
            console.log(await decompile(h.program, f));
            found = true;
            break;
          }
        }
        if (!found) {
          console.error(`bun-ghidra: no function ${rest[0]}`);
          process.exitCode = 1;
        }
      } else throw new Error(`unknown command ${cmd}`);
    } finally {
      await h.close();
    }
  }
} catch (e: any) {
  console.error(`bun-ghidra: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await stop();
}
