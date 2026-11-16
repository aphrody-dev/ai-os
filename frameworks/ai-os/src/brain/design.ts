// Design corpus for the brain (docs/design): normalized specs (one entry per H2 section), skill-facing URL
// indexes (one entry per site) and the free-licence text mirror (third_party/design-mirror, one entry per page).
// Source "doc", scope "design"; ids are stable paths so re-absorbing replaces entries in place.
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

type DesignEntry = {
  id: string;
  source: "doc";
  scope: "design";
  title: string;
  text: string;
};

function* files(dir: string, ext: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p, ext);
    else if (e.name.endsWith(ext)) yield p;
  }
}

const rel = (root: string, p: string) =>
  relative(root, p).replaceAll("\\", "/");

export async function designEntries(root: string): Promise<DesignEntry[]> {
  const out: DesignEntry[] = [];
  for (const p of files(join(root, "docs/design/specs"), ".md")) {
    const r = rel(root, p);
    const text = await Bun.file(p).text();
    const parts = text.split(/\n(?=## )/);
    const head = parts[0]!.match(/^# (.+)$/m)?.[1] ?? r;
    parts.forEach((part, i) =>
      out.push({
        id: `design-spec:${r}#${i}`,
        source: "doc",
        scope: "design",
        title: i ? `${head} / ${part.match(/^## (.+)$/m)?.[1] ?? i}` : head,
        text: part.slice(0, 12_000),
      }),
    );
  }
  for (const p of files(join(root, "docs/design/index"), ".json")) {
    const j = (await Bun.file(p).json()) as {
      site: string;
      license: string;
      mode: string;
      urls: { url: string }[];
    };
    out.push({
      id: `design-index:${j.site}`,
      source: "doc",
      scope: "design",
      title: `${j.site} (${j.mode}, ${j.license})`,
      text: j.urls
        .map((u) => u.url)
        .join("\n")
        .slice(0, 60_000),
    });
  }
  for (const p of files(join(root, "third_party/design-mirror"), ".md")) {
    if (p.endsWith("README.md")) continue;
    const r = rel(root, p);
    const text = await Bun.file(p).text();
    const url = text.match(/^source_url: (.+)$/m)?.[1] ?? r;
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    out.push({
      id: `design-mirror:${r}`,
      source: "doc",
      scope: "design",
      title: `${body.match(/^#{1,2} (.+)$/m)?.[1] ?? r} <${url}>`,
      text: body.slice(0, 12_000),
    });
  }
  return out;
}
