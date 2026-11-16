// Copyright 2026 Aphrody. Licensed under the Apache License, Version 2.0.
//
// Minimal input validation for the absorbed stitch-sdk spec modules (upstream used zod). `schema(fn)`
// returns an object with zod's `parse` (throws) and `safeParse` (returns { success, data | error }).

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZodError";
  }
}

const fail = (path: string, want: string, raw = false): never => {
  throw new SchemaError(raw ? want : `${path}: expected ${want}`);
};

export const check = {
  fail,
  obj(v: unknown, p: string): Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : fail(p, "object");
  },
  str(v: unknown, p: string, min = 0): string {
    if (typeof v !== "string") fail(p, "string");
    if ((v as string).length < min)
      fail(p, `string of at least ${min} character(s)`);
    return v as string;
  },
  num(v: unknown, p: string): number {
    return typeof v === "number" && !Number.isNaN(v) ? v : fail(p, "number");
  },
  int(v: unknown, p: string): number {
    return Number.isInteger(v) ? (v as number) : fail(p, "integer");
  },
  bool(v: unknown, p: string): boolean {
    return typeof v === "boolean" ? v : fail(p, "boolean");
  },
  url(v: unknown, p: string): string {
    const s = check.str(v, p);
    if (!URL.canParse(s)) fail(p, "URL");
    return s;
  },
  strRecord(v: unknown, p: string): Record<string, string> {
    const o = check.obj(v, p);
    for (const [k, x] of Object.entries(o)) check.str(x, `${p}.${k}`);
    return o as Record<string, string>;
  },
};

export type Schema<T> = {
  parse(input: unknown): T;
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: SchemaError };
};

export function schema<T>(build: (v: Record<string, unknown>) => T): Schema<T> {
  const parse = (input: unknown): T => build(check.obj(input, "(input)"));
  return {
    parse,
    safeParse(input) {
      try {
        return { success: true, data: parse(input) };
      } catch (e) {
        if (e instanceof SchemaError) return { success: false, error: e };
        throw e;
      }
    },
  };
}
