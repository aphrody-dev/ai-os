// Structured review output: JSON schema, validation, tolerant extraction, rendering to the verdict markdown.
// The engine is asked for JSON (response_format json_schema on bridge models, instruction on agent CLIs); the answer
// is parsed and validated here, never scraped. A custom schema (config/review.json "schema") must keep the fields
// `score` (number) and, if it reports defects, `findings` (array of objects with file, line, severity, title, breaks,
// fix, source).

export type Schema = Record<string, any>;

export const DEFAULT_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "verdict", "findings", "to_confirm", "summary"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 20 },
    verdict: { type: "string", enum: ["approve", "changes", "reject"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "file",
          "line",
          "severity",
          "title",
          "breaks",
          "fix",
          "source",
        ],
        properties: {
          file: { type: "string" },
          line: { type: "integer", minimum: 0 },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string", minLength: 1 },
          breaks: { type: "string" },
          fix: { type: "string" },
          source: { type: "string" },
        },
      },
    },
    to_confirm: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};

/** Keywords Gemini-family response schemas are known to accept; the rest is validated locally only. */
const WIRE_DROP = new Set([
  "additionalProperties",
  "$schema",
  "$comment",
  "$id",
]);
export function wireSchema(s: unknown): any {
  if (Array.isArray(s)) return s.map(wireSchema);
  if (s && typeof s === "object")
    return Object.fromEntries(
      Object.entries(s)
        .filter(([k]) => !WIRE_DROP.has(k))
        .map(([k, v]) => [k, wireSchema(v)]),
    );
  return s;
}

const typeOk = (t: string, v: unknown) =>
  t === "integer"
    ? Number.isInteger(v)
    : t === "number"
      ? typeof v === "number" && Number.isFinite(v)
      : t === "array"
        ? Array.isArray(v)
        : t === "object"
          ? !!v && typeof v === "object" && !Array.isArray(v)
          : t === "null"
            ? v === null
            : typeof v === t;

/** Small JSON-schema validator (type, enum, required, properties, items, minimum, maximum, minLength,
 * additionalProperties:false): the subset the review schemas use. Returns one message per violation. */
export function validate(s: Schema, v: unknown, at = "$"): string[] {
  const errs: string[] = [];
  const types = s.type === undefined ? [] : [s.type].flat();
  if (types.length && !types.some((t: string) => typeOk(t, v)))
    return [`${at}: expected ${types.join("|")}`];
  if (s.enum && !s.enum.includes(v))
    errs.push(`${at}: not one of ${s.enum.join(", ")}`);
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum)
      errs.push(`${at}: below ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum)
      errs.push(`${at}: above ${s.maximum}`);
  }
  if (
    typeof v === "string" &&
    s.minLength !== undefined &&
    v.length < s.minLength
  )
    errs.push(`${at}: shorter than ${s.minLength}`);
  if (Array.isArray(v) && s.items)
    v.forEach((x, i) => errs.push(...validate(s.items, x, `${at}[${i}]`)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? [])
      if (!(k in o)) errs.push(`${at}.${k}: missing`);
    for (const [k, sub] of Object.entries<Schema>(s.properties ?? {}))
      if (k in o) errs.push(...validate(sub, o[k], `${at}.${k}`));
    if (s.additionalProperties === false)
      for (const k of Object.keys(o))
        if (!(k in (s.properties ?? {}))) errs.push(`${at}.${k}: unexpected`);
  }
  return errs;
}

export type ReviewFinding = {
  file: string;
  line: number;
  severity: string;
  title: string;
  breaks: string;
  fix: string;
  source: string;
};
export type StructuredReview = {
  score: number;
  verdict: string;
  findings: ReviewFinding[];
  to_confirm: string[];
  summary: string;
};
export type Parsed =
  | { ok: true; review: StructuredReview; partial: boolean; warnings: string[] }
  | { ok: false; error: string; truncated: boolean };

/** First JSON object of a text (prose and code fences around it are tolerated); `truncated` when it never closes. */
export function extractJson(text: string): {
  json?: unknown;
  truncated: boolean;
  error?: string;
} {
  const t = text.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  if (start < 0) return { truncated: false, error: "no JSON object" };
  let depth = 0;
  let inStr = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return { json: JSON.parse(t.slice(start, i + 1)), truncated: false };
      } catch (e: any) {
        return {
          truncated: false,
          error: `invalid JSON: ${String(e.message).slice(0, 80)}`,
        };
      }
    }
  }
  return { truncated: true, error: "truncated JSON (unterminated object)" };
}

/**
 * Parses and validates a review. Top-level fields must satisfy the schema; findings that violate it are dropped and
 * reported as `partial` (the caller never treats a partial review as a passed gate).
 */
export function parseReview(
  text: string,
  schema: Schema = DEFAULT_SCHEMA,
): Parsed {
  const x = extractJson(text);
  if (x.json === undefined)
    return { ok: false, error: x.error ?? "no JSON", truncated: x.truncated };
  const o = x.json as Record<string, any>;
  const itemSchema: Schema | undefined = schema.properties?.findings?.items;
  const rest: Schema = {
    ...schema,
    properties: {
      ...schema.properties,
      ...(schema.properties?.findings
        ? { findings: { ...schema.properties.findings, items: undefined } }
        : {}),
    },
  };
  const errs = validate(rest, {
    ...o,
    findings: Array.isArray(o.findings) ? [] : o.findings,
  });
  if (typeof o.score !== "number")
    errs.push("$.score: missing or not a number");
  if (errs.length)
    return { ok: false, error: errs.slice(0, 5).join("; "), truncated: false };
  const warnings: string[] = [];
  const findings: ReviewFinding[] = [];
  (Array.isArray(o.findings) ? o.findings : []).forEach(
    (f: unknown, i: number) => {
      const e = itemSchema ? validate(itemSchema, f, `$.findings[${i}]`) : [];
      if (e.length) warnings.push(e.slice(0, 2).join("; "));
      else findings.push(f as ReviewFinding);
    },
  );
  return {
    ok: true,
    review: {
      score: o.score,
      verdict: String(o.verdict ?? ""),
      findings,
      to_confirm: Array.isArray(o.to_confirm) ? o.to_confirm.map(String) : [],
      summary: String(o.summary ?? ""),
    },
    partial: warnings.length > 0,
    warnings,
  };
}

const cell = (s: unknown) =>
  String(s ?? "")
    .replace(/[\r\n|]+/g, " ")
    .trim();

/** Verdict markdown of a structured review: same contract as the legacy format (Score line, Defects table). */
export function renderReview(
  r: StructuredReview,
  warnings: string[] = [],
): string {
  return [
    `Score: ${r.score}/20`,
    `Verdict: ${r.verdict || "-"}`,
    "## Defects",
    "| # | file:line | severity | defect | fix | source |",
    "|---|---|---|---|---|---|",
    ...r.findings.map(
      (f, i) =>
        `| ${i + 1} | ${cell(f.file)}${f.line ? `:${f.line}` : ""} | ${cell(f.severity)} | ${cell(f.title)}${f.breaks ? ` (breaks: ${cell(f.breaks)})` : ""} | ${cell(f.fix)} | ${cell(f.source) || "-"} |`,
    ),
    "## To confirm",
    ...(r.to_confirm.length
      ? r.to_confirm.map((x) => `- ${cell(x)}`)
      : ["- none"]),
    ...(warnings.length
      ? ["## Dropped findings", ...warnings.map((w) => `- ${cell(w)}`)]
      : []),
    "## Summary",
    r.summary.trim() || "-",
  ].join("\n");
}
