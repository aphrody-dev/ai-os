// Deep-research pipeline. Generalizes var/data/ai_foundations_to_agi:
// outline.yaml (topic, execution.batch_size, items[]) + fields.yaml (required_fields with types) ->
// one subagent per item (batch_size in parallel) -> results/<item>.json -> validated -> fed to agent memory.
// validate() is a port of validate_json.py.
import { generateText, tool } from "../llm/generate";
import { s, validate as checkSchema } from "../llm/schema";
import type { JsonSchema, LanguageModel } from "../llm/types";
import { Memory } from "../core/memory";
import { redactText } from "../core/secrets";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { context7Tools } from "./context7";

export type Item = {
  name: string;
  category?: string;
  source_url?: string;
  description?: string;
  [k: string]: unknown;
};
export type Outline = {
  topic: string;
  description?: string;
  execution?: {
    batch_size?: number;
    items_per_agent?: number;
    output_dir?: string;
  };
  items: Item[];
};
export type Field = { name: string; type: string; description?: string };
export type Fields = { schema_version?: string; required_fields: Field[] };

export const UNCERTAIN = "[uncertain]";

/** Encoder input: one Context entry per (item, field); id `research:<topic>/<item>#<field>`, scope `research:<topic>`. */
export function researchEntries(topic: string, data: Record<string, unknown>) {
  const item = String(data.name ?? "item");
  return Object.entries(data)
    .filter(
      ([k, v]) =>
        k !== "uncertain" && k !== "name" && v !== undefined && v !== "",
    )
    .map(([field, v]) => ({
      id: `research:${topic}/${fileName(item)}#${field}`,
      source: "research" as const,
      scope: `research:${topic}`,
      title: `${item} / ${field}`,
      text: Array.isArray(v) ? v.join("\n") : String(v),
    }));
}

export const fileName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export async function loadYaml<T>(path: string): Promise<T> {
  return Bun.YAML.parse(await Bun.file(path).text()) as T;
}

/** Port of validate_json.py: every required field non-empty, `uncertain` array equals the set of fields carrying [uncertain]. */
export function validate(
  fields: Fields,
  data: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const required = fields.required_fields.map((f) => f.name);
  const empty = (v: unknown) =>
    v === undefined ||
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0);
  const missing = required.filter((k) => empty(data[k]));
  const unc = data.uncertain;
  if (!Array.isArray(unc)) missing.push("uncertain (array)");
  const marked = required.filter((k) => {
    const v = data[k];
    return typeof v === "string"
      ? v.includes(UNCERTAIN)
      : Array.isArray(v) &&
          v.some((x) => typeof x === "string" && x.includes(UNCERTAIN));
  });
  const errors: string[] = [];
  const declared = new Set(Array.isArray(unc) ? (unc as string[]) : []);
  if (marked.length !== declared.size || marked.some((m) => !declared.has(m)))
    errors.push(
      `mismatch between ${UNCERTAIN} markers [${marked}] and uncertain array [${[...declared]}]`,
    );
  if (missing.length) errors.push(`missing fields: ${missing.join(", ")}`);
  return { ok: errors.length === 0, errors };
}

export function schemaFor(fields: Fields): JsonSchema {
  const props: Record<string, JsonSchema> = {};
  for (const f of fields.required_fields) {
    const base = /^list/.test(f.type)
      ? s.array(s.string(), { minItems: 1 })
      : s.string(undefined, { minLength: 1 });
    props[f.name] = f.description
      ? { ...base, description: f.description }
      : base;
  }
  props.uncertain = {
    ...s.array(s.string()),
    description: `Names of fields whose value contains the marker ${UNCERTAIN}.`,
  };
  return { ...s.object(props), additionalProperties: true };
}

const fetchUrl = tool({
  description: "Fetch a web page or API and return its text (truncated).",
  inputSchema: s.object({ url: s.string(undefined, { format: "uri" }) }),
  execute: async ({ url }) => {
    const r = await fetch(url, {
      headers: { "user-agent": "agent-research/0.1" },
      signal: AbortSignal.timeout(30_000),
    });
    const t = await r.text();
    return `${r.status}\n${t
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 40_000)}`;
  },
});

export type ResearchOptions = {
  outlinePath: string;
  fieldsPath?: string;
  model: LanguageModel;
  home?: string;
  batchSize?: number;
  maxSteps?: number;
  retries?: number;
  web?: boolean;
  onItem?: (e: {
    item: string;
    ok: boolean;
    path: string;
    errors: string[];
  }) => void;
};

