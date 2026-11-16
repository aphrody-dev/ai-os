// Minimal JSON Schema builders and validator (replaces zod): tool inputs are declared once as JSON Schema,
// sent as-is to the model and to MCP clients, and checked before a tool runs.
import type { JsonSchema } from "./types";

type Props = Record<string, JsonSchema>;

export const s = {
  string: (
    description?: string,
    extra: Partial<JsonSchema> = {},
  ): JsonSchema => ({
    type: "string",
    ...(description ? { description } : {}),
    ...extra,
  }),
  number: (description?: string): JsonSchema => ({
    type: "number",
    ...(description ? { description } : {}),
  }),
  boolean: (description?: string): JsonSchema => ({
    type: "boolean",
    ...(description ? { description } : {}),
  }),
  array: (items: JsonSchema, extra: Partial<JsonSchema> = {}): JsonSchema => ({
    type: "array",
    items,
    ...extra,
  }),
  enum: (values: readonly string[], description?: string): JsonSchema => ({
    type: "string",
    enum: values,
    ...(description ? { description } : {}),
  }),
  /** Object schema; every property is required unless listed in `optional`. */
  object: (properties: Props, optional: string[] = []): JsonSchema => ({
    type: "object",
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  }),
};

/** Returns the list of violations (empty when `value` matches `schema`). */
export function validate(
  schema: JsonSchema,
  value: unknown,
  path = "$",
): string[] {
  const out: string[] = [];
  const t = schema.type;
  const kind = Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : typeof value;
  const bad =
    t === "integer"
      ? !Number.isInteger(value)
      : t === "number"
        ? typeof value !== "number" || !Number.isFinite(value)
        : t && t !== kind;
  if (bad) return [`${path}: expected ${t}, got ${kind}`];
  if (schema.enum && !schema.enum.includes(value))
    out.push(`${path}: not one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      out.push(`${path}: shorter than ${schema.minLength}`);
    if (
      (schema.format === "uri" || schema.format === "url") &&
      !URL.canParse(value)
    )
      out.push(`${path}: not a URL`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      out.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items)
      value.forEach((v, i) =>
        out.push(...validate(schema.items!, v, `${path}[${i}]`)),
      );
  }
  if (kind === "object") {
    // Own keys only: "constructor" or "toString" must not resolve through Object.prototype.
    const o = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const k of schema.required ?? [])
      if (!Object.hasOwn(o, k) || o[k] === undefined)
        out.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue; // absent optional property
      const p = Object.hasOwn(props, k) ? props[k] : undefined;
      if (p) out.push(...validate(p, v, `${path}.${k}`));
      else if (schema.additionalProperties === false)
        out.push(`${path}.${k}: unexpected`);
    }
  }
  return out;
}
