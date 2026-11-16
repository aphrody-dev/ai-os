// Retrieval benchmark on the research pack (39 entries = 3 items x 13 fields).
// Query per (item, field) = field description + outline item description (text not present verbatim in the entry).
// Target = entry research:<topic>/<item>#<field>. Reports P@1, R@5, MRR and select() latency per head config.
import { Context, type Embedder, hashEmbedder } from "../src/core/index";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Fields,
  fileName,
  loadYaml,
  type Outline,
  researchEntries,
} from "../src/research/index";

export const PACK = join(
  import.meta.dir,
  "..",
  "fixtures",
  "ai_foundations_to_agi",
);

/** `--embedder provider/model` (any discovered provider with /v1/embeddings), default: offline hash embedder. */
const benchEmbedder = async (): Promise<Embedder> => {
  const i = Bun.argv.indexOf("--embedder");
  if (i < 0 || !Bun.argv[i + 1]) return hashEmbedder();
  const { resolveEmbedder } = await import("../src/core/model");
  return resolveEmbedder(Bun.argv[i + 1]);
};

export const CONFIGS = {
  lexical: { lexical: 1, semantic: 0, structural: 0, recency: 0 },
  semantic: { lexical: 0, semantic: 1, structural: 0, recency: 0 },
  logit: { lexical: 0.5, semantic: 0.5, structural: 0, recency: 0 },
  rrf: { lexical: 0.5, semantic: 0.5, structural: 0, recency: 0 },
  default: undefined,
} as const;

export async function bench(embedder: Embedder = hashEmbedder()) {
  const outline = await loadYaml<Outline>(join(PACK, "outline.yaml"));
  const fields = await loadYaml<Fields>(join(PACK, "fields.yaml"));
  const ctx = new Context(
    join(mkdtempSync(join(tmpdir(), "agent-bench-")), "c.sqlite"),
    embedder,
  );
  const t0 = performance.now();
  for (const it of outline.items) {
    const data = await Bun.file(
      join(PACK, "results", `${fileName(it.name)}.json`),
    ).json();
    await ctx.ingest(researchEntries(outline.topic, data));
  }
  const ingestMs = performance.now() - t0;
  const queries = outline.items.flatMap((it) =>
    fields.required_fields
      .filter((f) => !["name", "source_url", "category"].includes(f.name))
      .map((f) => ({
        q: `${f.description} ${it.description}`,
        target: `research:${outline.topic}/${fileName(it.name)}#${f.name}`,
      })),
  );
  const out: Record<
    string,
    { p1: number; r5: number; mrr: number; msPerQuery: number }
  > = {};
  for (const [name, weights] of Object.entries(CONFIGS)) {
    let p1 = 0;
    let r5 = 0;
    let mrr = 0;
    const t = performance.now();
    for (const { q, target } of queries) {
      const sel = await ctx.select(q, {
        sources: ["research"],
        k: 10,
        budgetTokens: 1e9,
        weights,
        fusion: name === "logit" ? "logit" : "rrf",
      });
      const rank = sel.findIndex((s) => s.id === target);
      if (rank === 0) p1++;
      if (rank >= 0 && rank < 5) r5++;
      if (rank >= 0) mrr += 1 / (rank + 1);
    }
    const n = queries.length;
    out[name] = {
      p1: p1 / n,
      r5: r5 / n,
      mrr: mrr / n,
      msPerQuery: (performance.now() - t) / n,
    };
  }
  ctx.close();
  return {
    entries: outline.items.length * fields.required_fields.length,
    queries: queries.length,
    ingestMs,
    embedder: embedder.id,
    results: out,
  };
}

if (import.meta.main) {
  const emb = await benchEmbedder();
  const r = await bench(emb);
  console.log(
    `embedder=${r.embedder} entries=${r.entries} queries=${r.queries} ingest=${r.ingestMs.toFixed(0)}ms`,
  );
  for (const [k, v] of Object.entries(r.results))
    console.log(
      `${k.padEnd(9)} P@1=${v.p1.toFixed(3)} R@5=${v.r5.toFixed(3)} MRR=${v.mrr.toFixed(3)} ${v.msPerQuery.toFixed(2)}ms/query`,
    );
}