async function researchItem(
  o: ResearchOptions,
  outline: Outline,
  fields: Fields,
  item: Item,
  outDir: string,
) {
  const schema = schemaFor(fields);
  const path = join(outDir, `${fileName(item.name)}.json`);
  const today = new Date().toISOString().slice(0, 10);
  let feedback = "";
  let errors: string[] = [];
  const system = [
    `You are a research subagent on the topic "${outline.topic}". ${outline.description ?? ""}`,
    `Today is ${today}. Be rigorous. When a fact is not verified from a source you read, append ${UNCERTAIN} to that value and list the field name in "uncertain".`,
  ].join("\n");
  // Phase 1 (web tools): gather notes. Phase 2 (no tools): emit JSON. Split because providers differ on tools + structured output.
  let notes = "";
  if (o.web !== false) {
    const g = await generateText({
      model: o.model,
      system: `${system}
Use fetch_url on the source URL and primary references, then write dense research notes with citations.`,
      prompt: `Item:
${JSON.stringify(item, null, 2)}`,
      tools: { fetch_url: fetchUrl, ...context7Tools },
      maxSteps: o.maxSteps ?? 8,
    });
    notes = g.text;
  }
  const keys = fields.required_fields
    .map((f) => `- ${f.name} (${f.type}): ${f.description ?? ""}`)
    .join("\n");
  for (let attempt = 0; attempt <= (o.retries ?? 1); attempt++) {
    const r = await generateText({
      model: o.model,
      system,
      maxOutputTokens: 16_000,
      prompt: `Item:
${JSON.stringify(item, null, 2)}

Notes:
${notes || "(none)"}

Return ONLY one JSON object with these keys (list types are arrays of strings) plus "uncertain" (array of field names):
${keys}${feedback}`,
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = m ? JSON.parse(m[0]) : {};
    } catch {}
    const bad = checkSchema(schema, parsed);
    const data = {
      ...parsed,
      name: item.name,
      source_url: item.source_url ?? parsed.source_url,
      category: item.category ?? parsed.category,
    };
    const v = validate(fields, data);
    errors = [
      ...v.errors,
      ...(bad.length ? [`schema: ${bad.join(", ")}`] : []),
    ];
    await Bun.write(
      path,
      `${redactText(JSON.stringify(data, null, 2))}
`,
    );
    if (v.ok) return { path, ok: true, errors: [], data };
    await Bun.write(`${path}.raw.txt`, r.text);
    errors.push(`finish=${r.finishReason} chars=${r.text.length}`);
    feedback = `

Previous attempt failed validation: ${errors.join("; ")}. Fix it.`;
  }
  return { path, ok: false, errors, data: undefined };
}

export async function research(o: ResearchOptions) {
  const outlinePath = resolve(o.outlinePath);
  const base = dirname(outlinePath);
  const outline = await loadYaml<Outline>(outlinePath);
  const fields = await loadYaml<Fields>(
    o.fieldsPath ?? join(base, "fields.yaml"),
  );
  const outDir = resolve(base, outline.execution?.output_dir ?? "results");
  mkdirSync(outDir, { recursive: true });
  const batch = Math.max(1, o.batchSize ?? outline.execution?.batch_size ?? 3);
  if (o.home) mkdirSync(o.home, { recursive: true });
  const memory = o.home ? new Memory(join(o.home, "memory.sqlite")) : undefined;
  const results: {
    item: string;
    ok: boolean;
    path: string;
    errors: string[];
  }[] = [];
  try {
    for (let i = 0; i < outline.items.length; i += batch) {
      const chunk = outline.items.slice(i, i + batch);
      const done = await Promise.all(
        chunk.map(async (item) => {
          try {
            return {
              item: item.name,
              ...(await researchItem(o, outline, fields, item, outDir)),
            };
          } catch (e) {
            return {
              item: item.name,
              ok: false,
              path: "",
              errors: [e instanceof Error ? e.message : String(e)],
              data: undefined,
            };
          }
        }),
      );
      for (const d of done) {
        if (d.ok && d.data && memory) {
          await memory.ctx.ingest(researchEntries(outline.topic, d.data));
        }
        const e = { item: d.item, ok: d.ok, path: d.path, errors: d.errors };
        results.push(e);
        o.onItem?.(e);
      }
    }
  } finally {
    memory?.close();
  }
  return {
    topic: outline.topic,
    outDir,
    results,
    passed: results.filter((r) => r.ok).length,
  };
}

/** Validate existing results/*.json against fields.yaml (CLI: agent research --validate). */
export async function validateDir(outlinePath: string, fieldsPath?: string) {
  const base = dirname(resolve(outlinePath));
  const outline = await loadYaml<Outline>(resolve(outlinePath));
  const fields = await loadYaml<Fields>(
    fieldsPath ?? join(base, "fields.yaml"),
  );
  const outDir = resolve(base, outline.execution?.output_dir ?? "results");
  const out: { file: string; ok: boolean; errors: string[] }[] = [];
  for (const f of new Bun.Glob("*.json").scanSync(outDir)) {
    out.push({
      file: f,
      ...validate(fields, await Bun.file(join(outDir, f)).json()),
    });
  }
  return out;
}

export {
  CONTEXT7_BASE,
  context7Tools,
  getLibraryDocs,
  searchLibraries,
} from "./context7";
export { factCheck, factCheckReport, type Verdict } from "./factcheck";
export { fetchUrl };
