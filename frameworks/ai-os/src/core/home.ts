// ~/.agent layout + `agent init`. Templates: OpenClaw docs/reference/templates (MIT, OpenClaw Foundation)
// merged with the Hermes Agent SOUL voice (MIT, Nous Research). Persona files form the static, cache-friendly
// system prefix; MEMORY.md is indexed into Context as doc entries.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context";

export const TEMPLATES = join(import.meta.dir, "..", "..", "templates", "home");
export const PERSONA_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
] as const;

export type Layout = {
  home: string;
  skills: string;
  memoryDb: string;
  config: string;
};

export function layout(home: string): Layout {
  return {
    home,
    skills: join(home, "skills"),
    memoryDb: join(home, "memory.sqlite"),
    config: join(home, "config.json"),
  };
}

export const DEFAULT_CONFIG = {
  context: {
    k: 8,
    budgetTokens: 4000,
    weights: { lexical: 0.2, semantic: 0.7, structural: 0.05, recency: 0.05 },
  },
  skills: { staleDays: 30, archiveDays: 90 },
};

/** Create missing home files from templates; never overwrites. Returns created paths. */
export async function init(
  home: string,
  vars: Record<string, string> = {},
): Promise<string[]> {
  const L = layout(home);
  mkdirSync(L.skills, { recursive: true });
  const made: string[] = [];
  for (const f of readdirSync(TEMPLATES)) {
    const dst = join(home, f);
    if (existsSync(dst)) continue;
    let text = await Bun.file(join(TEMPLATES, f)).text();
    for (const [k, v] of Object.entries(vars))
      text = text.replaceAll(`{{${k}}}`, v);
    await Bun.write(dst, text);
    made.push(dst);
  }
  if (!existsSync(L.config)) {
    await Bun.write(L.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    made.push(L.config);
  }
  return made;
}

export async function loadConfig(home: string): Promise<typeof DEFAULT_CONFIG> {
  const f = Bun.file(layout(home).config);
  return (await f.exists())
    ? { ...DEFAULT_CONFIG, ...(await f.json()) }
    : DEFAULT_CONFIG;
}

/** Static persona prefix (SOUL, IDENTITY, USER, AGENTS), stable across turns so provider prompt caches hit. */
export async function persona(home: string): Promise<string> {
  const parts: string[] = [];
  for (const f of PERSONA_FILES) {
    const file = Bun.file(join(home, f));
    if (await file.exists()) parts.push((await file.text()).trim());
  }
  return parts.join("\n\n");
}

/** Index MEMORY.md paragraphs as doc entries (ids are stable per paragraph index). */
export async function indexHomeDocs(home: string, ctx: Context) {
  const f = Bun.file(join(home, "MEMORY.md"));
  if (!(await f.exists())) return 0;
  const paras = (await f.text())
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("# "));
  await ctx.ingest(
    paras.map((text, i) => ({
      id: `doc:MEMORY.md#${i}`,
      source: "doc",
      scope: "user",
      title: "MEMORY.md",
      text,
    })),
  );
  return paras.length;
}
