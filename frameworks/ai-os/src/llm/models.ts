// Providers and models discovered at run time, never hardcoded: each provider is active if its access exists
// (environment variable, authenticated CLI or a local server that answers) and its model list comes from its API.
// Single model bridge of @aphrody/ai-os (agent, relay, search, gateway): `provider/model`, OpenAI-compatible
// API call (chat/completions, tools, embeddings) or by CLI; see model.ts.
//
//   provider      access                                        model list                                call
//   ollama        OLLAMA_HOST or 127.0.0.1:11434 that answers   GET /api/tags                              /v1/chat/completions
//   fabric        AI_FABRIC_URL or 127.0.0.1:8090 that answers  GET /v1/models (llama.cpp RPC coordinator) /v1/chat/completions
//   openai-compat RELAY_OPENAI_ENDPOINTS="nom=url,…" (llama.cpp llama-server, vLLM, mistral.rs, LM Studio, LiteLLM proxy…)
//                                                               GET /v1/models                             /v1/chat/completions
//   openrouter    OPENROUTER_API_KEY                            GET /api/v1/models                         /api/v1/chat/completions
//   huggingface   HF_TOKEN                                      GET router.huggingface.co/v1/models        router /v1/chat/completions
//   vercel        AI_GATEWAY_API_KEY                            GET ai-gateway.vercel.sh/v1/models         /v1/chat/completions
//   cloudflare    CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID  GET /ai/models/search (Text Generation)    /ai/v1/chat/completions
//   antigravity   authenticated agy CLI                         agy models                                 agy -p
//   claude        authenticated claude CLI                      (CLI alias)                                claude -p
import { outboundFetch } from "../relay/outbound.ts";
import { agy, claude, opencode } from "./agents";

export type Model = {
  id: string;
  provider: string;
  name?: string;
  context?: number;
};
export type Provider = {
  id: string;
  /** Runs on this machine or this fleet: free to call (router price 0). */
  local?: boolean;
  available: () => Promise<boolean>;
  list: () => Promise<Model[]>;
  chat?: {
    base: () => string;
    headers: () => Record<string, string>;
    path?: string;
  };
  ask?: (model: string, prompt: string) => Promise<string>;
};

/** Hosted bases shared with the router catalog (router/config.ts). */
export const BASES = {
  openrouter: "https://openrouter.ai/api",
  huggingface: "https://router.huggingface.co",
} as const;

const env = (k: string) => Bun.env[k];
const getJson = async (
  url: string,
  headers: Record<string, string> = {},
  ms = 4000,
) => {
  // Model lists: reads, cached for the relay's short TTL (relay/outbound.ts).
  const r = await outboundFetch(url, {
    headers,
    signal: AbortSignal.timeout(ms),
    deterministic: true,
  });
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  return r.json() as Promise<any>;
};
const run = async (argv: string[]) => {
  const p = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 15_000,
  });
  const [out, , code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, code };
};
const bearer = (k: string | undefined): Record<string, string> =>
  k ? { authorization: `Bearer ${k}` } : {};
const openaiList = (provider: string, j: any): Model[] =>
  (j.data ?? []).map((m: any) => ({
    id: `${provider}/${m.id}`,
    provider,
    name: m.name ?? m.id,
    context: m.context_length ?? m.context_window,
  }));

function compat(id: string, base: string, key?: string): Provider {
  return {
    id,
    available: async () =>
      !!(await getJson(`${base}/v1/models`, bearer(key), 1500).catch(
        () => null,
      )),
    list: async () =>
      openaiList(id, await getJson(`${base}/v1/models`, bearer(key))),
    chat: { base: () => base, headers: () => bearer(key) },
  };
}