type Q = { q: string; target: string; item: string };
type Cfg = {
  weights: {
    lexical: number;
    semantic: number;
    structural: number;
    recency: number;
  };
  fusion: "rrf" | "logit";
};

async function evalCfg(ctx: Context, qs: Q[], c: Cfg) {
  let r5 = 0;
  let mrr = 0;
  for (const { q, target } of qs) {
    const sel = await ctx.select(q, {
      sources: ["research"],
      k: 10,
      budgetTokens: 1e9,
      weights: c.weights,
      fusion: c.fusion,
    });
    const rank = sel.findIndex((s) => s.id === target);
    if (rank >= 0 && rank < 5) r5++;
    if (rank >= 0) mrr += 1 / (rank + 1);
  }
  return { r5: r5 / qs.length, mrr: mrr / qs.length };
}

export const GRID: Cfg[] = (["rrf", "logit"] as const).flatMap((fusion) =>
  Array.from({ length: 11 }, (_, i) => ({
    fusion,
    weights: {
      lexical: i / 10,
      semantic: 1 - i / 10,
      structural: 0,
      recency: 0,
    },
  })),
);

/** Learn head weights + fusion by grid search (objective R@5 then MRR). Reports in-sample and leave-one-item-out CV. */
export async function tune(embedder: Embedder = hashEmbedder()) {
  const outline = await loadYaml<Outline>(join(PACK, "outline.yaml"));
  const fields = await loadYaml<Fields>(join(PACK, "fields.yaml"));
  const ctx = new Context(
    join(mkdtempSync(join(tmpdir(), "agent-tune-")), "c.sqlite"),
    embedder,
  );
  for (const it of outline.items)
    await ctx.ingest(
      researchEntries(
        outline.topic,
        await Bun.file(
          join(PACK, "results", `${fileName(it.name)}.json`),
        ).json(),
      ),
    );
  const qs: Q[] = outline.items.flatMap((it) =>
    fields.required_fields
      .filter((f) => !["name", "source_url", "category"].includes(f.name))
      .map((f) => ({
        q: `${f.description} ${it.description}`,
        target: `research:${outline.topic}/${fileName(it.name)}#${f.name}`,
        item: it.name,
      })),
  );
  const best = async (train: Q[]) => {
    let b: { c: Cfg; r5: number; mrr: number } | undefined;
    for (const c of GRID) {
      const m = await evalCfg(ctx, train, c);
      if (!b || m.r5 > b.r5 || (m.r5 === b.r5 && m.mrr > b.mrr))
        b = { c, ...m };
    }
    return b!;
  };
  const inSample = await best(qs);
  let cvHits = 0;
  for (const it of outline.items) {
    const train = qs.filter((q) => q.item !== it.name);
    const test = qs.filter((q) => q.item === it.name);
    const b = await best(train);
    cvHits += (await evalCfg(ctx, test, b.c)).r5 * test.length;
  }
  ctx.close();
  return { inSample, cvR5: cvHits / qs.length };
}

if (import.meta.main && Bun.argv.includes("--tune")) {
  const emb = await benchEmbedder();
  const t = await tune(emb);
  console.log(
    `tuned ${t.inSample.c.fusion} lexical=${t.inSample.c.weights.lexical} semantic=${t.inSample.c.weights.semantic} R@5=${t.inSample.r5.toFixed(3)} MRR=${t.inSample.mrr.toFixed(3)} | leave-one-item-out R@5=${t.cvR5.toFixed(3)}`,
  );
}

/** Large eval: research pack (30) + src docs headings (bench/srcdocs.ts, local cache). Reports single heads, default,
 * and grid-tuned fusion with 2-fold cross-validation (folds split by query index parity). */
