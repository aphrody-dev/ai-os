// Policy: turns the `model` field into an ordered list of offers (best first). Pure: stats and the clock are inputs.
//   provider/model   that offer, then the same model elsewhere (cheapest first), then the auto order
//   <bare name>      every offer of that model, cheapest healthy first, then the auto order
//   auto             best arena rating (within budget)      auto:cheap  lowest price
//   auto:fast        lowest measured p50 latency            auto:code   arena coding-category rating
//   auto:long        largest context                        arena       two different offers (engine.arena)
// Unknown names fall back to `auto`: something always answers.
import { type Offer, norm } from "./catalog.ts";
import type { OfferStat } from "./stats.ts";

export type Mode = "best" | "cheap" | "fast" | "code" | "long";
export type Policy =
  | { kind: "exact"; id: string }
  | { kind: "name"; key: string }
  | { kind: "auto"; mode: Mode }
  | { kind: "arena" };

export type Need = {
  tools?: boolean;
  vision?: boolean;
  /** Estimated prompt tokens + requested output, to filter by context. */
  tokens?: number;
  /** Largest acceptable cost of this call (USD): `auto*` drop offers priced above it. */
  maxCost?: number;
  outTokens?: number;
  strict?: boolean;
};

const MODES: Record<string, Mode> = {
  "": "best",
  best: "best",
  cheap: "cheap",
  fast: "fast",
  code: "code",
  long: "long",
};

/** Virtual model ids the router answers to (listed by GET /v1/models), derived from the modes above. */
export const VIRTUAL = [
  "auto",
  ...Object.keys(MODES)
    .filter((k) => k && k !== "best")
    .map((k) => `auto:${k}`),
  "arena",
];

export function parsePolicy(spec: string | undefined, offers: Offer[]): Policy {
  const s = (spec ?? "auto").trim();
  if (s === "arena") return { kind: "arena" };
  if (s === "auto" || s.startsWith("auto:")) {
    const m = MODES[s.slice(5)];
    return { kind: "auto", mode: m ?? "best" };
  }
  const exact =
    offers.find((o) => o.id === s) ??
    offers.find((o) => o.id.toLowerCase() === s.toLowerCase());
  if (exact) return { kind: "exact", id: exact.id };
  const key = norm(s);
  if (offers.some((o) => o.key === key)) return { kind: "name", key };
  return { kind: "auto", mode: "best" };
}

/** Cost in USD of a call on an offer (unknown price counts as 0). */
export const cost = (o: Offer, inTok: number, outTok: number) =>
  ((o.priceIn ?? 0) * inTok + (o.priceOut ?? 0) * outTok) / 1e6;

const INF = Number.POSITIVE_INFINITY;

function comparator(mode: Mode, st: (o: Offer) => OfferStat | undefined) {
  const price = (o: Offer) =>
    o.priceOut === undefined ? INF : (o.priceIn ?? 0) * 3 + o.priceOut;
  const arena = (o: Offer) => o.arena ?? -INF;
  // Arena coding-category rating; models without one fall back to the overall rating.
  const code = (o: Offer) => o.arenaCode ?? arena(o);
  const byMode: Record<Mode, (a: Offer, b: Offer) => number> = {
    best: (a, b) => arena(b) - arena(a) || price(a) - price(b),
    cheap: (a, b) => price(a) - price(b) || arena(b) - arena(a),
    fast: (a, b) =>
      (st(a)?.p50 ?? INF) - (st(b)?.p50 ?? INF) || price(a) - price(b),
    code: (a, b) => code(b) - code(a) || price(a) - price(b),
    long: (a, b) => (b.context ?? 0) - (a.context ?? 0) || arena(b) - arena(a),
  };
  return byMode[mode];
}

/** Ordered offers for a policy. Health groups come first: healthy API, unhealthy API, healthy CLI, unhealthy CLI, cooling. */
export function order(
  offers: Offer[],
  policy: Policy,
  need: Need = {},
  stats: Map<string, OfferStat> = new Map(),
  now = Date.now(),
): Offer[] {
  const st = (o: Offer) => stats.get(o.id);
  const group = (o: Offer) => {
    const s = st(o);
    if (s && s.coolUntil > now) return 4;
    const bad = s && s.health < 0.5 ? 1 : 0;
    return (o.cli ? 2 : 0) + bad;
  };
  const fits = (o: Offer) =>
    (!need.tools || o.tools) &&
    (!need.vision || o.vision) &&
    (!need.tokens || !o.context || o.context >= need.tokens);
  let pool = offers.filter(fits);
  // Capability filters never empty the list: relax them rather than answer nothing.
  if (!pool.length) pool = offers.filter((o) => !need.tools || o.tools);
  if (!pool.length) pool = offers.slice();
  const affordable = (o: Offer) =>
    need.maxCost === undefined ||
    cost(o, need.tokens ?? 1000, need.outTokens ?? 1000) <= need.maxCost;
  const sort = (list: Offer[], mode: Mode) => {
    const c = comparator(mode, st);
    return list
      .slice()
      .sort(
        (a, b) =>
          group(a) - group(b) ||
          c(a, b) ||
          (st(b)?.health ?? 1) - (st(a)?.health ?? 1) ||
          a.id.localeCompare(b.id),
      );
  };
  const auto = (mode: Mode, within = true) => {
    const ok = within ? pool.filter(affordable) : pool;
    const first = sort(ok.length ? ok : pool, mode);
    return [
      ...first,
      ...sort(
        pool.filter((o) => !first.includes(o)),
        mode,
      ),
    ];
  };
  const dedupe = (l: Offer[]) => [...new Map(l.map((o) => [o.id, o])).values()];
  switch (policy.kind) {
    case "auto":
      return auto(policy.mode);
    case "arena":
      return auto("best");
    case "exact": {
      const o = offers.find((x) => x.id === policy.id)!;
      const same = sort(
        pool.filter((x) => x.key === o.key && x.id !== o.id),
        "cheap",
      );
      return dedupe([o, ...same, ...(need.strict ? [] : auto("best"))]);
    }
    case "name": {
      const same = sort(
        pool.filter((x) => x.key === policy.key),
        "cheap",
      );
      return dedupe([...same, ...(need.strict ? [] : auto("best"))]);
    }
  }
}
