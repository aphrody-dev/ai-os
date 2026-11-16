#!/usr/bin/env bun
// Builds this repository from the legacy monorepo as declared in extract.toml: dependency closure of the seeds (tools/closure.ts),
// `git archive` of the pinned rev, exclusions, root manifests (package.json, Cargo.toml), and extract.lock.json.
// Usage: bun tools/extract.ts [--rev=<sha>]   (the rev is rewritten into extract.toml when given)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve as nativeResolve } from "node:path";
import { join } from "node:path/posix";

const abs = (...p: string[]) => nativeResolve(...p).replaceAll("\\", "/");
const here = abs(import.meta.dir, "..");
const cfgPath = join(here, "extract.toml");
const cfg = Bun.TOML.parse(readFileSync(cfgPath, "utf8")) as {
  source: { repo: string; checkout: string; rev: string };
  select: { seeds: string[]; stop: string[]; paths: string[]; exclude: string[] };
  "package-json": { "drop-dependencies": string[]; repository: string };
};
const arg = (k: string) => Bun.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

const legacy = abs(here, cfg.source.checkout);
const sh = async (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${err.trim()}`);
  return out;
};

let rev = arg("rev") ?? cfg.source.rev;
rev = (await sh(legacy, "git", "rev-parse", rev)).trim();
if (rev !== cfg.source.rev) writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/^rev = ".*"/m, `rev = "${rev}"`));

// 1. Closure at the pinned rev: checked out into a scratch index-free listing through git itself (the closure tool reads HEAD sizes,
// so it must run on a checkout whose HEAD is the rev; legacy HEAD is used and compared).
const head = (await sh(legacy, "git", "rev-parse", "HEAD")).trim();
if (head !== rev) console.warn(`warning: legacy HEAD ${head.slice(0, 9)} differs from the pinned rev ${rev.slice(0, 9)}; the closure follows HEAD, files come from the rev`);
const rows = JSON.parse(
  await sh(here, "bun", "tools/closure.ts", legacy, ...cfg.select.seeds, `--stop=${cfg.select.stop.join(",")}`, "--json"),
) as { unit: string; mb: number; needs: string[] }[];
const units = rows.map((r) => r.unit).filter((u) => !cfg.select.stop.includes(u));

// 2. Previous extraction out, new one in.
const lockPath = join(here, "extract.lock.json");
if (existsSync(lockPath)) {
  const old = JSON.parse(readFileSync(lockPath, "utf8")) as { roots: string[] };
  for (const r of old.roots) rmSync(join(here, r), { recursive: true, force: true });
}
const roots = [...new Set([...units, ...cfg.select.paths])].sort();
const nested = (r: string) => roots.some((o) => o !== r && r.startsWith(`${o}/`));
const top = roots.filter((r) => !nested(r));
const tar = join(here, ".extract.tar");
await sh(legacy, "git", "archive", "--format=tar", `--output=${tar}`, rev, "--", ...top);
await sh(here, "tar", "-xf", ".extract.tar");
rmSync(tar);

// 3. Exclusions.
const glob = (p: string) => new Bun.Glob(p);
for (const pat of cfg.select.exclude)
  for (const f of glob(pat).scanSync({ cwd: here, onlyFiles: true, dot: true }))
    if (top.some((t) => f.startsWith(`${t}/`) || f === t)) rmSync(join(here, f), { force: true });

// 3b. Patches of this repository over the extracted tree (patches/*.patch, applied in name order): fixes of legacy assumptions.
const patchDir = join(here, "patches");
if (existsSync(patchDir))
  for (const p of [...new Bun.Glob("*.patch").scanSync({ cwd: patchDir })].sort())
    await sh(here, "git", "apply", "--whitespace=nowarn", join("patches", p));

// 4. package.json rewrites: dropped dependencies, repository field.
const tsUnits: string[] = [];
for (const u of units) {
  const pj = join(here, u, "package.json");
  if (!existsSync(pj)) continue;
  tsUnits.push(u);
  const j = JSON.parse(readFileSync(pj, "utf8"));
  for (const k of ["dependencies", "devDependencies", "peerDependencies"])
    for (const d of cfg["package-json"]["drop-dependencies"]) if (j[k]) delete j[k][d];
  if (j.repository && typeof j.repository === "object") j.repository.url = `git+${cfg["package-json"].repository}.git`;
  writeFileSync(pj, `${JSON.stringify(j, null, 2)}\n`);
}

// 5. Root package.json: workspaces are the TypeScript units, versions come from the legacy catalog.
const legacyRoot = JSON.parse(await sh(legacy, "git", "show", `${rev}:package.json`));
const usedCatalog = new Set<string>();
for (const u of tsUnits) {
  const j = JSON.parse(readFileSync(join(here, u, "package.json"), "utf8"));
  for (const k of ["dependencies", "devDependencies"])
    for (const [n, v] of Object.entries<string>(j[k] ?? {})) if (String(v).startsWith("catalog:")) usedCatalog.add(n);
}
const catalog = Object.fromEntries(Object.entries<string>(legacyRoot.workspaces?.catalog ?? legacyRoot.catalog ?? {}).filter(([n]) => usedCatalog.has(n) || n === "@types/bun" || n === "typescript"));
const rootPkg = {
  name: "@aphrody/ai-os-monorepo",
  private: true,
  type: "module",
  packageManager: legacyRoot.packageManager,
  workspaces: { packages: tsUnits, catalog },
  scripts: {
    extract: "bun tools/extract.ts",
    closure: "bun tools/closure.ts ../legacy",
    test: "bun test frameworks/ai-os/test",
    check: "bun check",
    fmt: "bun fmt",
  },
  devDependencies: { "@types/bun": "catalog:", typescript: "catalog:" },
  license: "MIT OR Apache-2.0",
  repository: { type: "git", url: `git+${cfg["package-json"].repository}.git` },
};
writeFileSync(join(here, "package.json"), `${JSON.stringify(rootPkg, null, 2)}\n`);

// 6. Root Cargo.toml: members are the extracted crates that are members of the legacy workspace; dependencies, lints and profiles
// are the legacy entries those crates use.
const legacyToml = await sh(legacy, "git", "show", `${rev}:Cargo.toml`);
const parsed = Bun.TOML.parse(legacyToml) as { workspace: { members: string[]; package: Record<string, string> } };
const legacyMembers = new Set(parsed.workspace.members);
// Members: the extracted crates that are members of the legacy workspace. The others are standalone published crates, each with its own
// dependency graph (native libraries such as sqlite3 may conflict across them): they are excluded and checked one by one (tools/crates.ts).
const crates = units.filter((u) => existsSync(join(here, u, "Cargo.toml"))).sort();
// A crate that inherits from the workspace root (`workspace = true`) cannot be excluded: it is a member too.
const inherits = (u: string) => /workspace\s*=\s*true/.test(readFileSync(join(here, u, "Cargo.toml"), "utf8"));
const members = crates.filter((u) => legacyMembers.has(u) || inherits(u));
const standalone = crates.filter((u) => !members.includes(u));

const section = (header: string) => {
  const lines = legacyToml.split("\n");
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^\[/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
};
// Top-level entries of [workspace.dependencies]: a key, then lines until braces and brackets balance.
const entries = new Map<string, string>();
{
  let key = "";
  let buf: string[] = [];
  let depth = 0;
  for (const l of section("workspace.dependencies")) {
    if (!key) {
      const m = l.match(/^([\w.-]+)\s*=/);
      if (!m) continue;
      key = m[1]!;
      buf = [];
      depth = 0;
    }
    buf.push(l);
    depth += (l.match(/[{[]/g) ?? []).length - (l.match(/[}\]]/g) ?? []).length;
    if (depth <= 0) {
      entries.set(key, buf.join("\n"));
      key = "";
    }
  }
}
const PACKAGE_KEYS = new Set(["edition", "license", "repository", "version", "authors", "homepage", "rust-version", "publish", "readme", "description", "keywords", "categories", "documentation"]);
const used = new Set<string>();
for (const m of members) {
  const s = readFileSync(join(here, m, "Cargo.toml"), "utf8");
  for (const x of s.matchAll(/^([\w-]+)\s*(?:\.workspace\s*=\s*true|=\s*\{[^}\n]*workspace\s*=\s*true)/gm))
    if (!PACKAGE_KEYS.has(x[1]!)) used.add(x[1]!);
}
// A workspace dependency may itself be a path dependency on an extracted crate: its entry is kept only when the target exists.
const deps = [...used].sort().flatMap((n) => {
  const e = entries.get(n);
  if (!e) return [];
  const p = e.match(/path\s*=\s*"([^"]+)"/)?.[1];
  return !p || existsSync(join(here, p.replace(/^\.\//, ""), "Cargo.toml")) ? [e] : [];
});
const missing = [...used].filter((n) => !entries.has(n));
const lints = (name: string) => `[workspace.lints.${name}]\n${section(`workspace.lints.${name}`).join("\n").trimEnd()}\n`;
const pkg = parsed.workspace.package;
const cargo = `# Generated by tools/extract.ts from ${cfg.source.repo}@${rev.slice(0, 12)}; edit extract.toml, not this file.
[workspace]
resolver = "3"
members = [
${members.map((m) => `  "${m}",`).join("\n")}
]
exclude = [
${standalone.map((m) => `  "${m}",`).join("\n")}
]

[workspace.package]
${Object.entries({ ...pkg, authors: ["aphrody-dev"], repository: cfg["package-json"].repository, homepage: cfg["package-json"].repository }).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n")}

[workspace.dependencies]
${deps.join("\n")}

${lints("rust")}
${lints("clippy")}
[profile.dev]
opt-level = 0
debug = "line-tables-only"
incremental = true

[profile.dev.package."*"]
opt-level = 1
debug = false

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
strip = "symbols"
`;
writeFileSync(join(here, "Cargo.toml"), cargo);

// 7. Root config files taken from legacy as they are.
for (const f of ["bunfig.toml", ".gitattributes", "DEPS.rules"]) {
  try {
    writeFileSync(join(here, f), await sh(legacy, "git", "show", `${rev}:${f}`));
  } catch {
    // absent at that rev
  }
}

writeFileSync(
  lockPath,
  `${JSON.stringify({ source: cfg.source.repo, rev, roots: top, units, members, standalone, rustWorkspaceDepsMissing: missing }, null, 2)}\n`,
);
console.log(`extracted ${units.length} units (${tsUnits.length} TypeScript, ${members.length} Rust workspace members, ${standalone.length} standalone crates) at ${rev.slice(0, 9)}`);
if (missing.length) console.warn(`workspace dependencies without a legacy entry: ${missing.join(", ")}`);
mkdirSync(join(here, "docs"), { recursive: true });
