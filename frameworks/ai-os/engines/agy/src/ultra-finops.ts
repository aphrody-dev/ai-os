import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_FINOPS_DB_PATH = "C:/aphrody/var/agy-finops.sqlite";

export interface GoogleAiSubscriptionPlan {
  id: "google-ai-ultra" | "google-ai-pro" | "payg-api-only";
  displayName: string;
  monthlyPriceUsd: number;
  includedMonthlyAiCredits: number;
  storageTb: number;
  benefits: Array<{
    feature: string;
    quotaOrLimit: string;
    equivalentApiMonthlyValueUsd: number;
    monorepoHarnessCommand: string;
  }>;
}

export const GOOGLE_AI_PLANS: Record<
  GoogleAiSubscriptionPlan["id"],
  GoogleAiSubscriptionPlan
> = {
  "google-ai-ultra": {
    id: "google-ai-ultra",
    displayName: "Google AI Ultra",
    monthlyPriceUsd: 249.99,
    includedMonthlyAiCredits: 25_000,
    storageTb: 30,
    benefits: [
      {
        feature: "Gemini 3.1 Pro + Deep Think + 1M Context Priority",
        quotaOrLimit: "Highest tier daily Deep Think & Deep Research runs",
        equivalentApiMonthlyValueUsd: 180.0,
        monorepoHarnessCommand: "agy-studio ultra record --feature deep-think",
      },
      {
        feature: "Google Antigravity IDE & CLI Priority Agent Quotas",
        quotaOrLimit: "Highest agentic coding & multi-turn swarm rate limits",
        equivalentApiMonthlyValueUsd: 160.0,
        monorepoHarnessCommand: "agy /goal",
      },
      {
        feature: "Veo 3 / Gemini Omni 1.2 Flash Video & Flow Studio",
        quotaOrLimit: "25,000 monthly AI credits across Flow & Whisk",
        equivalentApiMonthlyValueUsd: 125.0,
        monorepoHarnessCommand: "gemini-api video",
      },
      {
        feature: "Jules Autonomous Coding Agent (Highest Limits)",
        quotaOrLimit: "Highest concurrent async GitHub repo tasks",
        equivalentApiMonthlyValueUsd: 90.0,
        monorepoHarnessCommand: "agy-studio collections install google-labs",
      },
      {
        feature: "Project Mariner Agentic Browser Multitasking",
        quotaOrLimit: "Up to 10 parallel autonomous research/browser streams",
        equivalentApiMonthlyValueUsd: 65.0,
        monorepoHarnessCommand: "agent-browser",
      },
      {
        feature: "NotebookLM Plus Highest Limits",
        quotaOrLimit: "5x Audio Overviews, notebooks & sources per notebook",
        equivalentApiMonthlyValueUsd: 40.0,
        monorepoHarnessCommand: "agy-studio notebooklm",
      },
      {
        feature:
          "Google Developer Program Premium + Cloud Perks + 30TB + YouTube Premium",
        quotaOrLimit:
          "30 TB Google One + YouTube Premium + GCP consultations/credits",
        equivalentApiMonthlyValueUsd: 163.99,
        monorepoHarnessCommand: "ai-os auth-doctor",
      },
    ],
  },
  "google-ai-pro": {
    id: "google-ai-pro",
    displayName: "Google AI Pro",
    monthlyPriceUsd: 19.99,
    includedMonthlyAiCredits: 1_000,
    storageTb: 2,
    benefits: [
      {
        feature: "Gemini Pro + Deep Research + Antigravity Standard Quotas",
        quotaOrLimit: "Standard Pro limits + 1,000 monthly video credits",
        equivalentApiMonthlyValueUsd: 65.0,
        monorepoHarnessCommand: "agy",
      },
      {
        feature: "2 TB Google One + Workspace Gemini Integration",
        quotaOrLimit: "2 TB Drive/Photos + Docs/Gmail AI",
        equivalentApiMonthlyValueUsd: 19.99,
        monorepoHarnessCommand: "gws drive files list",
      },
    ],
  },
  "payg-api-only": {
    id: "payg-api-only",
    displayName: "Pay-As-You-Go Vertex / Gemini API + Local RTX 4070",
    monthlyPriceUsd: 0,
    includedMonthlyAiCredits: 0,
    storageTb: 0,
    benefits: [],
  },
};

export interface ModelTokenPricingSpec {
  modelId: string;
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
  coveredByUltraSubscription: boolean;
  localElectricityUsdPer1M: number;
}

