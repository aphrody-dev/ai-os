// Declarative engine selection: a step states its needs (edit, tools, context, sort preference,
// allow/deny lists, preferred models) and gets back the ordered `providers` list the runner tries
// in order. Nothing is pinned: candidates = agent CLIs present on the host + models discovered through the bridge
// (llm_models), models.dev metadata (opencode registry: cost, context, tool_call, reasoning), observed health
// (health.ts) and runner cooldowns. Prior art and sources: docs/ORCHESTRATOR.md.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listModels } from "../llm/models";
import { clisOn, type Host } from "./fleet";
import type { Health } from "./health";
import type { RunnerState } from "./queue";

/** CLIs the runner can launch (tools/agents/runner.ts providerCmd), addressed "cli" or "cli:model". */
export const AGENT_CLIS = ["claude", "codex", "opencode", "pi", "agy"];
/** Remote runner provider ("jules[:owner/repo]", ai-os jules run --wait): never chosen without a request. */
export const JULES = "jules";

export type Needs = {
  /** The step modifies files: only agent CLIs qualify (llm_ask answers in text only). */
  edit?: boolean;
  /** Appels d'outils requis (models.dev tool_call). */
  tools?: boolean;
  /** Contexte minimal en jetons (models.dev limit.context). */
  context?: number;
  reasoning?: boolean;
  /** Sort, like OpenRouter provider.sort: observed reliability (default), cost, latency. */
  prefer?: "reliability" | "cost" | "latency";
  /** Regular expressions on the identifier (OpenRouter provider.only / provider.ignore). */
  only?: string[];
  ignore?: string[];
  /** Preferred models, tried first (OpenRouter `models` parameter); "cli:model" is followed by "cli". */
  models?: string[];
};

export type Candidate = {
  id: string; // valeur de `providers`
  kind: "cli" | "model";
  cost?: number; // $ per million tokens (input + output), models.dev
  context?: number;
  tools?: boolean;
  reasoning?: boolean;
  why: string;
};

type Meta = {
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  tool_call?: boolean;
  reasoning?: boolean;
};
type Registry = Record<string, { models?: Record<string, Meta> }>;
let registry: { at: number; data: Registry } | undefined;

