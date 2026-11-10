#!/usr/bin/env bun
import { getSovereignEnv } from "./env.ts";
import { runExtraction } from "./extractor.ts";
import {
  getDesktopFfi,
  resolveBrowserCliPath,
  resolveDesktopCliPath,
} from "./ffi/desktop.ts";
import { getCudaFfi, getPolyglotFfi } from "./ffi/polyglot.ts";
import {
  inspectPolyglotEcosystem,
  runPythonPolyglotScan,
} from "./polyglot/index.ts";
import { runMcpStdioServer } from "./protocols/mcp.ts";
import { buildSkillsAndHooksRegistry } from "./protocols/skills.ts";
import { probeLocalProviders } from "./providers/federation.ts";
import { runSentinelSync } from "./sentinel/index.ts";
import { startAiOsServer } from "./server.ts";

function parseFlag(args: string[], flag: string): string | undefined {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith(eqPrefix)) return a.slice(eqPrefix.length);
    if (a === flag && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some((a) => a.startsWith(`${flag}=`));
}

function printUsage(): void {
  console.log(`ai-os v1.0.0 (oven-sh/bun v${Bun.version})
Unified Sovereign AI Control Plane & Real-Time/Nightly Standards Sentinel

Usage:
  ai-os serve [--port 4318] [--host 127.0.0.1]   Start multi-protocol HTTP/SSE control plane
  ai-os mcp-stdio                                Run MCP 2025-03-26 JSON-RPC 2.0 server over stdio
  ai-os extract [--out C:/src/ai-os]             Run 100% exhaustive code & dependency extractor
  ai-os nightly-sync [--apply]                   Probe live upstream standards feeds & write report
  ai-os watch [--interval 3600] [--once] [--apply] Run real-time / periodic sentinel watch loop
  ai-os doctor                                   Verify native binaries, FFI ABI, providers & skills
  ai-os polyglot-doctor [--python] [--full-gpu]  Probe 86 submodules, CUDA sm_89, Astral/PyO3 & Tree-sitter
  ai-os cuda-scan [--full]                       Run bare-metal RTX 4070 sm_89 CUDA 13.4 benchmark
  ai-os version                                  Print version JSON`);
}

async function main(): Promise<void> {
  // Load sovereign .env safely (redacted; never prints secret values)
  getSovereignEnv();

  const argv = process.argv.slice(2);
  const subcommand = argv[0] ?? "serve";

  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printUsage();
    return;
  }

  if (
    subcommand === "--version" ||
    subcommand === "-v" ||
    subcommand === "version"
  ) {
    console.log(
      JSON.stringify({
        name: "ai-os",
        version: "1.0.0",
        bunVersion: Bun.version,
        platform: process.platform,
        arch: process.arch,
      }),
    );
    return;
  }

  if (subcommand === "serve" || subcommand === "start") {
    const portStr = parseFlag(argv, "--port");
    const host = parseFlag(argv, "--host") ?? "127.0.0.1";
    const port = portStr ? Number(portStr) : 4318;
    const server = startAiOsServer({ port, hostname: host });
    console.log(
      JSON.stringify({
        ok: true,
        event: "ai-os.listening",
        url: `http://${server.hostname}:${server.port}`,
        protocols: ["OpenAI", "MCP-2025-03-26", "A2A", "ACP", "Skills-Hooks"],
      }),
    );
    return;
  }

  if (subcommand === "mcp-stdio" || subcommand === "mcp") {
    await runMcpStdioServer();
    return;
  }

  if (subcommand === "extract") {
    const outDir = parseFlag(argv, "--out") ?? "C:/src/ai-os";
    const res = runExtraction({ outDir });
    console.log(
      JSON.stringify(
        {
          ok: true,
          manifestPath: res.manifestPath.replace(/\\/g, "/"),
          matrixPath: res.matrixPath.replace(/\\/g, "/"),
          summary: res.manifest.summary,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "nightly-sync") {
    const apply = hasFlag(argv, "--apply");
    const outDir = parseFlag(argv, "--out") ?? "C:/src/ai-os";
    const state = await runSentinelSync({ outDir, apply });
    console.log(
      JSON.stringify(
        {
          ok: true,
          generatedAt: state.generatedAt,
          liveCount: state.liveCount,
          cachedCount: state.cachedCount,
          offlineCount: state.offlineCount,
          bunParitySummary: state.bunParitySummary,
          appliedUpdates: state.appliedUpdates,
          reportPath: `${outDir.replace(/\\/g, "/")}/SENTINEL_REPORT.md`,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "watch") {
    const apply = hasFlag(argv, "--apply");
    const once = hasFlag(argv, "--once");
    const outDir = parseFlag(argv, "--out") ?? "C:/src/ai-os";
    const intervalSec = Number(parseFlag(argv, "--interval") ?? "3600");

    const tick = async () => {
      const state = await runSentinelSync({ outDir, apply });
      console.log(
        JSON.stringify({
          ok: true,
          event: "sentinel.tick",
          generatedAt: state.generatedAt,
          liveCount: state.liveCount,
          cachedCount: state.cachedCount,
          offlineCount: state.offlineCount,
        }),
      );
    };

    await tick();
    if (once) return;

    setInterval(
      () => {
        void tick();
      },
      Math.max(10, intervalSec) * 1000,
    );
    return;
  }

  if (subcommand === "doctor") {
    const ffi = getDesktopFfi();
    const providers = await probeLocalProviders(500);
    const registry = buildSkillsAndHooksRegistry();
    const status = ffi ? ffi.statusEnvelope() : null;
    console.log(
      JSON.stringify(
        {
          ok: true,
          bunVersion: Bun.version,
          desktopCli: resolveDesktopCliPath(),
          browserCli: resolveBrowserCliPath(),
          desktopFfi: ffi
            ? { dllPath: ffi.dllPath, abiVersion: ffi.abiVersion, status }
            : { loaded: false },
          skillsIndexed: registry.totalSkills,
          hooksIndexed: registry.totalHooks,
          providers: providers.map((p) => ({
            id: p.id,
            kind: p.kind,
            reachable: p.reachable,
            authStatus: p.authStatus,
            latencyMs: p.latencyMs,
          })),
        },
        null,
        2,
      ),
    );
    ffi?.close();
    return;
  }

  if (subcommand === "polyglot-doctor" || subcommand === "polyglot") {
    const includePy = hasFlag(argv, "--python");
    const fullGpu = hasFlag(argv, "--full-gpu");
    const report = inspectPolyglotEcosystem({ quickGpu: !fullGpu });
    const pythonScan = includePy ? await runPythonPolyglotScan() : undefined;
    console.log(JSON.stringify({ ...report, pythonScan }, null, 2));
    getCudaFfi()?.close();
    getPolyglotFfi()?.close();
    return;
  }

  if (subcommand === "cuda-scan") {
    const full = hasFlag(argv, "--full");
    const cuda = getCudaFfi();
    if (!cuda) {
      console.error(
        JSON.stringify({ ok: false, error: "sovereign_cuda_sm89.dll missing" }),
      );
      process.exitCode = 1;
      return;
    }
    const telemetry = cuda.scanAndBench(!full);
    console.log(JSON.stringify(telemetry, null, 2));
    cuda.close();
    return;
  }

  printUsage();
  process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