export const GEMINI_AND_LOCAL_PRICING: readonly ModelTokenPricingSpec[] = [
  {
    modelId: "gemini-3.1-pro",
    inputUsdPer1M: 2.0,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 12.0,
    coveredByUltraSubscription: true,
    localElectricityUsdPer1M: 0,
  },
  {
    modelId: "gemini-2.5-pro",
    inputUsdPer1M: 1.25,
    cachedInputUsdPer1M: 0.31,
    outputUsdPer1M: 10.0,
    coveredByUltraSubscription: true,
    localElectricityUsdPer1M: 0,
  },
  {
    modelId: "gemini-2.5-flash",
    inputUsdPer1M: 0.15,
    cachedInputUsdPer1M: 0.0375,
    outputUsdPer1M: 0.6,
    coveredByUltraSubscription: true,
    localElectricityUsdPer1M: 0,
  },
  {
    modelId: "gemini-omni-1.2-flash",
    inputUsdPer1M: 0.3,
    cachedInputUsdPer1M: 0.075,
    outputUsdPer1M: 2.5,
    coveredByUltraSubscription: true,
    localElectricityUsdPer1M: 0,
  },
  {
    modelId: "gemma-4-12b-heretic-q4km",
    inputUsdPer1M: 0,
    cachedInputUsdPer1M: 0,
    outputUsdPer1M: 0,
    coveredByUltraSubscription: false,
    // RTX 4070 ~185W @ ~85 tok/s -> ~0.60 kWh per 1M tokens -> ~$0.12 electricity
    localElectricityUsdPer1M: 0.12,
  },
];

export interface ContextOptimizationReport {
  legacyFragmentedMcpTokensPerTurn: number;
  unifiedDefaultMcpTokensPerTurn: number;
  minimalPiSudoTokensPerTurn: number;
  tokensSavedPerTurnDefault: number;
  tokensSavedPerTurnMinimal: number;
  savingsPctMinimal: number;
  monthlyUsdSavedAt200TurnsPerDay: number;
}

export function calculateContextOptimizationSavings(
  turnsPerDay = 200,
  modelId = "gemini-3.1-pro",
): ContextOptimizationReport {
  // 10 fragmented MCP servers (~68 tools + verbose system prompts) ~= 19,400 tokens/turn
  const legacyFragmentedMcpTokensPerTurn = 19_400;
  // Unified ai-os default router (18 compact domain tools) ~= 3,150 tokens/turn
  const unifiedDefaultMcpTokensPerTurn = 3_150;
  // Minimal pi-sudo mode (7 minimal OS/CU tools + <100 tok system prompt) ~= 620 tokens/turn
  const minimalPiSudoTokensPerTurn = 620;

  const tokensSavedPerTurnDefault =
    legacyFragmentedMcpTokensPerTurn - unifiedDefaultMcpTokensPerTurn;
  const tokensSavedPerTurnMinimal =
    legacyFragmentedMcpTokensPerTurn - minimalPiSudoTokensPerTurn;
  const savingsPctMinimal =
    Math.round(
      (tokensSavedPerTurnMinimal / legacyFragmentedMcpTokensPerTurn) * 10000,
    ) / 100;

  const spec =
    GEMINI_AND_LOCAL_PRICING.find((p) => p.modelId === modelId) ??
    GEMINI_AND_LOCAL_PRICING[0]!;
  const monthlySavedTokens = tokensSavedPerTurnMinimal * turnsPerDay * 30;
  const monthlyUsdSavedAt200TurnsPerDay =
    Math.round((monthlySavedTokens / 1_000_000) * spec.inputUsdPer1M * 100) /
    100;

  return {
    legacyFragmentedMcpTokensPerTurn,
    unifiedDefaultMcpTokensPerTurn,
    minimalPiSudoTokensPerTurn,
    tokensSavedPerTurnDefault,
    tokensSavedPerTurnMinimal,
    savingsPctMinimal,
    monthlyUsdSavedAt200TurnsPerDay,
  };
}

function openFinOpsDb(dbPath = DEFAULT_FINOPS_DB_PATH): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS finops_usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at TEXT NOT NULL,
      surface TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      ai_credits_used INTEGER NOT NULL DEFAULT 0,
      api_equivalent_usd REAL NOT NULL
    );
  `);
  return db;
}

export function estimateUsageApiValueUsd(params: {
  modelId: string;
  inputTokens: number;
  cachedTokens?: number;
  outputTokens: number;
  aiCreditsUsed?: number;
}): number {
  const spec =
    GEMINI_AND_LOCAL_PRICING.find((m) => m.modelId === params.modelId) ??
    GEMINI_AND_LOCAL_PRICING[0]!;
  const cached = Math.min(params.inputTokens, params.cachedTokens ?? 0);
  const uncached = Math.max(0, params.inputTokens - cached);

  const tokenUsd =
    (uncached / 1_000_000) * spec.inputUsdPer1M +
    (cached / 1_000_000) * spec.cachedInputUsdPer1M +
    (params.outputTokens / 1_000_000) * spec.outputUsdPer1M;

  // 25,000 Ultra AI video/agent credits ~= $125 value ($0.005 / credit)
  const creditUsd = (params.aiCreditsUsed ?? 0) * 0.005;
  return Math.round((tokenUsd + creditUsd) * 10000) / 10000;
}

export function recordSubscriptionUsage(
  params: {
    surface: string;
    modelId: string;
    inputTokens: number;
    cachedTokens?: number;
    outputTokens: number;
    aiCreditsUsed?: number;
  },
  dbPath = DEFAULT_FINOPS_DB_PATH,
): {
  ok: true;
  apiEquivalentUsd: number;
} {
  const apiEquivalentUsd = estimateUsageApiValueUsd(params);
  const db = openFinOpsDb(dbPath);
  db.prepare(
    `INSERT INTO finops_usage_ledger
     (recorded_at, surface, model_id, input_tokens, cached_tokens, output_tokens, ai_credits_used, api_equivalent_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    params.surface,
    params.modelId,
    params.inputTokens,
    params.cachedTokens ?? 0,
    params.outputTokens,
    params.aiCreditsUsed ?? 0,
    apiEquivalentUsd,
  );
  db.close();
  return { ok: true, apiEquivalentUsd };
}

