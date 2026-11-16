// Catalog: one table of model offers. Every model discovered at run time (llm/models.ts) is joined to
//   models.dev (context, output limit, modalities, tool support, price), the litellm price map,
//   OpenRouter /models (price, context), the Hugging Face router /v1/models (per-provider price, latency, tools)
//   and the Arena text leaderboard (lmarena-ai/leaderboard-dataset on the HF datasets-server, overall rating).
// Distilled source tables are cached in bun:sqlite (Store.catalog); refresh() re-reads the live sources.
import { outboundFetch } from "../relay/outbound.ts";
import type { Provider } from "../llm/models.ts";
import { listModels, providers } from "../llm/models.ts";
import { ARENA, SOURCES, TTL } from "./config.ts";
import type { Store } from "./stats.ts";

export type Offer = {
  /** `provider/model`: the id accepted by `model`. */
  id: string;
  provider: string;
  model: string;
  /** Normalised model name, shared by every provider serving the same model. */
  key: string;
  /** CLI-backed (no tool calling, no streaming, no usage): last resort tier. */
  cli: boolean;
  context?: number;
  maxOutput?: number;
  tools: boolean;
  vision: boolean;
  /** USD per million tokens. */
  priceIn?: number;
  priceOut?: number;
  /** Arena rating (public leaderboard) and vote count. */
  arena?: number;
  arenaVotes?: number;
  /** Arena rating in the coding category (drives `auto:code`). */
  arenaCode?: number;
  sources: string[];
};

type Info = {
  ctx?: number;
  out?: number;
  tools?: boolean;
  vision?: boolean;
  pi?: number;
  po?: number;
};
type Sources = {
  modelsdev: Record<string, Info>;
  litellm: Record<string, Info>;
  openrouter: Record<string, Info>;
  hf: Record<string, Info & { latency?: number }>;
  arena: Record<
    string,
    { rating: number; votes: number; name: string; code?: number }
  >;
};