export function providers(): Provider[] {
  const out: Provider[] = [];
  const ollama = env("OLLAMA_HOST")
    ? env("OLLAMA_HOST")!.startsWith("http")
      ? env("OLLAMA_HOST")!
      : `http://${env("OLLAMA_HOST")}`
    : "http://127.0.0.1:11434";
  out.push({
    id: "ollama",
    local: true,
    available: async () =>
      !!(await getJson(`${ollama}/api/tags`, {}, 1500).catch(() => null)),
    list: async () =>
      ((await getJson(`${ollama}/api/tags`)).models ?? []).map((m: any) => ({
        id: `ollama/${m.name}`,
        provider: "ollama",
        name: m.name,
      })),
    chat: { base: () => ollama, headers: () => ({}) },
  });
  // Distributed inference fabric (src/fabric, tools/ai/fabric.toml): llama-server coordinator + WireGuard rpc-server.
  // Gone from the list as soon as the coordinator stops answering: selection switches to the other providers.
  out.push({
    ...compat(
      "fabric",
      (env("AI_FABRIC_URL") ?? "http://127.0.0.1:8090")
        .replace(/\/+$/, "")
        .replace(/\/v1$/, ""),
    ),
    local: true,
  });
  for (const pair of (env("RELAY_OPENAI_ENDPOINTS") ?? "")
    .split(",")
    .filter(Boolean)) {
    const eq = pair.indexOf("=");
    const [name, url] = eq > 0 ? [pair.slice(0, eq), pair.slice(eq + 1)] : [];
    if (name && url)
      out.push(
        compat(
          name,
          url.replace(/\/+$/, "").replace(/\/v1$/, ""),
          env(`RELAY_${name.toUpperCase().replace(/\W/g, "_")}_KEY`),
        ),
      );
  }
  if (env("OPENAI_API_KEY"))
    out.push(
      compat(
        "openai",
        (env("OPENAI_BASE_URL") ?? "https://api.openai.com")
          .replace(/\/+$/, "")
          .replace(/\/v1$/, ""),
        env("OPENAI_API_KEY"),
      ),
    );
  if (env("ANTHROPIC_API_KEY")) {
    const abase = (env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    const aheaders = (): Record<string, string> => ({
      "x-api-key": env("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      authorization: `Bearer ${env("ANTHROPIC_API_KEY")!}`,
    });
    out.push({
      id: "anthropic",
      available: async () => true,
      list: async () =>
        openaiList(
          "anthropic",
          await getJson(`${abase}/v1/models`, aheaders()),
        ),
      chat: { base: () => abase, headers: aheaders },
    });
  }
  const gkey = env("GEMINI_API_KEY") || env("GOOGLE_API_KEY");
  if (gkey) {
    const gbase = "https://generativelanguage.googleapis.com/v1beta/openai";
    out.push({
      id: "google",
      available: async () => true,
      list: async () =>
        openaiList("google", await getJson(`${gbase}/models`, bearer(gkey))),
      chat: {
        base: () => gbase,
        headers: () => bearer(gkey),
        path: "/chat/completions",
      },
    });
  }
  if (env("OPENROUTER_API_KEY"))
    out.push({
      id: "openrouter",
      available: async () => true,
      list: async () =>
        openaiList(
          "openrouter",
          await getJson(`${BASES.openrouter}/v1/models`),
        ),
      chat: {
        base: () => BASES.openrouter,
        headers: () => bearer(env("OPENROUTER_API_KEY")),
      },
    });
  if (env("HF_TOKEN"))
    out.push(compat("huggingface", BASES.huggingface, env("HF_TOKEN")));
  if (env("AI_GATEWAY_API_KEY"))
    out.push(
      compat(
        "vercel",
        "https://ai-gateway.vercel.sh",
        env("AI_GATEWAY_API_KEY"),
      ),
    );
  if (env("CLOUDFLARE_API_TOKEN") && env("CLOUDFLARE_ACCOUNT_ID")) {
    const base = `https://api.cloudflare.com/client/v4/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}/ai`;
    out.push({
      id: "cloudflare",
      available: async () => true,
      list: async () =>
        (
          (
            await getJson(
              `${base}/models/search?task=Text%20Generation&per_page=200`,
              bearer(env("CLOUDFLARE_API_TOKEN")),
              8000,
            )
          ).result ?? []
        ).map((m: any) => ({
          id: `cloudflare/${m.name}`,
          provider: "cloudflare",
          name: m.name,
        })),
      chat: {
        base: () => base,
        headers: () => bearer(env("CLOUDFLARE_API_TOKEN")),
        path: "/v1/chat/completions",
      },
    });
  }
  out.push({
    id: "antigravity",
    available: async () => !!Bun.which("agy"),
    list: async () => {
      const r = await run(["agy", "models"]);
      if (r.code !== 0) throw new Error(`agy models : code ${r.code}`);
      return r.out
        .split(/\r?\n/)
        .map((l) => l.split("\t"))
        .filter((c) => c.length >= 2 && /^[\w.-]+$/.test(c[0]!))
        .map(([id, name]) => ({
          id: `antigravity/${id}`,
          provider: "antigravity",
          name,
        }));
    },
    ask: async (model, prompt) => (await agy(prompt, model || undefined)).text,
  });
  out.push({
    id: "claude",
    available: async () => !!Bun.which("claude"),
    list: async () => [
      {
        id: "claude/default",
        provider: "claude",
        name: "Claude Code default model",
      },
    ],
    ask: async (model, prompt) =>
      (await claude(prompt, model === "default" ? undefined : model)).text,
  });
  out.push({
    id: "opencode",
    available: async () => !!Bun.which("opencode"),
    list: async () => {
      const r = await run(["opencode", "models"]);
      if (r.code !== 0)
        return [
          {
            id: "opencode/default",
            provider: "opencode",
            name: "OpenCode default",
          },
        ];
      return r.out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^[\w.-]+\/[\w.:-]+$/.test(l))
        .map((m) => ({
          id: `opencode/${m}`,
          provider: "opencode",
          name: m,
        }));
    },
    ask: async (model, prompt) =>
      (await opencode(prompt, model === "default" ? undefined : model)).text,
  });
  return out;
}

/** Models of all active providers (unreachable providers are reported, not blocking). */
export async function listModels(filter?: string) {
  const res = await Promise.all(
    providers().map(async (p) => {
      if (!(await p.available().catch(() => false)))
        return { provider: p.id, available: false, models: [] as Model[] };
      try {
        return { provider: p.id, available: true, models: await p.list() };
      } catch (e: any) {
        return {
          provider: p.id,
          available: true,
          error: e.message,
          models: [] as Model[],
        };
      }
    }),
  );
  // Filter = case-insensitive substring (no regular expression coming from an MCP/A2A client).
  const f = filter?.toLowerCase();
  return res.map((r) => ({
    ...r,
    models: f
      ? r.models.filter((m) => m.id.toLowerCase().includes(f))
      : r.models,
  }));
}
