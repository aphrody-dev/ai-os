#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanLegacyPatterns } from "./legacy-scan";
import { mwgCapabilities, mwgParseMdx } from "./mwg-ffi";
import {
  listUseCases,
  lookupBaselineStatus,
  retrieveUseCase,
} from "./rag/guides";
import {
  FeatureGateError,
  normalizeBaselineTarget,
  writeMwgrc,
} from "./rag/mwgrc";
import { searchUseCases } from "./rag/search";
import type { SpecId } from "./types";
import { formatReport, validateWeb } from "./validator";

function printHelp(): void {
  console.log(`
wck: Compile-Time Web & Modern Web Guidance Validator (Pure Bun + C23 LLVM)

Usage:
  wck [<path>] [options]
  wck search <query>
  wck retrieve <id[,id2,...]>
  wck list [category]
  wck baselinestatus <query> [--json]
  wck legacy-scan [<path>] [--json] [--guide=<id>] [--include-docs-and-tests]
  wck mdx <file>
  wck set-allow-origin-trials
  wck set-allow-volatile-features
  wck set-baseline <widely|newly|limited|YYYY>

Options:
  --json             Output full report in structured JSON format
  --quiet            Print summary line only
  --spec=<name>      Run only specific spec (seo, aiseo, mwg, cwv, lh, wasm, webgpu)
  -h, --help         Display this help message
  -v, --version      Display version and native C23 ABI status
`);
}

const args: string[] = process.argv.slice(2);
const subcmd = args[0];

async function runCli(): Promise<number> {
  if (subcmd === "-h" || subcmd === "--help" || subcmd === "help") {
    printHelp();
    return 0;
  }

  if (subcmd === "-v" || subcmd === "--version" || subcmd === "version") {
    const caps = mwgCapabilities();
    console.log(
      `wck v1.0.0 (Pure Bun + ${caps.engine} ABI v${caps.abi}${caps.native ? "" : " fallback"})`,
    );
    return 0;
  }

  if (subcmd === "search") {
    const query = args
      .slice(1)
      .filter((a) => !a.startsWith("-"))
      .join(" ");
    if (!query) {
      console.error("Usage: wck search <query>");
      return 1;
    }
    const results = await searchUseCases(query);
    console.log(
      JSON.stringify(
        results.map(({ id, description, category, similarity }) => ({
          id,
          description,
          category,
          similarity,
        })),
        null,
        2,
      ),
    );
    return 0;
  }

  if (subcmd === "retrieve") {
    const rawIds = args
      .slice(1)
      .filter((a) => !a.startsWith("-"))
      .join(",");
    const ids = rawIds
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      console.error("Usage: wck retrieve <id[,id2,...]>");
      return 1;
    }
    const outputs: string[] = [];
    for (const id of ids) {
      try {
        outputs.push(await retrieveUseCase(id));
      } catch (err) {
        if (err instanceof FeatureGateError) {
          console.error(err.message);
          return 1;
        }
        throw err;
      }
    }
    console.log(outputs.join("\n\n---\n\n"));
    return 0;
  }

  if (subcmd === "list") {
    const category = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    const jsonMode = args.includes("--json");
    const items = listUseCases(category);
    if (jsonMode) {
      console.log(
        JSON.stringify(
          items.map(({ id, category: cat, description }) => ({
            id,
            category: cat,
            description,
          })),
          null,
          2,
        ),
      );
    } else {
      for (const item of items) {
        console.log(`${item.category}/${item.id}: ${item.description}`);
      }
    }
    return 0;
  }

  if (subcmd === "baselinestatus") {
    const jsonMode = args.includes("--json");
    const query = args
      .slice(1)
      .filter((a) => !a.startsWith("-"))
      .join(" ");
    if (!query) {
      console.error("Usage: wck baselinestatus <query> [--json]");
      return 1;
    }
    const rows = lookupBaselineStatus(query);
    if (jsonMode) {
      console.log(JSON.stringify(rows, null, 2));
    } else if (rows.length === 0) {
      console.log(`No features found matching "${query}".`);
    } else {
      for (const r of rows) {
        console.log(
          `${r.featureId} [${r.baseline}] (${r.category}): ${r.name}`,
        );
      }
    }
    return 0;
  }

  if (subcmd === "legacy-scan" || subcmd === "analyze") {
    const jsonMode = args.includes("--json");
    const includeDocsAndTests = args.includes("--include-docs-and-tests");
    let guide: string | undefined;
    let target = ".";
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("--guide=")) guide = a.slice(8);
      else if (a === "--guide" && args[i + 1]) guide = args[++i];
      else if (!a.startsWith("-")) target = a;
    }
    const report = scanLegacyPatterns(target, { guide, includeDocsAndTests });
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `Scanned ${report.scannedFiles} files: ${report.totalFindings} legacy findings`,
      );
      for (const f of report.findings.slice(0, 50)) {
        console.log(`  ${f.file}:${f.line} [${f.guideId}] ${f.message}`);
      }
    }
    return 0;
  }

  if (subcmd === "mdx") {
    const file = args[1];
    if (!file) {
      console.error("Usage: wck mdx <file>");
      return 1;
    }
    const content = readFileSync(resolve(process.cwd(), file), "utf8");
    console.log(JSON.stringify(mwgParseMdx(content), null, 2));
    return 0;
  }

  if (subcmd === "set-allow-origin-trials") {
    const path = writeMwgrc({ allowOriginTrials: true });
    console.log(`Updated ${path}: allowOriginTrials = true`);
    return 0;
  }

  if (subcmd === "set-allow-volatile-features") {
    const path = writeMwgrc({ allowVolatileFeatures: true });
    console.log(`Updated ${path}: allowVolatileFeatures = true`);
    return 0;
  }

  if (subcmd === "set-baseline") {
    const target = normalizeBaselineTarget(args[1]);
    if (!target) {
      console.error("Usage: wck set-baseline <widely|newly|limited|YYYY>");
      return 1;
    }
    const path = writeMwgrc({ baseline: target });
    console.log(`Updated ${path}: baseline = ${target}`);
    return 0;
  }

  // Default: compile-time web validator
  let targetPath = ".";
  let jsonOutput = false;
  let quietOutput = false;
  let specFilter: SpecId | "all" = "all";

  for (const arg of args) {
    if (arg === "--json") jsonOutput = true;
    else if (arg === "--quiet") quietOutput = true;
    else if (arg.startsWith("--spec="))
      specFilter = arg.split("=")[1] as SpecId;
    else if (!arg.startsWith("-")) targetPath = arg;
  }

  const resolved = resolve(process.cwd(), targetPath);
  const report = validateWeb(resolved, {
    json: jsonOutput,
    quiet: quietOutput,
    specFilter,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else if (quietOutput) {
    console.log(report.summary);
  } else {
    console.log(formatReport(report));
  }

  return report.allPassed ? 0 : 1;
}

try {
  process.exitCode = await runCli();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`wck execution error: ${msg}`);
  process.exitCode = 1;
}
