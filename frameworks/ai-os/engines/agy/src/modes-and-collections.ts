import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getMcpToolsForProfile,
  installSkillCollection,
  resetToMinimalCollectionsOnly,
  SKILL_COLLECTION_PACKS,
  stripEmojis,
  syncUnifiedAgentHomes,
  writeFileSafeUserspace,
} from "../../../src/index.ts";

export type AgyExecutionMode = "minimal" | "fullstack";

export interface AgyModeState {
  mode: AgyExecutionMode;
  domainFocus: string;
  ephemeralUnrecorded: boolean;
  elevatedUserspaceNoSandbox: boolean;
  system32Protected: true;
  systemPrompt: string;
  systemPromptTokenEstimate: number;
  activeTools: string[];
  activeCollections: string[];
  updatedAt: string;
}

export const DEFAULT_AGY_MODE_STATE_PATH = "C:/aphrody/var/agy-mode-state.json";

/**
 * Quasi-empty (<100 tokens) system prompt for Mode 1 (`minimal` / `pi-sudo`):
 * Maximum context economy, ephemeral/unrecorded local mode, 24/7 single-domain
 * autonomy, computer-use + POSIX OS tools, unrestricted userspace (never System32).
 */
export function buildMinimalPiSudoSystemPrompt(
  domainFocus = "computer-use",
): string {
  return `Role: Autonomous local agent (${domainFocus}). Ephemeral unrecorded session.
Tools: os_atomic (read/write/edit/bash), posix_os, desktop_snapshot, desktop_action.
Rules: Execute directly 24/7 without chatter or emojis. Full userspace privileges enabled; C:\\Windows\\System32 strictly read-only.`;
}

/**
 * Full-power Pro-Max system prompt for Mode 2 (`fullstack` / `agy-normal`):
 * Modern Web Guidelines, Lighthouse 100, Core Web Vitals, Stitch, Figma, REA,
 * Replica, UI/UX Pro Max, 3D WebGPU/WGSL Pro Max, Impeccable, Humanizer,
 * Cloudflare + Vercel + src-deploy, and Bun v1.4.4 + Rust 2024 fullstack loops.
 */
export function buildFullstackProMaxSystemPrompt(
  domainFocus = "fullstack-bun-rust",
): string {
  return [
    `Role: Google Antigravity Pro-Max Fullstack Architect (${domainFocus}).`,
    "Stack: Bun v1.4.4 Full-Rust + Rust 2024 Fat-LTO + WASM32 + WebGPU WGSL + CUDA sm_89.",
    "Design & Quality Gates:",
    "1. Modern Web Guidelines + Lighthouse 100/100 + Core Web Vitals (LCP < 1.2s, INP < 50ms, CLS = 0.00 via wck).",
    "2. Google Labs Stitch + Material Design 3 + Fluent UI 2 + Figma design tokens (gds) + Impeccable layout spacing.",
    "3. 3D WebGPU/WGSL Pro Max shaders & interactive 60fps canvas without heavy JS bundle bloat.",
    "4. Clean-room REA + Ghidra SRE + 11-stage Replica architectural parity via n2b_rea.",
    "5. Humanizer strict copy filter: zero AI cliches, zero filler words, zero emojis.",
    "6. Built-in Cloudflare Workers/Pages + Vercel Edge + src-deploy one-click deployment.",
  ].join("\n");
}

// ============================================================================
// Humanizer & Impeccable Copy / Web Quality Gate
// ============================================================================

const AI_SLOP_PHRASES: ReadonlyArray<{ pattern: RegExp; replacement: string }> =
  [
    { pattern: /\bdelve(?:s|d)? into\b/gi, replacement: "examine" },
    { pattern: /\btapestry of\b/gi, replacement: "set of" },
    { pattern: /\btestament to\b/gi, replacement: "proof of" },
    {
      pattern: /\bin today's fast-paced digital landscape\b/gi,
      replacement: "today",
    },
    { pattern: /\bseamlessly\b/gi, replacement: "directly" },
    { pattern: /\bgame-changing\b/gi, replacement: "high-impact" },
    { pattern: /\bunleash the power of\b/gi, replacement: "use" },
    { pattern: /\bit is important to note that\b/gi, replacement: "" },
  ];

