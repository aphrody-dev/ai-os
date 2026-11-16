// Eval set from the src docs index: each markdown section (## or ###) of docs/ is an entry (heading removed
// from the text); its heading is the query. src is private, so the generated set stays local (never committed):
// bench/.cache/srcdocs.json. Combined with the research pack (30 queries) by retrieval.ts --eval.
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";

export type EvalSet = {
  entries: { id: string; title: string; text: string }[];
  queries: { q: string; target: string }[];
};
export const CACHE = join(import.meta.dir, ".cache", "srcdocs.json");

export async function buildSrcDocs(
  root = Bun.env.SRC_DOCS ?? join(import.meta.dir, "..", "..", "..", "docs"),
  max = 400,
): Promise<EvalSet> {
  const entries: EvalSet["entries"] = [];
  const queries: EvalSet["queries"] = [];
  const seen = new Set<string>();
  const files = [
    ...new Bun.Glob("**/*.md").scanSync({ cwd: root, onlyFiles: true }),
  ].sort();
  for (const f of files) {
    const text = (await Bun.file(join(root, f)).text()).replace(/\r\n/g, "\n");
    const parts = text.split(/^(#{2,3}\s+.+)$/m);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const heading = parts[i]!.replace(/^#+\s+/, "")
        .replace(/[`*_]/g, "")
        .trim();
      const body = parts[i + 1]!.trim();
      const words = heading.split(/\s+/).length;
      const key = heading.toLowerCase();
      if (
        body.length < 300 ||
        words < 3 ||
        seen.has(key) ||
        /^\d+[.)]?$/.test(heading)
      )
        continue;
      seen.add(key);
      const id = `doc:${relative(".", f).replaceAll("\\", "/")}#${entries.length}`;
      entries.push({ id, title: f, text: body.slice(0, 4000) });
      queries.push({ q: heading, target: id });
    }
  }
  // deterministic subsample spread over files
  const step = Math.max(1, Math.floor(queries.length / max));
  const keep = new Set(
    queries
      .filter((_, i) => i % step === 0)
      .slice(0, max)
      .map((q) => q.target),
  );
  return { entries, queries: queries.filter((q) => keep.has(q.target)) };
}

if (import.meta.main) {
  const set = await buildSrcDocs();
  mkdirSync(join(import.meta.dir, ".cache"), { recursive: true });
  await Bun.write(CACHE, JSON.stringify(set));
  console.log(
    `entries=${set.entries.length} queries=${set.queries.length} -> ${CACHE}`,
  );
}
