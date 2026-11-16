#!/usr/bin/env bun
import { existsSync } from "node:fs";
import {
  diagnoseGoogleAuth,
  getSovereignEnv,
  installSkillCollection,
  listActiveCollections,
  removeSkillCollection,
} from "../../../src/index.ts";
import {
  buildGitingestDigest,
  generateGclientDepotManifest,
  GOOGLE_AI_ECOSYSTEM_SURFACES,
  loadGoogleOrgsCatalog,
  refreshGoogleOrgsKeyless,
  syncDepotRepoKeyless,
} from "./depot-orgs.ts";
import {
  discoverLocalGgufModels,
  GEMMA_4_MODEL_CATALOG,
  generateGemma4TrainingPipeline,
  type GemmaTrainingStyle,
  runGemma4KeylessInference,
  selectOptimalGemma4Model,
} from "./gemma4-lab.ts";
import {
  generateFullstackCloudflareVercelConfig,
  readCurrentAgyMode,
  resetToMinimalOsBaseline,
  runAutonomousGoalLoop,
  runHumanizerAndImpeccableAudit,
  switchAgyMode,
} from "./modes-and-collections.ts";
import {
  askOpenNotebookLm,
  generateDeepMindResearchNotebook,
  generateNotebookLmAudioOverview,
  ingestNotebookLmSource,
} from "./notebook-engine.ts";
import {
  calculateContextOptimizationSavings,
  computeSubscriptionRentabilisation,
  recordSubscriptionUsage,
} from "./ultra-finops.ts";
import { startAgyWebServer } from "./web-app.ts";

function parseFlag(args: string[], flag: string): string | undefined {
  const eq = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith(eq)) return a.slice(eq.length);
    if (a === flag && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag) || args.some((a) => a.startsWith(`${flag}=`));
}

function printHelp(): void {
  console.log(`agy-studio v2.0.0 (@aphrody/agy on Bun v${Bun.version})
Local-First Keyless Google AI Ecosystem Hub (backed by sole AI owner @aphrody/ai-os)

Usage:
  agy depot <list|refresh|gclient|sync> [org/repo]   Keyless 5-org Google repo depot (antigravity, gemini, deepmind, labs, google)
  agy ingest <path>                                  Build deterministic Gitingest LLM Markdown digest
  agy gemma <list|fit|train|ask> [--style jax-tunix|cuda-sm89|pytorch-heretic]
  agy notebook <topic>                               Generate DeepMind Research-in-a-Notebook (.ipynb + .md)
  agy notebooklm <ingest|ask|audio> [--id nb1]       Open NotebookLM local engine with [Source N] citations & audio script
  agy ultra <status|record|context>                  Google AI Ultra benefits, pricing, context savings & ROI rentabilisation
  agy collections <list|install|remove|reset-minimal> [id]  One-click Google/Pro-Max skill & MCP collections (default: os-minimal)
  agy mode <status|minimal|fullstack|humanize>       Switch between minimal pi-sudo (24/7 CU) & fullstack pro-max modes
  agy goal-loop <dir> [--infinite]                   Autonomous /goal fullstack Bun+Rust build & quality loop
  agy web [--port 4325]                              Launch local Google AI Studio & Gemini Web App
  agy desktop [--doctor]                             Launch native Rust desktop app (agy-desktop.exe)
  agy doctor                                         Full ecosystem & keyless auth diagnostic`);
}