/** Normalised model key: last path segment, no variant suffix, no date, alphanumerics joined by `-`. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/:(free|thinking|extended|beta|exacto|nitro|floor|online)$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-?(20\d{2}-?\d{2}-?\d{2}|\d{8})$/, "")
    .replace(/^-+|-+$/g, "");

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const getJson = async (url: string, ms = 30_000) => {
  const r = await outboundFetch(url, {
    signal: AbortSignal.timeout(ms),
    deterministic: true,
  });
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  return (await r.json()) as any;
};

async function fetchModelsDev(): Promise<Sources["modelsdev"]> {
  const j = await getJson(SOURCES.modelsdev);
  const out: Sources["modelsdev"] = {};
  for (const p of Object.values<any>(j))
    for (const m of Object.values<any>(p.models ?? {})) {
      const k = norm(String(m.id));
      // The first provider listing a model wins (the vendor's own listing is usually first).
      out[k] ??= {
        ctx: num(m.limit?.context),
        out: num(m.limit?.output),
        tools: m.tool_call === true,
        vision: (m.modalities?.input ?? []).includes("image"),
        pi: num(m.cost?.input),
        po: num(m.cost?.output),
      };
    }
  return out;
}
async function fetchLitellm(): Promise<Sources["litellm"]> {
  const j = await getJson(SOURCES.litellm);
  const out: Sources["litellm"] = {};
  for (const [id, m] of Object.entries<any>(j)) {
    if (m.mode !== "chat" && m.mode !== "responses") continue;
    const k = norm(id);
    out[k] ??= {
      ctx: num(m.max_input_tokens ?? m.max_tokens),
      out: num(m.max_output_tokens),
      tools: m.supports_function_calling === true,
      vision: m.supports_vision === true,
      pi: num(m.input_cost_per_token) && num(m.input_cost_per_token)! * 1e6,
      po: num(m.output_cost_per_token) && num(m.output_cost_per_token)! * 1e6,
    };
  }
  return out;
}
async function fetchOpenrouter(): Promise<Sources["openrouter"]> {
  const j = await getJson(SOURCES.openrouter);
  const out: Sources["openrouter"] = {};
  for (const m of j.data ?? []) {
    const pi = num(m.pricing?.prompt);
    const po = num(m.pricing?.completion);
    const k = norm(String(m.id));
    const cur = out[k];
    const info: Info = {
      ctx: num(m.context_length),
      out: num(m.top_provider?.max_completion_tokens),
      tools: (m.supported_parameters ?? []).includes("tools"),
      vision: (m.architecture?.input_modalities ?? []).includes("image"),
      pi: pi === undefined ? undefined : pi * 1e6,
      po: po === undefined ? undefined : po * 1e6,
    };
    // Free variants are listed under the same key as the paid model: keep the paid price.
    if (!cur || (cur.pi === 0 && (info.pi ?? 0) > 0)) out[k] = info;
  }
  return out;
}
async function fetchHf(): Promise<Sources["hf"]> {
  const j = await getJson(SOURCES.hf);
  const out: Sources["hf"] = {};
  for (const m of j.data ?? []) {
    const live = (m.providers ?? []).filter((p: any) => p.status === "live");
    if (!live.length) continue;
    const priced = live.filter((p: any) => p.pricing);
    out[String(m.id)] = {
      ctx:
        Math.max(...live.map((p: any) => num(p.context_length) ?? 0)) ||
        undefined,
      tools: live.some((p: any) => p.supports_tools),
      vision: (m.architecture?.input_modalities ?? []).includes("image"),
      pi: priced.length
        ? Math.min(...priced.map((p: any) => p.pricing.input))
        : undefined,
      po: priced.length
        ? Math.min(...priced.map((p: any) => p.pricing.output))
        : undefined,
      latency: Math.min(
        ...live.map((p: any) => num(p.first_token_latency_ms) ?? Infinity),
      ),
    };
  }
  return out;
}
/** Arena text leaderboard rows of one category (datasets-server `/filter`, SQL-like `where`). */
async function arenaRows(category: string): Promise<any[]> {
  const q = new URLSearchParams({
    dataset: SOURCES.arenaDataset,
    config: "text",
    split: "latest",
    where: `"category"='${category}'`,
    length: "100",
  });
  return (
    (await getJson(`${SOURCES.datasetsServer}/filter?${q}`)).rows ?? []
  ).map((r: any) => r.row);
}
/** Arena text leaderboard: overall rating, plus the coding-category rating when the dataset serves it. */
async function fetchArena(): Promise<Sources["arena"]> {
  const out: Sources["arena"] = {};
  for (const row of await arenaRows(ARENA.overall)) {
    const k = norm(String(row.model_name));
    if (!out[k] || row.rating > out[k]!.rating)
      out[k] = {
        rating: row.rating,
        votes: row.vote_count,
        name: row.model_name,
      };
  }
  // Optional: a failure here must not lose the overall table.
  for (const row of await arenaRows(ARENA.code).catch(() => [])) {
    const e = out[norm(String(row.model_name))];
    if (e && row.rating > (e.code ?? -Infinity)) e.code = row.rating;
  }
  return out;
}
const EMPTY: Sources = {
  modelsdev: {},
  litellm: {},
  openrouter: {},
  hf: {},
  arena: {},
};
const FETCH: Record<keyof Sources, () => Promise<any>> = {
  modelsdev: fetchModelsDev,
  litellm: fetchLitellm,
  openrouter: fetchOpenrouter,
  hf: fetchHf,
  arena: fetchArena,
};

/** Re-reads the live sources (failures keep the cached table of that source) and caches the distilled tables. */
export async function refreshSources(store: Store, force = false) {
  const out: Sources = structuredClone(EMPTY);
  const report: Record<string, string> = {};
  await Promise.all(
    (Object.keys(FETCH) as (keyof Sources)[]).map(async (name) => {
      const c = store.cacheGet<any>(`src:${name}`);
      if (c && !force && Date.now() - c.ts < TTL.sources) {
        out[name] = c.value;
        report[name] = `cache ${Object.keys(c.value).length}`;
        return;
      }
      try {
        out[name] = await FETCH[name]();
        store.cachePut(`src:${name}`, out[name]);
        report[name] = `live ${Object.keys(out[name]).length}`;
      } catch (e: any) {
        out[name] = c?.value ?? {};
        report[name] =
          `${c ? "stale" : "absent"} (${String(e.message).slice(0, 80)})`;
      }
    }),
  );
  return { sources: out, report };
}

