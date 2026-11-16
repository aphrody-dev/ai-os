#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  callLocalUncensoredModel,
  generateHereticConfigToml,
  LOCALLY_UNCENSORED_CATALOG,
  probeActiveLocalEngines,
  selectModelsForVram,
} from "./lu-provider.ts";
import {
  getCpuThreads,
  isNativeRustLoaded,
  snapshotWorkspace,
} from "./native-bridge.ts";
import {
  renderOpenTuiFrame,
  SessionStore,
  startOpenCodeServer,
} from "./opencode-ui.ts";
import {
  parseWorkflowMarkdown,
  type PrdTaskItem,
  runAutonomousNhitlLoop,
} from "./nhitl-loop.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sub = args[0] ?? "tui";
  const cwd = resolve(process.cwd());

  if (sub === "tui" || sub === "status") {
    const snap = snapshotWorkspace(cwd);
    const store = new SessionStore();
    console.log(
      renderOpenTuiFrame({
        workspace: cwd,
        activeModel: LOCALLY_UNCENSORED_CATALOG[0].id,
        mode: "autonomous-nhitl",
        merkleHash: snap.merkleHash,
        fileCount: snap.fileCount,
        sessions: store.listSessions().length,
      }),
    );
    store.close();
    return;
  }

  if (sub === "models") {
    const vram = Number(args[1] ?? "12");
    const fitting = selectModelsForVram(vram);
    const engines = await probeActiveLocalEngines(300);
    console.log(
      `Uncensored Open-Weights Models fitting <= ${vram} GB VRAM (RTX 4070 sm_89):`,
    );
    for (const m of fitting) {
      console.log(
        `  - ${m.id.padEnd(30)} | ${m.quantization.padEnd(6)} | ${String(m.vramGb).padStart(4)} GB | ${m.abliterationMethod} | ${m.huggingfaceRepo}`,
      );
    }
    console.log("\nLocal Inference Engine Probe:");
    for (const e of engines) {
      console.log(
        `  - ${e.endpoint.name.padEnd(20)} (${e.endpoint.baseUrl}) -> ${e.healthy ? "ONLINE" : "offline"} (${e.latencyMs}ms)`,
      );
    }
    return;
  }

  if (sub === "heretic-init") {
    const modelRepo = args[1] ?? "Qwen/Qwen3.8-14B-Instruct";
    const outPath = resolve(cwd, "heretic.config.toml");
    writeFileSync(
      outPath,
      generateHereticConfigToml({ modelRepo, mode: "uncensor", bnb4bit: true }),
      "utf8",
    );
    console.log(`Wrote Heretic v2 refusal-suppression config to ${outPath}`);
    return;
  }

  if (sub === "serve") {
    const port = Number(args[1] ?? "4096");
    const dbPath = join(cwd, ".pi-opencode", "sessions.sqlite");
    const store = new SessionStore(dbPath);
    const { server } = startOpenCodeServer({ port, workspace: cwd, store });
    console.log(
      `pi-opencode server listening on http://127.0.0.1:${server.port} (workspace=${cwd})`,
    );
    return;
  }

  if (sub === "nhitl" || sub === "loop") {
    const workflowPath = resolve(cwd, "WORKFLOW.md");
    const prdPath = resolve(cwd, "prd.json");
    const workflow = existsSync(workflowPath)
      ? parseWorkflowMarkdown(readFileSync(workflowPath, "utf8"))
      : parseWorkflowMarkdown(
          "---\nname: auto-nhitl\nmaxIterations: 5\ndefaultAcceptanceCommand: bun test\n---\nComplete each task using read, write, edit, bash until tests pass.",
        );
    const tasks: PrdTaskItem[] = existsSync(prdPath)
      ? (JSON.parse(readFileSync(prdPath, "utf8")) as PrdTaskItem[])
      : [];

    const baseUrl = process.env.PI_LU_BASE_URL ?? "http://127.0.0.1:8129/v1";
    const model = process.env.PI_LU_MODEL ?? LOCALLY_UNCENSORED_CATALOG[0].id;
    const apiKey = process.env.PI_LU_API_KEY;

    console.log(
      `Starting NHITL Autonomous Loop (${workflow.name}) | tasks=${tasks.length} | model=${model} | rust_ffi=${isNativeRustLoaded()} | threads=${getCpuThreads()}`,
    );

    const outcomes = await runAutonomousNhitlLoop({
      workspaceDir: cwd,
      tasks,
      workflow,
      callModel: (msgs, tools) =>
        callLocalUncensoredModel({ baseUrl, model, apiKey }, msgs, tools),
    });

    for (const o of outcomes) {
      console.log(
        `  [${o.passed ? "PASS" : "FAIL"}] ${o.taskId} in ${o.iterationsUsed} iter(s) (merkle ${o.beforeSnapshot.merkleHash} -> ${o.afterSnapshot.merkleHash})`,
      );
    }
    return;
  }

  console.log(
    [
      "pi-opencode v1.0.0 — Pi Minimalist Core + OpenCode Bun/Rust UI + Locally Uncensored + Symphony/Ralph NHITL",
      "Commands:",
      "  pi-opencode tui                  Render OpenTUI workspace & snapshot status",
      "  pi-opencode models [vramGb]      List Locally Uncensored + Heretic models & probe local engines",
      "  pi-opencode heretic-init [repo]  Generate p-e-w/heretic v2 4-bit refusal-suppression config",
      "  pi-opencode serve [port]         Start OpenCode Bun HTTP + SQLite WAL UI/API server",
      "  pi-opencode nhitl                 Run full NHITL WORKFLOW.md + prd.json autonomous loop",
    ].join("\n"),
  );
}

if (import.meta.main) {
  await main();
}
