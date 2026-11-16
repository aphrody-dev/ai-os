#!/usr/bin/env bun
// Dependency closure inside a monorepo checkout: units (a directory with a package.json or Cargo.toml) reachable from the
// seeds through workspace package names, relative imports that leave a unit, and Cargo path dependencies.
// Usage: bun tools/closure.ts <checkout> <seed-unit>... [--json] [--stop=<unit>,...]
// --stop: units that are listed when reached but not followed (for example a runtime consumed as a dependency, not extracted).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path/posix";

const args = Bun.argv.slice(2);
const root = (args.shift() ?? ".").replaceAll("\\", "/");
const asJson = args.includes("--json");
const stop = new Set(
  (args.find((a) => a.startsWith("--stop="))?.slice(7) ?? "")
    .split(",")
    .filter(Boolean),
);
const seeds = args.filter((a) => !a.startsWith("--"));

const git = async (...a: string[]) =>
  (await Bun.$`git -C ${root} ${a}`.quiet().text());

const tracked = (await git("ls-files", "-z")).split("\0").filter(Boolean);
const trackedSet = new Set(tracked);

// Units: every directory holding a tracked package.json or Cargo.toml.
const unitDirs = new Set<string>();
for (const f of tracked) {
  const base = f.split("/").pop();
  if (base === "package.json" || base === "Cargo.toml") {
    const d = dirname(f);
    if (d !== ".") unitDirs.add(d);
  }
}
const unitOf = (file: string): string | null => {
  for (let d = dirname(file); d !== "." && d !== "/"; d = dirname(d))
    if (unitDirs.has(d)) return d;
  return null;
};
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Package names -> unit directory.
const byName = new Map<string, string>();
for (const u of unitDirs) {
  const pj = join(u, "package.json");
  if (trackedSet.has(pj)) {
    try {
      const n = JSON.parse(read(pj)).name;
      if (n) byName.set(n, u);
    } catch {
      // not a package manifest
    }
  }
}
const rootToml = existsSync(join(root, "Cargo.toml")) ? read("Cargo.toml") : "";

const edges = new Map<string, Set<string>>();
const add = (from: string, to: string | null | undefined) => {
  if (!to || to === from) return;
  let s = edges.get(from);
  if (!s) edges.set(from, (s = new Set()));
  s.add(to);
};

const filesOf = new Map<string, string[]>();
for (const f of tracked) {
  const u = unitOf(f);
  if (!u) continue;
  let l = filesOf.get(u);
  if (!l) filesOf.set(u, (l = []));
  l.push(f);
}

function scan(u: string) {
  for (const f of filesOf.get(u) ?? []) {
    if (/\.(ts|tsx|js|mjs|json)$/.test(f)) {
      let s = "";
      try {
        s = read(f);
      } catch {
        continue;
      }
      if (f.endsWith("/package.json")) {
        try {
          const j = JSON.parse(s);
          for (const k of ["dependencies", "devDependencies", "peerDependencies"])
            for (const d of Object.keys(j[k] ?? {})) add(u, byName.get(d));
        } catch {
          // not a package manifest
        }
      }
      for (const m of s.matchAll(/(?:from|import\()\s*["'](@aphrody\/[\w-]+)/g))
        add(u, byName.get(m[1]!));
      for (const m of s.matchAll(/["'](\.\.?\/[^"']+)["']/g)) {
        const target = join(dirname(f), m[1]!);
        if (!target.startsWith(`${u}/`))
          add(u, unitOf(`${target}/x`) ?? unitOf(target));
      }
    }
    if (f.endsWith("/Cargo.toml")) {
      const s = read(f);
      for (const m of s.matchAll(/path\s*=\s*"([^"]+)"/g)) {
        const t = join(dirname(f), m[1]!);
        add(u, unitDirs.has(t) ? t : unitOf(`${t}/x`));
      }
      for (const m of s.matchAll(
        /^([\w-]+)\s*(?:=\s*\{[^}]*workspace\s*=\s*true|\.workspace\s*=\s*true)/gm,
      )) {
        const pm = rootToml.match(
          new RegExp(`^${m[1]!}\\s*=\\s*\\{[^}]*path\\s*=\\s*"([^"]+)"`, "m"),
        );
        if (pm) add(u, pm[1]!.replace(/^\.\//, ""));
      }
    }
  }
}

const seen = new Set<string>();
const queue = seeds.map((s) => s.replace(/\/$/, ""));
while (queue.length) {
  const u = queue.pop()!;
  if (seen.has(u)) continue;
  seen.add(u);
  if (stop.has(u)) continue;
  scan(u);
  for (const d of edges.get(u) ?? []) queue.push(d);
}

// Sizes in one pass: tracked bytes per directory.
const totals = new Map<string, number>();
for (const l of (await git("ls-tree", "-r", "-l", "HEAD")).split("\n")) {
  const m = l.match(/^\S+ \S+ \S+\s+(\d+|-)\t(.+)$/);
  if (!m) continue;
  const n = m[1] === "-" ? 0 : Number(m[1]);
  for (let d = dirname(m[2]!); d !== "."; d = dirname(d))
    totals.set(d, (totals.get(d) ?? 0) + n);
}
const rows = [...seen].sort().map((u) => ({
  unit: u,
  mb: +((totals.get(u) ?? 0) / 1e6).toFixed(2),
  needs: [...(edges.get(u) ?? [])].sort(),
}));
if (asJson) console.log(JSON.stringify(rows, null, 2));
else {
  for (const r of rows)
    console.log(`${String(r.mb).padStart(8)} MB  ${r.unit}  <- ${r.needs.join(", ")}`);
  console.log(
    `${rows.length} units, ${rows.reduce((a, r) => a + r.mb, 0).toFixed(1)} MB`,
  );
}