export function runHumanizerAndImpeccableAudit(text: string): {
  cleanText: string;
  slopDetectedCount: number;
  matchedPatterns: string[];
  impeccablePass: boolean;
} {
  let working = stripEmojis(text);
  const matchedPatterns: string[] = [];

  for (const rule of AI_SLOP_PHRASES) {
    if (rule.pattern.test(working)) {
      matchedPatterns.push(rule.pattern.source);
      working = working.replace(rule.pattern, rule.replacement);
    }
  }
  working = working.replace(/[ \t]{2,}/g, " ").trim();

  return {
    cleanText: working,
    slopDetectedCount: matchedPatterns.length,
    matchedPatterns,
    impeccablePass: matchedPatterns.length === 0 && working === text.trim(),
  };
}

// ============================================================================
// One-Click Collection Manager (Default = Minimal OS Tools Only!)
// ============================================================================

export function resetToMinimalOsBaseline(dbPath?: string): {
  activeCollections: string[];
  toolsExposed: string[];
} {
  resetToMinimalCollectionsOnly(dbPath);
  installSkillCollection("os-minimal", { dbPath });
  const toolsExposed = getMcpToolsForProfile("minimal").map((t) => t.name);
  return {
    activeCollections: ["os-minimal"],
    toolsExposed,
  };
}

