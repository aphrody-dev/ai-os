#!/usr/bin/env bun
// py2bun file.py [-o file.ts]  (Bun entrypoint over the Rust CLI)
import { transpileFile } from "./index";

const USAGE = "usage: py2bun file.py [-o|--output file.ts] [--async|--sync] [--strict]";
const args = process.argv.slice(2);
let input: string | undefined;
let out: string | undefined;
let mode: "auto" | "async" | "sync" = "auto";
let strict = false;
let bad = false;
for (let i = 0; i < args.length && !bad; i++) {
  const a = args[i]!;
  if (a === "-o" || a === "--output") {
    out = args[++i];
    if (out === undefined) bad = true;
  } else if (a === "--async") mode = "async";
  else if (a === "--sync") mode = "sync";
  else if (a === "--strict") strict = true;
  else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (a.startsWith("-") || input !== undefined) bad = true;
  else input = a;
}
if (bad || !input) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    const r = await transpileFile(input, out, undefined, mode);
    for (const d of r.diagnostics) console.error(`${input}:${d.line}:${d.col}: ${d.severity}: ${d.message}`);
    if (!out && r.ts) process.stdout.write(r.ts);
    process.exitCode = r.ok && !(strict && r.diagnostics.length) ? 0 : 1;
  } catch (e: any) {
    console.error(`py2bun: ${e?.message ?? e}`);
    process.exitCode = 2;
  }
}
