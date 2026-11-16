// Router constants in one place: live data sources and the timings of the failover walk (ms unless noted).
// Every source URL can be overridden with an env var (mirrors, proxies, tests); nothing else is hardcoded elsewhere.
import { BASES } from "../llm/models.ts";

const env = (k: string, d: string) => Bun.env[k] || d;

export const SOURCES = {
  modelsdev: env("ROUTER_MODELSDEV_URL", "https://models.dev/api.json"),
  litellm: env(
    "ROUTER_LITELLM_URL",
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  ),
  openrouter: env("ROUTER_OPENROUTER_URL", `${BASES.openrouter}/v1/models`),
  hf: env("ROUTER_HF_URL", `${BASES.huggingface}/v1/models`),
  /** Arena leaderboard on the Hugging Face datasets-server (`/first-rows` and `/filter?where=` live next to it). */
  arenaDataset: env("ROUTER_ARENA_DATASET", "lmarena-ai/leaderboard-dataset"),
  datasetsServer: env(
    "ROUTER_DATASETS_SERVER",
    "https://datasets-server.huggingface.co",
  ),
} as const;

/** Arena categories the policies read: `overall` ranks, the code one drives `auto:code`. */
export const ARENA = { overall: "overall", code: "coding" } as const;

const MIN = 60_000;
export const TTL = {
  /** Source tables (models.dev, litellm, ...) are re-read after this. */
  sources: 6 * 60 * MIN,
  /** In-memory catalog, then the sqlite copy. */
  memory: 10 * MIN,
  stored: 60 * MIN,
} as const;

export const WALK = {
  attemptMs: 90_000,
  deadlineMs: 5 * MIN,
  rounds: 3,
  /** Cooldown by failure class. */
  coolServer: 15_000,
  coolTimeout: 10_000,
  coolEmpty: 5_000,
  coolAuth: 10 * MIN,
  coolQuota: 60 * MIN,
  coolRateMin: 5_000,
  coolRateDefault: 30_000,
  coolRateMax: 5 * MIN,
  /** Client errors (4xx other than auth/quota/rate) tolerated before giving up. */
  clientErrors: 4,
  /** Offers kept for the retry rounds. */
  retryPool: 5,
  backoffBase: 500,
  backoffMax: 4000,
} as const;
