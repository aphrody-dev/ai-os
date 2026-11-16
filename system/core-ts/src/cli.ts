#!/usr/bin/env bun
// ay-index: recursive tree-sitter index of src (+ third_party/vendor clones) into sqlite + JSON,
// then skill/doc generation and symbol/doc search from it.
//   bun system/core-ts/src/cli.ts index [root] [--all] [--include a,b] [--db path] [--json path] [--legacy] [--no-shared]
//   (index runs the in-process pipeline of system/core when the library has it; `ay index` is the same engine, in Rust)
//   bun system/core-ts/src/cli.ts gen [root] [--db path]
//   bun system/core-ts/src/cli.ts gen-docs [root] [--scan] [--only readme,plan,llvm,mwg,reference] [--db path]
//   bun system/core-ts/src/cli.ts search <query> [--limit 20] [--db path]
//   bun system/core-ts/src/cli.ts users <needle> [--db path]
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { indexEach, loadCore, loadPipeline, pipelineRun } from "./ffi.ts";
import { generate, generateDocs } from "./generate.ts";
import { liveScanToStore } from "./scanner.ts";
import { searchCodebase } from "./search.ts";
import {
  classification,
  indexCounts,
  openStore,
  usersOf,
  writeFiles,
} from "./store.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    all: { type: "boolean", default: false },
    legacy: { type: "boolean", default: false },
    "no-shared": { type: "boolean", default: false },
    scan: { type: "boolean", default: false },
    include: { type: "string" },
    only: { type: "string" },
    limit: { type: "string" },
    db: { type: "string" },
    json: { type: "string" },
  },
});

if (values.help || positionals[0] === "help") {
  console.log(
    "ay-index <index|gen|gen-docs|search|users> [args] [--all] [--scan] [--include a,b] [--only ...] [--limit N] [--db path] [--json path]",
  );
  process.exit(0);
}

const [cmd = "index", arg] = positionals;
const rootArgCommands = new Set(["index", "gen", "gen-docs"]);
const root = resolve(
  rootArgCommands.has(cmd)
    ? (arg ?? process.env.SRC_ROOT ?? join(import.meta.dir, "..", "..", ".."))
    : (process.env.SRC_ROOT ?? join(import.meta.dir, "..", "..", "..")),
);
const dbPath = values.db ?? join(root, "var", "index", "core.db");
mkdirSync(dirname(dbPath), { recursive: true });
const db = openStore(dbPath);

if (cmd === "index") {
  const core = loadCore();
  if (!core) {
    console.error(
      "aphrody_core_capi introuvable : cargo build -p aphrody-core-capi --release (sur fr1)",
    );
    process.exit(2);
  }
  // Preferred: the in-process pipeline (incremental, BLAKE3-addressed, FTS5), same file as `ay index`.
  // `--legacy` keeps the per-file JSON path below.
  if (!values.legacy && loadPipeline()) {
    const rep = pipelineRun(root, dbPath, {
      includes: values.include?.split(","),
      followIgnore: !values.all,
      shared: !values["no-shared"],
    });
    console.log(JSON.stringify({ ...rep, db: dbPath }));
    process.exit(0);
  }
  const t0 = performance.now();
  const batch: Parameters<typeof writeFiles>[1] extends Iterable<infer T>
    ? T[]
    : never = [];
  const stats = indexEach(
    root,
    (f) => {
      batch.push(f);
      if (batch.length >= 2000) writeFiles(db, batch.splice(0));
    },
    { includes: values.include?.split(","), followIgnore: !values.all },
  );
  writeFiles(db, batch);
  const totalMs = Math.round(performance.now() - t0);
  db.prepare(
    "INSERT OR REPLACE INTO meta VALUES ('root', ?), ('stats', ?), ('indexed_at', ?)",
  ).run(
    root,
    JSON.stringify({ ...stats, total_ms: totalMs }),
    new Date().toISOString(),
  );
  const summary = {
    root,
    lib: core.path,
    ...stats,
    total_ms: totalMs,
    classes: classification(db).slice(0, 200),
  };
  await Bun.write(
    values.json ?? join(dirname(dbPath), "index.json"),
    JSON.stringify(summary, null, 1),
  );
  console.log(JSON.stringify({ ...stats, total_ms: totalMs, db: dbPath }));
} else if (cmd === "gen") {
  for (const r of await generate(db, root))
    console.log(`${r.skill}: ${r.cited} tested files -> ${r.skillPath}`);
} else if (cmd === "gen-docs") {
  const res = await generateDocs(db, root, {
    rescan: values.scan,
    only: values.only?.split(",").filter(Boolean),
  });
  console.log(
    JSON.stringify({
      scanMode: res.scanMode,
      written: res.written,
      indexCounts: res.snapshot.indexCounts,
      crates: res.snapshot.crates.length,
      packages: res.snapshot.packages.length,
      apps: res.snapshot.apps.length,
      headers: res.snapshot.headers.length,
    }),
  );
} else if (cmd === "search") {
  if (!arg) throw new Error("usage: search <query>");
  if (values.scan || indexCounts(db).files === 0) {
    liveScanToStore(db, root);
  }
  const limit = Number(values.limit ?? "20") || 20;
  console.log(JSON.stringify(searchCodebase(db, root, arg, limit), null, 2));
} else if (cmd === "users") {
  if (!arg) throw new Error("usage: users <needle>");
  for (const p of usersOf(db, arg)) console.log(p);
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