/** Arena entry for a model key: exact, else the longest arena key the offer key extends (`-` boundary). */
function arenaFor(a: Sources["arena"], key: string) {
  if (a[key]) return a[key];
  let best: string | undefined;
  for (const k of Object.keys(a))
    if (key.startsWith(`${k}-`) && (!best || k.length > best.length)) best = k;
  return best && a[best];
}

/** Joins discovered provider models with the source tables. Pure: tests call it with fake sources. */
export function join(
  discovered: {
    id: string;
    provider: string;
    name?: string;
    context?: number;
  }[],
  cliProviders: Set<string>,
  src: Sources,
  localProviders: Set<string> = new Set(),
): Offer[] {
  return discovered.map((m) => {
    const model = m.id.slice(m.provider.length + 1);
    const key = norm(model);
    const sources: string[] = [];
    const hf = m.provider === "huggingface" ? src.hf[model] : undefined;
    const pick = [
      ["hf", hf],
      [
        "openrouter",
        m.provider === "openrouter" ? src.openrouter[key] : undefined,
      ],
      ["models.dev", src.modelsdev[key]],
      ["litellm", src.litellm[key]],
      ["openrouter", src.openrouter[key]],
    ] as const;
    const o: Offer = {
      id: m.id,
      provider: m.provider,
      model,
      key,
      cli: cliProviders.has(m.provider),
      context: m.context,
      tools: false,
      vision: false,
      sources,
    };
    const priceFrom: string[] = [];
    for (const [name, i] of pick) {
      if (!i) continue;
      if (!sources.includes(name)) sources.push(name);
      o.context ??= i.ctx;
      o.maxOutput ??= i.out;
      o.tools ||= i.tools === true;
      o.vision ||= i.vision === true;
      if (o.priceIn === undefined && i.pi !== undefined) {
        o.priceIn = i.pi;
        o.priceOut = i.po;
        priceFrom.push(name);
      }
    }
    // Local servers cost nothing; CLI agents are billed by their subscription (price unknown, not zero).
    if (localProviders.has(m.provider)) {
      o.priceIn = 0;
      o.priceOut = 0;
    }
    const a = arenaFor(src.arena, key);
    if (a) {
      o.arena = a.rating;
      o.arenaVotes = a.votes;
      o.arenaCode = a.code;
      sources.push("arena");
    }
    if (o.cli) o.tools = false;
    return o;
  });
}

export type Catalog = {
  offers: Offer[];
  providers: {
    provider: string;
    available: boolean;
    error?: string;
    models: number;
  }[];
  at: number;
  report: Record<string, string>;
};

/** Builds the catalog: discovery (all providers) + joined sources; cached in the store, refreshed when older than `ttl`. */
export async function buildCatalog(
  store: Store,
  force = false,
): Promise<Catalog> {
  const [{ sources, report }, found] = await Promise.all([
    refreshSources(store, force),
    listModels(),
  ]);
  const cli = new Set(
    providers()
      .filter((p: Provider) => !p.chat)
      .map((p) => p.id),
  );
  const local = new Set(
    providers()
      .filter((p: Provider) => p.local)
      .map((p) => p.id),
  );
  const offers = join(
    found.flatMap((g) => g.models),
    cli,
    sources,
    local,
  );
  const cat: Catalog = {
    offers,
    providers: found.map((g) => ({
      provider: g.provider,
      available: g.available,
      error: (g as any).error,
      models: g.models.length,
    })),
    at: Date.now(),
    report,
  };
  store.cachePut("offers", cat);
  return cat;
}