export interface SubscriptionRentabilisationReport {
  plan: GoogleAiSubscriptionPlan;
  monthlyPriceUsd: number;
  fixedPerksMonthlyValueUsd: number;
  meteredUsageApiEquivalentUsd: number;
  contextOptimizationMonthlySavedUsd: number;
  totalExtractedMonthlyValueUsd: number;
  netGainUsd: number;
  rentabilisationPct: number;
  profitable: boolean;
  underutilizedActionPlan: string[];
}

export function computeSubscriptionRentabilisation(options?: {
  planId?: GoogleAiSubscriptionPlan["id"];
  includeFixedPerksValue?: boolean;
  dbPath?: string;
}): SubscriptionRentabilisationReport {
  const planId = options?.planId ?? "google-ai-ultra";
  const plan = GOOGLE_AI_PLANS[planId];
  const db = openFinOpsDb(options?.dbPath);
  const row = db
    .query(
      `SELECT COALESCE(SUM(api_equivalent_usd), 0) AS total_usd,
              COALESCE(SUM(ai_credits_used), 0) AS total_credits
       FROM finops_usage_ledger`,
    )
    .get() as { total_usd: number; total_credits: number };
  db.close();

  // Fixed non-AI storage/YouTube/Cloud perks baseline ($43.99/mo for 30TB + YT Premium)
  const fixedPerksMonthlyValueUsd =
    options?.includeFixedPerksValue !== false
      ? planId === "google-ai-ultra"
        ? 43.99
        : planId === "google-ai-pro"
          ? 9.99
          : 0
      : 0;

  const ctxOpt = calculateContextOptimizationSavings(200, "gemini-3.1-pro");
  const meteredUsageApiEquivalentUsd = Math.round(row.total_usd * 100) / 100;
  const totalExtractedMonthlyValueUsd =
    Math.round(
      (fixedPerksMonthlyValueUsd +
        meteredUsageApiEquivalentUsd +
        ctxOpt.monthlyUsdSavedAt200TurnsPerDay) *
        100,
    ) / 100;

  const netGainUsd =
    Math.round((totalExtractedMonthlyValueUsd - plan.monthlyPriceUsd) * 100) /
    100;
  const rentabilisationPct =
    plan.monthlyPriceUsd > 0
      ? Math.round(
          (totalExtractedMonthlyValueUsd / plan.monthlyPriceUsd) * 10000,
        ) / 100
      : 100;

  const remainingCredits = Math.max(
    0,
    plan.includedMonthlyAiCredits - row.total_credits,
  );
  const underutilizedActionPlan: string[] = [];
  if (remainingCredits > 0) {
    underutilizedActionPlan.push(
      `Consume ${remainingCredits.toLocaleString()} unused monthly AI credits on Veo / Gemini Omni 1.2 Flash video assets or Flow renders before billing reset.`,
    );
  }
  underutilizedActionPlan.push(
    "Route >128K repository architecture audits & live web grounding to Gemini 3.1 Pro / Deep Research (zero extra marginal cost under AI Ultra).",
    "Route repetitive 24/7 computer-use & POSIX file loops to local Gemma 4 12B Heretic + minimal pi-sudo mode (saves 96.8% context quota).",
    "Delegate asynchronous unit-test/migration PR sweeps to Jules autonomous tasks included in AI Ultra.",
  );

  return {
    plan,
    monthlyPriceUsd: plan.monthlyPriceUsd,
    fixedPerksMonthlyValueUsd,
    meteredUsageApiEquivalentUsd,
    contextOptimizationMonthlySavedUsd: ctxOpt.monthlyUsdSavedAt200TurnsPerDay,
    totalExtractedMonthlyValueUsd,
    netGainUsd,
    rentabilisationPct,
    profitable: totalExtractedMonthlyValueUsd >= plan.monthlyPriceUsd,
    underutilizedActionPlan,
  };
}
