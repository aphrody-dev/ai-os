#!/usr/bin/env bun
// Checks the standalone crates (extract.lock.json "standalone"): each has its own dependency graph, so each is its own `cargo check`.
// Crates listed in extract.toml [crates.known-failing] are expected to fail: exit code 1 when a crate fails unexpectedly or a known one builds.
// Usage: bun tools/crates.ts [--jobs=4] [crate-dir...]   Exit code 1 when one fails.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const lock = JSON.parse(readFileSync(resolve(root, "extract.lock.json"), "utf8")) as { standalone: string[] };
const known = (Bun.TOML.parse(readFileSync(resolve(root, "extract.toml"), "utf8")) as { crates?: { "known-failing"?: Record<string, string> } }).crates?.["known-failing"] ?? {};
const only = Bun.argv.slice(2).filter((a) => !a.startsWith("--"));
const jobs = Number(Bun.argv.find((a) => a.startsWith("--jobs="))?.slice(7) ?? 4);
const crates = only.length ? only : lock.standalone;

const failed: string[] = [];
let next = 0;
async function worker() {
  for (let c = crates[next++]; c; c = crates[next++]) {
    const p = Bun.spawn(["cargo", "check", "--manifest-path", `${c}/Cargo.toml`, "--target-dir", `target/standalone/${c.replaceAll("/", "-")}`], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    const expected = c in known;
    console.log(`${code === 0 ? (expected ? "FIXED" : "ok  ") : expected ? "known" : "FAIL"} ${c}${expected ? `  (${known[c]})` : ""}`);
    if ((code !== 0) !== expected) {
      failed.push(c);
      console.log(err.split("\n").filter((l) => /^error/.test(l)).slice(0, 5).join("\n"));
    }
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
console.log(`${crates.length - failed.length}/${crates.length} crates check`);
process.exit(failed.length ? 1 : 0);