export function switchAgyMode(
  mode: AgyExecutionMode,
  options?: {
    domainFocus?: string;
    syncHarnesses?: boolean;
    statePath?: string;
    dbPath?: string;
  },
): AgyModeState {
  const statePath = options?.statePath ?? DEFAULT_AGY_MODE_STATE_PATH;
  const domainFocus =
    options?.domainFocus ??
    (mode === "minimal" ? "computer-use-24x7" : "fullstack-pro-max");

  if (mode === "minimal") {
    resetToMinimalOsBaseline(options?.dbPath);
    if (options?.syncHarnesses) {
      syncUnifiedAgentHomes({ mcpProfile: "minimal" });
    }
    const prompt = buildMinimalPiSudoSystemPrompt(domainFocus);
    const state: AgyModeState = {
      mode: "minimal",
      domainFocus,
      ephemeralUnrecorded: true,
      elevatedUserspaceNoSandbox: true,
      system32Protected: true,
      systemPrompt: prompt,
      systemPromptTokenEstimate: Math.ceil(prompt.length / 4),
      activeTools: getMcpToolsForProfile("minimal").map((t) => t.name),
      activeCollections: ["os-minimal"],
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSafeUserspace(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  // Fullstack Pro-Max mode installs fullstack, google-labs, gemini-multimodal & google-cloud collections
  const proCollections = [
    "os-minimal",
    "pro-max-fullstack",
    "google-labs",
    "gemini-multimodal",
    "google-cloud",
  ];
  for (const cid of proCollections) {
    if (SKILL_COLLECTION_PACKS.some((c) => c.id === cid)) {
      installSkillCollection(cid, { dbPath: options?.dbPath });
    }
  }
  if (options?.syncHarnesses) {
    syncUnifiedAgentHomes({ mcpProfile: "default" });
  }
  const prompt = buildFullstackProMaxSystemPrompt(domainFocus);
  const state: AgyModeState = {
    mode: "fullstack",
    domainFocus,
    ephemeralUnrecorded: false,
    elevatedUserspaceNoSandbox: false,
    system32Protected: true,
    systemPrompt: prompt,
    systemPromptTokenEstimate: Math.ceil(prompt.length / 4),
    activeTools: getMcpToolsForProfile("default").map((t) => t.name),
    activeCollections: proCollections,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSafeUserspace(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function readCurrentAgyMode(
  statePath = DEFAULT_AGY_MODE_STATE_PATH,
): AgyModeState {
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, "utf8")) as AgyModeState;
    } catch {
      // fallback to global full-design fullstack default
    }
  }
  return switchAgyMode("fullstack", {
    domainFocus: "full-design-pro-max",
    statePath,
  });
}

// ============================================================================
// Built-In Cloudflare + Vercel + Bun + Rust Fullstack Scaffolder & /goal Loop
// ============================================================================

export function generateFullstackCloudflareVercelConfig(
  targetDir: string,
  appName = "agy-pro-app",
): {
  targetDir: string;
  wranglerTomlPath: string;
  vercelJsonPath: string;
  designMdPath: string;
} {
  const root = resolve(targetDir);
  mkdirSync(root, { recursive: true });

  const wranglerTomlPath = join(root, "wrangler.toml");
  writeFileSafeUserspace(
    wranglerTomlPath,
    `name = "${appName}"
main = "src/index.ts"
compatibility_date = "2026-11-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true
`,
  );

  const vercelJsonPath = join(root, "vercel.json");
  writeFileSafeUserspace(
    vercelJsonPath,
    `${JSON.stringify(
      {
        $schema: "https://openapi.vercel.sh/vercel.json",
        bunVersion: "1.x",
        framework: null,
        headers: [
          {
            source: "/(.*)",
            headers: [
              { key: "X-Content-Type-Options", value: "nosniff" },
              { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
              { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const designMdPath = join(root, "DESIGN.md");
  writeFileSafeUserspace(
    designMdPath,
    `# ${appName} — Stitch + Material Design 3 + WebGPU Pro-Max Contract

- **Typography**: Inter / Google Sans Text, modular scale 1.25, line-height 1.5
- **Color System**: Dynamic M3 Tonal Surface (\`#0b0f19\` dark / \`#f8fafc\` light, WCAG AAA >= 7:1)
- **Web Vitals Budget**: LCP < 1200ms, INP < 50ms, CLS = 0.00, initial HTML+CSS < 14KB
- **3D & Compute**: Native WebGPU WGSL + Rust \`wasm32-unknown-unknown\` kernel
- **Copy Policy**: Humanizer clean pass, zero emojis
`,
  );

  return {
    targetDir: root.replace(/\\/g, "/"),
    wranglerTomlPath: wranglerTomlPath.replace(/\\/g, "/"),
    vercelJsonPath: vercelJsonPath.replace(/\\/g, "/"),
    designMdPath: designMdPath.replace(/\\/g, "/"),
  };
}

export interface GoalLoopIterationReport {
  iteration: number;
  checksRun: string[];
  allPassed: boolean;
  diagnostics: string[];
  durationMs: number;
}

export async function runAutonomousGoalLoop(options: {
  targetDir: string;
  goalDescription: string;
  maxIterations?: number;
  infiniteUntilPass?: boolean;
}): Promise<{
  goalDescription: string;
  converged: boolean;
  iterationsCompleted: number;
  history: GoalLoopIterationReport[];
}> {
  const root = resolve(options.targetDir);
  const maxIter = options.maxIterations ?? (options.infiniteUntilPass ? 25 : 3);
  const history: GoalLoopIterationReport[] = [];

  for (let i = 1; i <= maxIter; i++) {
    const t0 = performance.now();
    const checksRun: string[] = [];
    const diagnostics: string[] = [];
    let allPassed = true;

    if (existsSync(join(root, "tsconfig.json"))) {
      checksRun.push("bun check");
      const chk = Bun.spawnSync(["bun", "check"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      if (chk.exitCode !== 0) {
        allPassed = false;
        diagnostics.push(
          new TextDecoder().decode(chk.stderr || chk.stdout).trim(),
        );
      }
    }

    if (existsSync(join(root, "Cargo.toml"))) {
      checksRun.push("cargo check");
      const cchk = Bun.spawnSync(["cargo", "check", "--quiet"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
      if (cchk.exitCode !== 0) {
        allPassed = false;
        diagnostics.push(new TextDecoder().decode(cchk.stderr).trim());
      }
    }

    if (existsSync(join(root, "DESIGN.md"))) {
      checksRun.push("humanizer-design-audit");
      const audit = runHumanizerAndImpeccableAudit(
        readFileSync(join(root, "DESIGN.md"), "utf8"),
      );
      if (audit.slopDetectedCount > 0) {
        allPassed = false;
        diagnostics.push(
          `Humanizer flagged: ${audit.matchedPatterns.join(", ")}`,
        );
      }
    }

    if (checksRun.length === 0) {
      checksRun.push("filesystem-presence-gate");
      allPassed = existsSync(root);
    }

    history.push({
      iteration: i,
      checksRun,
      allPassed,
      diagnostics,
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
    });

    if (allPassed) {
      return {
        goalDescription: stripEmojis(options.goalDescription),
        converged: true,
        iterationsCompleted: i,
        history,
      };
    }
  }

  return {
    goalDescription: stripEmojis(options.goalDescription),
    converged: false,
    iterationsCompleted: history.length,
    history,
  };
}