export async function runAgyCli(argv = process.argv.slice(2)): Promise<void> {
  getSovereignEnv();
  const cmd = argv[0] ?? "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "depot") {
    const sub = argv[1] ?? "list";
    if (sub === "refresh") {
      console.log(JSON.stringify(await refreshGoogleOrgsKeyless(), null, 2));
      return;
    }
    if (sub === "gclient") {
      console.log(JSON.stringify(generateGclientDepotManifest(), null, 2));
      return;
    }
    if (sub === "sync") {
      const target = argv[2] ?? "google-gemini/gemini-skills";
      console.log(JSON.stringify(syncDepotRepoKeyless(target), null, 2));
      return;
    }
    const catalog = loadGoogleOrgsCatalog();
    const counts = Object.fromEntries(
      Object.entries(catalog).map(([k, v]) => [k, v.length]),
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          keyless: true,
          orgCounts: counts,
          surfaces: GOOGLE_AI_ECOSYSTEM_SURFACES,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "ingest") {
    const target = argv[1] ?? "C:/aphrody/frameworks/ai-os/engines/agy";
    const res = buildGitingestDigest(target, {
      preferExternalBinary: hasFlag(argv, "--external"),
    });
    console.log(
      JSON.stringify(
        {
          ok: res.ok,
          digestPath: res.digestPath,
          filesIncluded: res.filesIncluded,
          estimatedTokens: res.estimatedTokens,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "gemma") {
    const sub = argv[1] ?? "list";
    if (sub === "fit") {
      const vram = Number(parseFlag(argv, "--vram") ?? "11500");
      console.log(
        JSON.stringify(
          selectOptimalGemma4Model({
            availableVramMb: vram,
            requireUncensored: hasFlag(argv, "--uncensored"),
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (sub === "train") {
      const style = (parseFlag(argv, "--style") ??
        "jax-tunix") as GemmaTrainingStyle;
      console.log(
        JSON.stringify(generateGemma4TrainingPipeline(style), null, 2),
      );
      return;
    }
    if (sub === "ask") {
      const prompt = argv.slice(2).join(" ") || "Explain Gemma 4 RMSNorm.";
      console.log(
        JSON.stringify(
          await runGemma4KeylessInference({
            prompt,
            enableThinking: hasFlag(argv, "--think"),
          }),
          null,
          2,
        ),
      );
      return;
    }
    console.log(
      JSON.stringify(
        {
          catalog: GEMMA_4_MODEL_CATALOG,
          localGgufFiles: discoverLocalGgufModels(),
          recommendedRtx4070Fit: selectOptimalGemma4Model(),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "notebook") {
    const topic = argv.slice(1).join(" ") || "Gemma 4 CUDA sm_89 Scaling";
    const res = generateDeepMindResearchNotebook({ topic });
    console.log(
      JSON.stringify(
        {
          ok: true,
          notebookPath: res.notebookPath,
          markdownExportPath: res.markdownExportPath,
          cellCount: res.cellCount,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "notebooklm") {
    const sub = argv[1] ?? "ask";
    const notebookId = parseFlag(argv, "--id") ?? "default";
    if (sub === "ingest") {
      const target = argv[2] ?? "C:/aphrody/AGENTS.md";
      const title = parseFlag(argv, "--title") ?? target;
      console.log(
        JSON.stringify(
          ingestNotebookLmSource({ notebookId, title, textOrPath: target }),
          null,
          2,
        ),
      );
      return;
    }
    if (sub === "audio") {
      const topic = parseFlag(argv, "--topic") ?? notebookId;
      console.log(
        JSON.stringify(
          generateNotebookLmAudioOverview({ notebookId, topic }),
          null,
          2,
        ),
      );
      return;
    }
    const question =
      argv
        .slice(2)
        .filter((x) => !x.startsWith("--"))
        .join(" ") || "Summarize the core architecture.";
    console.log(
      JSON.stringify(
        await askOpenNotebookLm({ notebookId, question }),
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "ultra") {
    const sub = argv[1] ?? "status";
    if (sub === "context") {
      console.log(
        JSON.stringify(calculateContextOptimizationSavings(), null, 2),
      );
      return;
    }
    if (sub === "record") {
      const modelId = parseFlag(argv, "--model") ?? "gemini-3.1-pro";
      const inputTokens = Number(parseFlag(argv, "--in") ?? "100000");
      const outputTokens = Number(parseFlag(argv, "--out") ?? "8000");
      const credits = Number(parseFlag(argv, "--credits") ?? "0");
      console.log(
        JSON.stringify(
          recordSubscriptionUsage({
            surface: parseFlag(argv, "--surface") ?? "agy-cli",
            modelId,
            inputTokens,
            outputTokens,
            aiCreditsUsed: credits,
          }),
          null,
          2,
        ),
      );
      return;
    }
    console.log(JSON.stringify(computeSubscriptionRentabilisation(), null, 2));
    return;
  }

  if (cmd === "collections") {
    const sub = argv[1] ?? "list";
    const id = argv[2] ?? "os-minimal";
    if (sub === "install") {
      console.log(JSON.stringify(installSkillCollection(id), null, 2));
      return;
    }
    if (sub === "remove") {
      console.log(JSON.stringify(removeSkillCollection(id), null, 2));
      return;
    }
    if (sub === "reset-minimal") {
      console.log(JSON.stringify(resetToMinimalOsBaseline(), null, 2));
      return;
    }
    console.log(JSON.stringify(listActiveCollections(), null, 2));
    return;
  }

  if (cmd === "mode") {
    const sub = argv[1] ?? "status";
    if (sub === "minimal" || sub === "fullstack") {
      const domainFocus = parseFlag(argv, "--domain");
      const syncHarnesses = hasFlag(argv, "--sync");
      console.log(
        JSON.stringify(
          switchAgyMode(sub, { domainFocus, syncHarnesses }),
          null,
          2,
        ),
      );
      return;
    }
    if (sub === "humanize") {
      const text = argv.slice(2).join(" ");
      console.log(
        JSON.stringify(runHumanizerAndImpeccableAudit(text), null, 2),
      );
      return;
    }
    if (sub === "scaffold") {
      const dir = argv[2] ?? "C:/aphrody/var/agy-scaffold-demo";
      console.log(
        JSON.stringify(generateFullstackCloudflareVercelConfig(dir), null, 2),
      );
      return;
    }
    console.log(JSON.stringify(readCurrentAgyMode(), null, 2));
    return;
  }

  if (cmd === "goal-loop") {
    const targetDir = argv[1] ?? process.cwd();
    const goalDescription =
      parseFlag(argv, "--goal") ?? "Fullstack Bun + Rust verification loop";
    const res = await runAutonomousGoalLoop({
      targetDir,
      goalDescription,
      infiniteUntilPass: hasFlag(argv, "--infinite"),
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === "web") {
    const port = Number(parseFlag(argv, "--port") ?? "4325");
    const server = startAgyWebServer({ port });
    console.log(
      JSON.stringify({
        ok: true,
        event: "agy.web.listening",
        url: `http://${server.hostname}:${server.port}`,
      }),
    );
    return;
  }

  if (cmd === "desktop") {
    const binPath = "%USERPROFILE%/.local/bin/agy-desktop.exe";
    if (!existsSync(binPath)) {
      console.error(
        JSON.stringify({ ok: false, error: `${binPath} not built yet` }),
      );
      process.exitCode = 1;
      return;
    }
    const subArgs = hasFlag(argv, "--doctor") ? ["doctor"] : argv.slice(1);
    const proc = Bun.spawnSync([binPath, ...subArgs], {
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = proc.exitCode;
    return;
  }

  if (cmd === "doctor") {
    const auth = await diagnoseGoogleAuth();
    const mode = readCurrentAgyMode();
    const gemmaFit = selectOptimalGemma4Model();
    const finops = computeSubscriptionRentabilisation();
    console.log(
      JSON.stringify(
        {
          ok: true,
          package: "@aphrody/agy",
          aiOwner: "@aphrody/ai-os",
          desktopBinaryPresent: existsSync(
            "%USERPROFILE%/.local/bin/agy-desktop.exe",
          ),
          auth,
          mode: {
            current: mode.mode,
            toolsCount: mode.activeTools.length,
            collections: mode.activeCollections,
          },
          gemma4Recommended: gemmaFit.model.id,
          ultraRentabilisationPct: finops.rentabilisationPct,
        },
        null,
        2,
      ),
    );
    return;
  }

  printHelp();
  process.exitCode = 1;
}

if (import.meta.main) {
  await runAgyCli();
}
