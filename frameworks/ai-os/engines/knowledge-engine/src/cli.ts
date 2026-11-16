#!/usr/bin/env bun
import { getLibraryDocs, searchLibraries } from "./context7/client.ts";
import { redactSecretsFromText } from "./env/safe-env.ts";
import {
  formatFactCheckReportMarkdown,
  runFactCheck,
} from "./factcheck/verifier.ts";
import { generateMonorepoDocs } from "./generators/docs-gen.ts";
import { syncKernelStoryMdx } from "./generators/kernel-crawler.ts";
import { generateWorkspaceSkills } from "./generators/skills-gen.ts";
import { getKnowledgeEngineStatus, runKnowledgeMcpStdio } from "./mcp/stdio.ts";
import { runDeepResearch } from "./research/deep-research.ts";
import {
  auditAllAgySessions,
  runContinuousWatchLoop,
} from "./reviewer/agy-session-auditor.ts";

const HELP_TEXT = `Sovereign Knowledge Engine CLI (@aphrody/knowledge-engine v1.0.0)
Unified Context7 v2 + 5-Channel Deep Research + Deterministic Fact-Checker + Monorepo Docs & Skills Generator + Continuous AGY Session Reviewer.

Usage:
  ske <command> [options]

Commands:
  research <query> [--no-save]          Run 5-channel parallel Deep Research and write C:\\aphrody\\docs\\research\\<slug>.md
  factcheck <claim-or-file> [--json]    Verify paths, binaries, versions, repos, Context7 symbols, secrets & System32 safety
  ctx7 <library> [query] [--tokens N]   Resolve library via Context7 v2 + SQLite WAL Blake3 cache and fetch official docs
  gen-docs [--offline]                  Generate C:\\aphrody\\docs\\MONOREPO_ATLAS.md and third_party/bun/docs/sovereign/index.mdx
  gen-skills                            Synthesize and validate the 5 sovereign workspace SKILL.md definitions
  review-sessions [--json] [--limit N]  Incrementally audit all AGY brain transcripts (< 30ms cached) -> AGY_SESSIONS_CONTINUOUS_REVIEW.md
  watch [--interval 30] [--once]        Continuous reviewer loop over active transcripts, docs/*.md, and SKILL.md
  mcp-stdio                             Run MCP 2025-03-26 JSON-RPC 2.0 server over stdio
  status | doctor                       Show SQLite WAL table metrics, rust_stack_ffi.dll Blake3 status, and masked API readiness
  help | --help                         Show this usage reference
`;

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const cur = args[i]!;
    if (cur.startsWith("--")) {
      if (
        (cur === "--interval" ||
          cur === "--limit" ||
          cur === "--tokens" ||
          cur === "--session") &&
        i + 1 < args.length
      ) {
        i++;
      }
      continue;
    }
    out.push(cur);
  }
  return out;
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0] ?? "help";
  const rest = argv.slice(1);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`ske 1.0.0 (Bun v${Bun.version})\n`);
    return 0;
  }

  if (cmd === "mcp-stdio") {
    await runKnowledgeMcpStdio();
    return 0;
  }

  if (cmd === "status" || cmd === "doctor") {
    const status = getKnowledgeEngineStatus();
    process.stdout.write(
      `${redactSecretsFromText(JSON.stringify(status, null, 2))}\n`,
    );
    return 0;
  }

  if (cmd === "ctx7") {
    const pos = positionalArgs(rest);
    const libName = pos[0] ?? "";
    const query = pos.slice(1).join(" ").trim() || libName;
    if (!libName) {
      process.stderr.write("Usage: ske ctx7 <library> [query] [--tokens N]\n");
      return 1;
    }
    const tokensStr = parseFlagValue(rest, "--tokens");
    const tokens = tokensStr ? Number.parseInt(tokensStr, 10) : 3500;
    const libId = libName.startsWith("/")
      ? libName
      : (await searchLibraries(libName, query)).results[0]?.id;
    if (!libId) {
      process.stderr.write(`No Context7 library resolved for "${libName}".\n`);
      return 1;
    }
    const docs = await getLibraryDocs(libId, query, tokens);
    process.stdout.write(
      `[ske:ctx7] libraryId=${docs.libraryId} cached=${docs.cached} chunks=${docs.chunks.length}\n\n${docs.rawText.slice(0, 4000)}\n`,
    );
    return 0;
  }

  if (cmd === "research") {
    const query = positionalArgs(rest).join(" ").trim();
    if (!query) {
      process.stderr.write("Usage: ske research <query> [--no-save]\n");
      return 1;
    }
    const saveReport = !rest.includes("--no-save");
    const res = await runDeepResearch(query, { saveReport });
    process.stdout.write(
      `[ske:research] slug=${res.slug} evidence=${res.evidence.length} latency=${res.durationMs.toFixed(1)}ms saved=${res.savedPath ?? "memory"}\n`,
    );
    for (const [ch, st] of Object.entries(res.channelStatuses)) {
      process.stdout.write(`  channel ${ch.padEnd(28)}: ${st}\n`);
    }
    return 0;
  }

  if (cmd === "factcheck") {
    const target = positionalArgs(rest).join(" ").trim();
    if (!target) {
      process.stderr.write("Usage: ske factcheck <claim-or-file> [--json]\n");
      return 1;
    }
    const verdict = await runFactCheck(target, {
      skipNetwork: rest.includes("--offline"),
    });
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatFactCheckReportMarkdown(verdict)}\n`);
    }
    return verdict.verdict === "CONTRADICTED" ? 2 : 0;
  }

  if (cmd === "gen-docs") {
    const report = await generateMonorepoDocs({
      enrichContext7: !rest.includes("--offline"),
    });
    process.stdout.write(
      `[ske:gen-docs] entities=${report.entitiesCount} shims=${report.localBinShimsCount} dlls=${report.ffiDllsCount} latency=${report.durationMs.toFixed(1)}ms\n`,
    );
    process.stdout.write(`  wrote atlas: ${report.atlasPath}\n`);
    process.stdout.write(`  wrote mdx  : ${report.mdxPath}\n`);
    return 0;
  }

  if (cmd === "gen-skills") {
    const report = generateWorkspaceSkills();
    process.stdout.write(
      `[ske:gen-skills] generated ${report.generatedSkills.length} validated SKILL.md definitions in ${report.durationMs.toFixed(1)}ms:\n`,
    );
    for (const sk of report.generatedSkills) {
      process.stdout.write(
        `  ${sk.name.padEnd(28)} discovery=${sk.discoveryTokens}t full=${sk.fullActivationTokens}t savings=${sk.progressiveSavingsPct}% -> ${sk.skillMdPath}\n`,
      );
    }
    return 0;
  }

  if (cmd === "crawl-kernel") {
    const res = await syncKernelStoryMdx({
      offline: rest.includes("--offline"),
    });
    process.stdout.write(
      `[ske:crawl-kernel] latest_stable=${res.latestStable} wrote=${res.targetFile}\n`,
    );
    return 0;
  }

  if (cmd === "review-sessions") {
    const limitStr = parseFlagValue(rest, "--limit");
    const sessionIdFilter = parseFlagValue(rest, "--session");
    const report = auditAllAgySessions({
      limit: limitStr ? Number.parseInt(limitStr, 10) : undefined,
      sessionIdFilter,
    });
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `[ske:review-sessions] sessions=${report.totalSessions} (transcripts=${report.sessionsWithTranscripts}) cached=${report.cacheHits} reindexed=${report.reindexedCount} latency=${report.durationMs.toFixed(2)}ms\n`,
      );
      process.stdout.write(
        `  steps=${report.totals.steps} tools=${report.totals.toolCalls} mcp=${report.totals.mcpCalls} secrets=${report.totals.secretLeaks} sys32=${report.totals.system32Violations}\n`,
      );
      process.stdout.write(`  report: ${report.markdownReportPath}\n`);
      process.stdout.write(`  ledger: ${report.jsonLedgerPath}\n`);
    }
    return 0;
  }

  if (cmd === "watch") {
    const intervalStr = parseFlagValue(rest, "--interval");
    const intervalSeconds = intervalStr ? Number.parseInt(intervalStr, 10) : 30;
    const once = rest.includes("--once");
    const summary = await runContinuousWatchLoop({ intervalSeconds, once });
    process.stdout.write(
      `[ske:watch] initial pass complete in ${summary.durationMs.toFixed(1)}ms (reindexed=${summary.reindexedSessions}, factChecked=${summary.factCheckedFiles.length}, regenAtlas=${summary.regeneratedAtlas})\n`,
    );
    return 0;
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP_TEXT}`);
  return 1;
}

if (import.meta.main) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
