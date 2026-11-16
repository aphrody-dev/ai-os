#!/usr/bin/env bun
/**
 * Deterministic npm (@aphrody/*, @yolo-rs/*) and crates.io (aphrody-*, yolo-*)
 * hygiene & deprecation script.
 *
 * Usage:
 *   bun run system/env-kit/scripts/registry-cleanup.ts --dry-run   # Default safe preview
 *   bun run system/env-kit/scripts/registry-cleanup.ts --execute   # Requires fresh NPM_TOKEN / CARGO_REGISTRY_TOKEN
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMonorepoEnv } from "../src/index";

loadMonorepoEnv();

const execute = process.argv.includes("--execute");

const REPORTS = join(import.meta.dir, "..", "..", "..", "var", "reports");
const NPM_REPORT = join(REPORTS, "npm-inventory.json");
const CRATES_REPORT = join(REPORTS, "crates-inventory.json");

const CANONICAL_NPM_KEEP = new Set([
  "@aphrody/ai-os",
  "@aphrody/ai-triad",
  "@aphrody/brain",
  "@aphrody/browser-engines",
  "@aphrody/crawl",
  "@aphrody/core",
  "@aphrody/deploy",
  "@aphrody/design",
  "@aphrody/env-kit",
  "@aphrody/ffi-bridge",
  "@aphrody/gaming",
  "@aphrody/machine",
  "@aphrody/release",
  "@aphrody/shell-matrix",
  "@aphrody/upstream",
  "@aphrody/vault",
  "@aphrody/wck",
]);

const CANONICAL_CRATES_KEEP = new Set([
  "aphrody-env",
  "aphrody-core",
  "aphrody-host",
  "aphrody-wasm",
  "aphrody-android",
  "xtk",
  "depot-cli",
  "depot-core",
  "depot-graph",
  "depot-ingest",
  "ring3-agent",
  "rust-stack",
  "gamescope-cli",
  "gamescope-core",
  "gamescope-wgsl",
  "unix-distro",
  "stack-bench",
]);

function isStubNpmPackage(name: string, description = ""): boolean {
  if (CANONICAL_NPM_KEEP.has(name)) return false;
  if (name.startsWith("@yolo-rs/")) return true;
  if (name.startsWith("@aphrody/bun-windows-api-ms-win-")) return true;
  if (name.startsWith("@aphrody/bun-windows-ext-ms-win-")) return true;
  if (/placeholder|stub|reserved|empty/i.test(description)) return true;
  return false;
}

function isStubCrate(
  name: string,
  maxVersionSize = 0,
  description = "",
): boolean {
  if (CANONICAL_CRATES_KEEP.has(name)) return false;
  if (name.startsWith("yolo-")) return true;
  if (maxVersionSize > 0 && maxVersionSize < 4096) return true;
  if (/placeholder|stub|reserved|empty/i.test(description)) return true;
  return false;
}

async function main() {
  console.log(`[registry-cleanup] mode=${execute ? "EXECUTE" : "DRY-RUN"}`);

  if (existsSync(NPM_REPORT)) {
    const raw = JSON.parse(readFileSync(NPM_REPORT, "utf8"));
    const items: Array<{
      name: string;
      version: string;
      description?: string;
    }> = Array.isArray(raw)
      ? raw
      : (raw.packages ?? raw.objects?.map((o: any) => o.package) ?? []);
    const deprecateList = items.filter((p) =>
      isStubNpmPackage(p.name, p.description),
    );
    console.log(
      `[npm] audited=${items.length} | canonical_keep=${CANONICAL_NPM_KEEP.size} | deprecate_candidates=${deprecateList.length}`,
    );

    if (execute) {
      for (const pkg of deprecateList) {
        const proc = Bun.spawnSync([
          "npm",
          "deprecate",
          `${pkg.name}@*`,
          "Consolidated into @aphrody/* monorepo packages (https://aphrody.com).",
        ]);
        console.log(`[npm deprecate] ${pkg.name} -> exit=${proc.exitCode}`);
      }
    } else {
      for (const pkg of deprecateList.slice(0, 12)) {
        console.log(
          `  [dry-run] npm deprecate "${pkg.name}@*" "Consolidated into @aphrody/*"`,
        );
      }
      if (deprecateList.length > 12) {
        console.log(
          `  ... and ${deprecateList.length - 12} additional stub packages`,
        );
      }
    }
  }

  if (existsSync(CRATES_REPORT)) {
    const raw = JSON.parse(readFileSync(CRATES_REPORT, "utf8"));
    const crates: Array<{
      name: string;
      max_version?: string;
      newest_version?: string;
      description?: string;
      size?: number;
    }> = Array.isArray(raw) ? raw : (raw.crates ?? []);
    const yankList = crates.filter((c) =>
      isStubCrate(c.name, c.size ?? 0, c.description ?? ""),
    );
    console.log(
      `[crates.io] audited=${crates.length} | canonical_keep=${CANONICAL_CRATES_KEEP.size} | yank_candidates=${yankList.length}`,
    );

    if (execute) {
      for (const c of yankList) {
        const ver = c.max_version ?? c.newest_version ?? "0.1.0";
        const proc = Bun.spawnSync(["cargo", "yank", "--version", ver, c.name]);
        console.log(`[cargo yank] ${c.name}@${ver} -> exit=${proc.exitCode}`);
      }
    } else {
      for (const c of yankList) {
        const ver = c.max_version ?? c.newest_version ?? "0.1.0";
        console.log(`  [dry-run] cargo yank --version ${ver} ${c.name}`);
      }
    }
  }
}

main();
