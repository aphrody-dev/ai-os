// MCP / A2A / JSON-RPC tools of the router (merged into the relay tool list, relay/tools.ts).
import { s } from "../llm/schema.ts";
import type { Tool } from "../relay/tools.ts";
import { router } from "./index.ts";

const slim = (o: any) => ({
  id: o.id,
  context: o.context,
  tools: o.tools,
  priceIn: o.priceIn,
  priceOut: o.priceOut,
  arena: o.arena && Math.round(o.arena),
  cli: o.cli || undefined,
});

export const ROUTER_TOOLS: Tool[] = [
  {
    name: "router_models",
    description:
      "Router catalog: every routable model offer (provider/model) joined with models.dev, litellm, OpenRouter, Hugging Face router and Arena data (context, price per Mtok, tools, arena rating). Filter by substring or provider; refresh re-reads the live sources.",
    inputSchema: s.object(
      {
        filter: s.string("Substring of the id (optional)"),
        provider: s.string("Provider id (optional)"),
        limit: s.number("Max rows (default 100)"),
        refresh: s.boolean("Re-read the live sources first (optional)"),
      },
      ["filter", "provider", "limit", "refresh"],
    ),
    readOnly: true,
    run: async (a) => {
      const r = router();
      const cat = await r.catalog(a.refresh === true);
      const f = String(a.filter ?? "").toLowerCase();
      const rows = cat.offers.filter(
        (o) =>
          (!f || o.id.toLowerCase().includes(f)) &&
          (!a.provider || o.provider === a.provider),
      );
      return {
        total: cat.offers.length,
        matched: rows.length,
        sources: cat.report,
        providers: cat.providers,
        offers: rows.slice(0, Number(a.limit ?? 100)).map(slim),
      };
    },
  },
  {
    name: "router_route",
    description:
      "Explain a routing choice without calling any model: the policy a `model` resolves to (exact, bare name, auto, auto:cheap, auto:fast, auto:code, auto:long, arena) and the ordered offers the failover walk would try, with health and latency.",
    inputSchema: s.object(
      {
        model: s.string(
          "provider/model, bare name, auto[:cheap|fast|code|long] or arena",
        ),
        tools: s.boolean("Request uses tools (optional)"),
        limit: s.number("Offers shown (default 10)"),
      },
      ["tools", "limit"],
    ),
    readOnly: true,
    run: async (a) => {
      const r = router();
      const { policy, offers, need } = await r.route(
        String(a.model),
        undefined,
        { tools: a.tools === true },
      );
      const st = r.store.stats();
      return {
        policy,
        need,
        order: offers.slice(0, Number(a.limit ?? 10)).map((o) => ({
          ...slim(o),
          health: st.get(o.id)?.health,
          p50: st.get(o.id)?.p50,
          cooling: (st.get(o.id)?.coolUntil ?? 0) > Date.now() || undefined,
        })),
        candidates: offers.length,
      };
    },
  },
  {
    name: "router_leaderboard",
    description:
      "Leaderboards: local Elo from router arena battles (votes by users, agents or a judge model) and the public Arena rating, per model.",
    inputSchema: s.object({ limit: s.number("Rows per board (default 25)") }, [
      "limit",
    ]),
    readOnly: true,
    run: async (a) => router().leaderboard(Number(a.limit ?? 25)),
  },
  {
    name: "router_vote",
    description:
      'Vote on an arena pair (model:"arena" returns pair_id). winner: "a" = the answer that was returned, "b" = the hidden one, "tie". Without winner, a judge model (judge, default a fast one) reads both answers and votes. Returns the new Elo.',
    inputSchema: s.object(
      {
        pair: s.string("pair_id from the arena answer"),
        winner: s.enum(["a", "b", "tie"], "Vote (optional with a judge)"),
        judge: s.string("Judge model provider/model (optional)"),
        by: s.string("Voter label (optional)"),
      },
      ["winner", "judge", "by"],
    ),
    readOnly: false,
    run: async (a) => {
      const r = router();
      if (!a.winner) return r.judge(String(a.pair), a.judge);
      return r.store.vote(String(a.pair), a.winner, String(a.by ?? "mcp"));
    },
  },
  {
    name: "router_stats",
    description:
      "Per-offer stats (decayed health, p50 latency, calls, errors, tokens, cost, cooldown) and spend per caller token; set or clear a caller budget in USD with budget.",
    inputSchema: s.object(
      {
        caller: s.string("Caller key to set a budget for (optional)"),
        budget: s.number("Budget in USD; negative clears (optional)"),
      },
      ["caller", "budget"],
    ),
    readOnly: false,
    run: async (a) => {
      const r = router();
      if (a.caller && typeof a.budget === "number")
        r.store.setBudget(String(a.caller), a.budget < 0 ? null : a.budget);
      const st = r.stats();
      return {
        offers: Object.entries(st)
          .map(([id, v]) => ({
            id,
            ...v,
            health: Number(v.health.toFixed(3)),
            cost: Number(v.cost.toFixed(6)),
          }))
          .sort((x, y) => y.calls - x.calls)
          .slice(0, 100),
        callers: r.store
          .callers()
          .map((c) => ({ ...c, budget: r.store.budget(c.caller) })),
      };
    },
  },
];