/** models.dev/api.json, cached 24 h in $AGENT_HOME; empty offline. */
export async function modelsDev(): Promise<Registry> {
  if (
    registry &&
    Object.keys(registry.data).length &&
    Date.now() - registry.at < 864e5
  )
    return registry.data;
  const f = join(
    Bun.env.AGENT_HOME ?? join(homedir(), ".agent"),
    "models.dev.json",
  );
  const fresh = existsSync(f) && Date.now() - statSync(f).mtimeMs < 864e5;
  if (!fresh)
    try {
      const r = await fetch(
        Bun.env.MODELS_DEV_URL ?? "https://models.dev/api.json",
        {
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (r.ok) {
        const text = await r.text();
        registry = { at: Date.now(), data: JSON.parse(text) };
        try {
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f, text);
        } catch {}
        return registry.data;
      }
    } catch {}
  try {
    registry = { at: Date.now(), data: JSON.parse(readFileSync(f, "utf8")) };
  } catch {
    registry = { at: 0, data: {} };
  }
  return registry.data;
}

/** Metadata of a bridge model `provider/model` (OpenRouter: `openrouter/vendor/model`). */
export function meta(reg: Record<string, any>, id: string): Meta | undefined {
  const i = id.indexOf("/");
  if (i < 0) return undefined;
  const p = id.slice(0, i);
  const m = id.slice(i + 1);
  return (
    reg[p]?.models?.[m] ??
    reg[m.split("/")[0]!]?.models?.[m.split("/").slice(1).join("/")]
  );
}

const sane = (p: string) => p.replace(/[^\w.-]/g, "_");

/** Candidates of a host: CLIs present (runner probe, else `command -v`) and, on the local host, bridge models. */
export async function candidates(
  h: Host,
  state: RunnerState | undefined,
  withModels = h.local,
): Promise<Candidate[]> {
  // Runner probe: only explicit positive statuses count; CLIs it does not list are looked up
  // on the host.
  const probe = state?.clis ?? {};
  const positive = (v: unknown) =>
    v === true || /^(ok|ready|installed|v?\d)/i.test(String(v ?? ""));
  const probed = AGENT_CLIS.filter((k) => k in probe && positive(probe[k]));
  const unknown = AGENT_CLIS.filter((k) => !(k in probe));
  const found = unknown.length ? await clisOn(h, unknown) : [];
  const out: Candidate[] = [
    ...probed.map((c) => ({
      id: c,
      kind: "cli" as const,
      tools: true,
      why: "runner probe",
    })),
    ...found.map((c) => ({
      id: c,
      kind: "cli" as const,
      tools: true,
      why: "command -v",
    })),
  ];
  if (withModels) {
    const reg = await modelsDev();
    for (const p of await listModels().catch(() => [])) {
      if (!p.available) continue;
      // The bridge's CLI providers (antigravity, claude) are already covered by the runner's CLIs.
      if (p.provider === "antigravity" || p.provider === "claude") continue;
      for (const m of p.models) {
        const md = meta(reg, m.id);
        out.push({
          id: m.id,
          kind: "model",
          cost: md?.cost && (md.cost.input ?? 0) + (md.cost.output ?? 0),
          context: md?.limit?.context ?? m.context,
          tools: md?.tool_call,
          reasoning: md?.reasoning,
          why: md ? "llm_models + models.dev" : "llm_models",
        });
      }
    }
  }
  return out;
}

/** Ordered `providers` list for a step on a host. Empty if no engine fits. */
export function rank(
  host: string,
  all: Candidate[],
  needs: Needs,
  health: Health,
  cooling: string[] = [],
): string[] {
  // Patterns from generated JSON: invalid ones are ignored rather than failing the step.
  const re = (xs?: unknown[]) =>
    (Array.isArray(xs) ? xs : []).flatMap((x) => {
      try {
        return typeof x === "string" ? [new RegExp(x, "i")] : [];
      } catch {
        return [];
      }
    });
  const only = re(needs.only);
  const ignore = re(needs.ignore);
  const usable = (id: string) =>
    (!only.length || only.some((r) => r.test(id))) &&
    !ignore.some((r) => r.test(id)) &&
    !cooling.includes(sane(id)) &&
    !health.cooling(host, id) &&
    // Account-level failure recorded on the provider itself (billing off, API disabled): its whole family waits.
    !(id.includes("/") && health.cooling(host, id.slice(0, id.indexOf("/"))));
  // An agent CLI manages its own tools and context; a bridge model must prove each required capability
  // (missing metadata = rejected), and llm_ask wires no tools.
  const fits = (c: Candidate) =>
    usable(c.id) &&
    (c.kind === "cli" ||
      (!needs.edit &&
        !needs.tools &&
        (!needs.reasoning || c.reasoning === true) &&
        (!needs.context ||
          (typeof c.context === "number" && c.context >= needs.context))));
  // Jules (src/google/jules) works on the GitHub repository, not on the host copy: candidate on request
  // explicite seulement (`models: ["jules"]`, `["jules:owner/repo"]` ou `only: ["^jules"]`).
  const askedJules = [...(needs.models ?? []), ...(needs.only ?? [])].some(
    (m) => typeof m === "string" && /^\^?jules(:|$)/.test(m),
  );
  const withJules: Candidate[] =
    askedJules && !all.some((c) => c.id === JULES)
      ? [
          ...all,
          { id: JULES, kind: "cli", tools: true, why: "Jules (cloud, GitHub)" },
        ]
      : all;
  const pool = withJules.filter(fits);
  const score = (c: Candidate) => {
    const s = health.stats(host, c.id);
    const rel = (s.ok + 1) / (s.n + 2);
    switch (needs.prefer) {
      case "cost":
        return -(c.cost ?? 1e6) + rel * 1e-3;
      case "latency":
        return -(s.p50 || 60_000) + rel;
      default:
        return rel - (s.p50 || 60_000) * 1e-9;
    }
  };
  const ranked = [...pool].sort((a, b) => score(b) - score(a)).map((c) => c.id);
  const wanted: string[] = [];
  for (const m of needs.models ?? []) {
    if (typeof m !== "string") continue;
    const cli = m.includes(":") ? m.split(":")[0]! : m;
    // The preferred model passes the same filters as its engine (capabilities, CLI cooldown).
    if (!pool.some((c) => c.id === cli) || !usable(m)) continue;
    wanted.push(m);
    if (m.includes(":") && pool.some((c) => c.id === cli)) wanted.push(cli);
  }
  return [...new Set([...wanted, ...ranked])];
}

/** Price/quality table per task class (config/model-routing.json, live sources): primary "cli:model" then fallback.
 * anthropic goes through the claude CLI, google through agy. Unknown = empty list (the usual ranking applies). */
export async function taskModels(task: string | undefined): Promise<string[]> {
  if (!task) return [];
  const f = Bun.file(
    new URL("../../config/model-routing.json", import.meta.url),
  );
  if (!(await f.exists())) return [];
  const t = (await f.json()).tasks?.[task];
  if (!t) throw new Error(`unknown task class: ${task}`);
  const cli: Record<string, string> = { anthropic: "claude", google: "agy" };
  return [t.primary, ...(t.fallback ?? [])]
    .filter((r: any) => cli[r.provider])
    .map((r: any) => `${cli[r.provider]}:${r.model}`);
}