export async function evalLarge(embedder: Embedder = hashEmbedder()) {
  const { CACHE } = await import("./srcdocs");
  const outline = await loadYaml<Outline>(join(PACK, "outline.yaml"));
  const fields = await loadYaml<Fields>(join(PACK, "fields.yaml"));
  const ctx = new Context(
    join(mkdtempSync(join(tmpdir(), "agent-eval-")), "c.sqlite"),
    embedder,
  );
  for (const it of outline.items)
    await ctx.ingest(
      researchEntries(
        outline.topic,
        await Bun.file(
          join(PACK, "results", `${fileName(it.name)}.json`),
        ).json(),
      ),
    );
  const qs: { q: string; target: string }[] = outline.items.flatMap((it) =>
    fields.required_fields
      .filter((f) => !["name", "source_url", "category"].includes(f.name))
      .map((f) => ({
        q: `${f.description} ${it.description}`,
        target: `research:${outline.topic}/${fileName(it.name)}#${f.name}`,
      })),
  );
  const f = Bun.file(CACHE);
  if (await f.exists()) {
    const set = (await f.json()) as import("./srcdocs").EvalSet;
    for (let i = 0; i < set.entries.length; i += 64)
      await ctx.ingest(
        set.entries
          .slice(i, i + 64)
          .map((e) => ({ ...e, source: "doc" as const, scope: "src" })),
      );
    qs.push(...set.queries);
  }
  const sources = ["research", "doc"];
  const run = async (
    sub: typeof qs,
    c: Cfg | { weights?: undefined; fusion?: undefined },
  ) => {
    let r5 = 0;
    let mrr = 0;
    const t = performance.now();
    for (const { q, target } of sub) {
      const sel = await ctx.select(q, {
        sources,
        k: 10,
        budgetTokens: 1e9,
        weights: c.weights,
        fusion: c.fusion,
      });
      const rank = sel.findIndex((s) => s.id === target);
      if (rank >= 0 && rank < 5) r5++;
      if (rank >= 0) mrr += 1 / (rank + 1);
    }
    return {
      r5: r5 / sub.length,
      mrr: mrr / sub.length,
      ms: (performance.now() - t) / sub.length,
    };
  };
  const single = {
    lexical: await run(qs, {
      fusion: "rrf",
      weights: { lexical: 1, semantic: 0, structural: 0, recency: 0 },
    }),
    semantic: await run(qs, {
      fusion: "rrf",
      weights: { lexical: 0, semantic: 1, structural: 0, recency: 0 },
    }),
    default: await run(qs, {}),
  };
  const folds = [
    qs.filter((_, i) => i % 2 === 0),
    qs.filter((_, i) => i % 2 === 1),
  ];
  let cvHits = 0;
  const picks: string[] = [];
  for (const [a, b] of [
    [0, 1],
    [1, 0],
  ] as const) {
    let best: { c: Cfg; r5: number; mrr: number } | undefined;
    for (const c of GRID) {
      const m = await run(folds[a]!, c);
      if (!best || m.r5 > best.r5 || (m.r5 === best.r5 && m.mrr > best.mrr))
        best = { c, ...m };
    }
    picks.push(
      `${best!.c.fusion}:${best!.c.weights.lexical}/${best!.c.weights.semantic}`,
    );
    cvHits += (await run(folds[b]!, best!.c)).r5 * folds[b]!.length;
  }
  ctx.close();
  return {
    queries: qs.length,
    embedder: embedder.id,
    single,
    cvTunedR5: cvHits / qs.length,
    picks,
  };
}

if (import.meta.main && Bun.argv.includes("--eval")) {
  const emb = await benchEmbedder();
  const r = await evalLarge(emb);
  console.log(`eval embedder=${r.embedder} queries=${r.queries}`);
  for (const [k, v] of Object.entries(r.single))
    console.log(
      `${k.padEnd(9)} R@5=${v.r5.toFixed(3)} MRR=${v.mrr.toFixed(3)} ${v.ms.toFixed(1)}ms/q`,
    );
  console.log(
    `tuned (2-fold CV) R@5=${r.cvTunedR5.toFixed(3)} picks=${r.picks.join(",")}`,
  );
}
