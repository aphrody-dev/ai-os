// fr2 smoke: bun scripts/smoke.ts <binary> [projectLocation]
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stop, withProgram } from "../src/index.ts";

const bin = process.argv[2] ?? (process.platform === "win32" ? "C:/Windows/System32/notepad.exe" : "/bin/ls");
const loc = process.argv[3] ?? join(tmpdir(), "ghidra-smoke");
const t0 = performance.now();
try {
  await withProgram(bin, { projectLocation: loc }, async ({ flat, program }) => {
    console.log("name", await program.getName());
    console.log("lang", await (await program.getLanguageID()).toString());
    const fm = await program.getFunctionManager();
    console.log("functions", await fm.getFunctionCount());
    const first = await flat.getFirstFunction();
    if (first === null) console.log("first <none>");
    else console.log("first", await first.getName(), await (await first.getEntryPoint()).toString());
  });
  console.log("ms", Math.round(performance.now() - t0));
} finally {
  await stop();
}
