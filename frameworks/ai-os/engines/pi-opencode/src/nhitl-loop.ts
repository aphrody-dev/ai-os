import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { snapshotWorkspace, type WorkspaceDigest } from "./native-bridge.ts";
import { type PiModelCallFn, runPiAgentLoop } from "./pi-core.ts";

export interface PrdTaskItem {
  id: string;
  title: string;
  acceptanceCommand: string;
  completed: boolean;
}

export interface WorkflowSpec {
  name: string;
  maxIterations: number;
  defaultAcceptanceCommand: string;
  autoMergeOnGreen: boolean;
  promptBody: string;
}

/**
 * Parses an OpenAI `Symphony`-compatible `WORKFLOW.md` (YAML-lite frontmatter + prompt body).
 */
export function parseWorkflowMarkdown(markdown: string): WorkflowSpec {
  const defaults: WorkflowSpec = {
    name: "default-nhitl-workflow",
    maxIterations: 10,
    defaultAcceptanceCommand: "bun test",
    autoMergeOnGreen: true,
    promptBody: markdown.trim(),
  };

  if (!markdown.startsWith("---")) return defaults;
  const endIdx = markdown.indexOf("\n---", 3);
  if (endIdx === -1) return defaults;

  const front = markdown.slice(3, endIdx).trim();
  const body = markdown.slice(endIdx + 4).trim();
  const parsed = { ...defaults, promptBody: body };

  for (const line of front.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const val = line
      .slice(sep + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "name" && val) parsed.name = val;
    if (key === "maxIterations" && !Number.isNaN(Number(val)))
      parsed.maxIterations = Number(val);
    if (key === "defaultAcceptanceCommand" && val)
      parsed.defaultAcceptanceCommand = val;
    if (key === "autoMergeOnGreen") parsed.autoMergeOnGreen = val === "true";
  }

  return parsed;
}

export interface NhitlRunOutcome {
  taskId: string;
  passed: boolean;
  iterationsUsed: number;
  beforeSnapshot: WorkspaceDigest;
  afterSnapshot: WorkspaceDigest;
  acceptanceOutput: string;
}

async function runAcceptanceGate(
  cwd: string,
  command: string,
): Promise<{ ok: boolean; output: string }> {
  const isWin = process.platform === "win32";
  const argv = isWin
    ? ["pwsh", "-NoProfile", "-Command", command]
    : ["sh", "-lc", command];
  const proc = Bun.spawn(argv, {
    cwd: resolve(cwd),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    ok: exitCode === 0,
    output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
  };
}

/**
 * Creates a clean isolated git worktree (`Symphony` per-issue isolation) when `repoRoot` is a git repo,
 * or an isolated scratch directory otherwise, ensuring failed NHITL runs never dirty `main`.
 */
export async function withIsolatedWorktree<T>(
  repoRoot: string,
  taskId: string,
  fn: (isolatedDir: string, isGitWorktree: boolean) => Promise<T>,
): Promise<T> {
  const absRepo = resolve(repoRoot);
  const safeSlug = taskId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const worktreesBase = join(absRepo, ".pi-worktrees");
  mkdirSync(worktreesBase, { recursive: true });
  const targetDir = join(worktreesBase, `${safeSlug}-${Date.now()}`);

  const hasGit = existsSync(join(absRepo, ".git"));
  let createdGitWt = false;

  if (hasGit) {
    const addProc = Bun.spawn(
      ["git", "worktree", "add", "--detach", targetDir],
      {
        cwd: absRepo,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    createdGitWt = (await addProc.exited) === 0;
  }

  if (!createdGitWt) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    return await fn(targetDir, createdGitWt);
  } finally {
    if (createdGitWt) {
      const rmProc = Bun.spawn(
        ["git", "worktree", "remove", "--force", targetDir],
        {
          cwd: absRepo,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      await rmProc.exited;
    } else if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }
}

/**
 * Full-Auto NHITL ("No Human In The Loop") `Ralph` + `Symphony` autonomous execution loop:
 * Iterates fresh clean-context `Pi` agent sessions until every PRD item passes its empirical
 * acceptance command (`bun test`, `bun check`, `cargo test`), logging persistent state in `progress.log`.
 */
export async function runAutonomousNhitlLoop(opts: {
  workspaceDir: string;
  tasks: PrdTaskItem[];
  workflow: WorkflowSpec;
  callModel: PiModelCallFn;
}): Promise<NhitlRunOutcome[]> {
  const outcomes: NhitlRunOutcome[] = [];
  const progressPath = join(resolve(opts.workspaceDir), "progress.log");
  if (!existsSync(progressPath)) {
    writeFileSync(
      progressPath,
      `# pi-opencode Autonomous NHITL Log (${opts.workflow.name})\n`,
      "utf8",
    );
  }

  for (const task of opts.tasks) {
    if (task.completed) continue;

    const beforeSnapshot = snapshotWorkspace(opts.workspaceDir);
    let passed = false;
    let acceptanceOutput = "";
    let iterationsUsed = 0;
    const gateCmd =
      task.acceptanceCommand || opts.workflow.defaultAcceptanceCommand;

    for (let iter = 1; iter <= opts.workflow.maxIterations; iter++) {
      iterationsUsed = iter;
      const priorProgress = existsSync(progressPath)
        ? readFileSync(progressPath, "utf8")
        : "";
      const prompt = [
        opts.workflow.promptBody,
        "",
        `Task [${task.id}]: ${task.title}`,
        `Acceptance Gate Command: ${gateCmd}`,
        acceptanceOutput
          ? `Previous Gate Failure Output:\n${acceptanceOutput}`
          : "",
        priorProgress
          ? `Recent Progress Log:\n${priorProgress.slice(-2000)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      await runPiAgentLoop(
        prompt,
        {
          cwd: opts.workspaceDir,
          maxTurns: 8,
          allowShell: true,
        },
        opts.callModel,
      );

      const gate = await runAcceptanceGate(opts.workspaceDir, gateCmd);
      acceptanceOutput = gate.output;
      if (gate.ok) {
        passed = true;
        task.completed = true;
        break;
      }
    }

    const afterSnapshot = snapshotWorkspace(opts.workspaceDir);
    const logLine = `[${new Date().toISOString()}] task=${task.id} status=${passed ? "GREEN" : "RED"} iterations=${iterationsUsed} hash=${afterSnapshot.merkleHash}\n`;
    writeFileSync(
      progressPath,
      readFileSync(progressPath, "utf8") + logLine,
      "utf8",
    );

    outcomes.push({
      taskId: task.id,
      passed,
      iterationsUsed,
      beforeSnapshot,
      afterSnapshot,
      acceptanceOutput,
    });
  }

  return outcomes;
}
