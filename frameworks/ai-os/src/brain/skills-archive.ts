// `ai-os skills-archive [--out <dir>] [--budget <KB>] [--refs-cap <KB>]` (just skills-archive): compiles every
// .agents/skills/*/SKILL.md (+ references/*.md) with AGENTS.md, SOUL.md, CLAUDE.md and the Claude memory into a few
// optimized markdown files (Gemini Gem knowledge / R2 / Drive): frontmatter reduced to name+description, duplicate
// paragraphs dropped, relative links rewritten to in-bundle anchors, per-file size budget, split per domain.
// Output: <out>/00-index.md (TOC + conventions + memory index), memory.md, skills-<domain>[-N].md, refs-<domain>[-N].md,
// manifest.json (sha256 per file). Secrets: memory files only; each file is scanned and a hit aborts the run.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const SKILLS = join(ROOT, ".agents", "skills");
const MEMDIR = join(homedir(), ".claude", "projects", "C--aphrody", "memory");

const SECRET =
  /(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_\w{40,}|sk-[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[0-9A-Za-z-]{20,})/;

interface Skill {
  name: string;
  desc: string;
  dir: string;
  body: string;
  refs: { path: string; body: string }[];
  domain: string;
}

function front(src: string): { fm: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { fm: {}, body: src };
  let fm: Record<string, any> = {};
  try {
    fm = (Bun as any).YAML.parse(m[1]) ?? {};
  } catch {
    for (const l of m[1].split(/\r?\n/)) {
      const k = /^(\w[\w-]*):\s*(.*)$/.exec(l);
      if (k) fm[k[1]] = k[2].replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: src.slice(m[0].length) };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const domainOf = (name: string) => {
  const p = name.split("-")[0];
  return [
    "cli",
    "stitch",
    "steam",
    "jules",
    "cargo",
    "rust",
    "google",
    "gemini",
    "react",
    "cloudflare",
  ].includes(p)
    ? p
    : "core";
};

/** Rewrites relative markdown links: references/x.md -> in-bundle anchor, anything else relative -> plain text + path. */
function links(body: string, skill: string): string {
  return body.replace(
    /\[([^\]]+)\]\(([^)\s#]+)(#[^)\s]*)?\)/g,
    (_m, text, href: string) => {
      if (/^(https?:|mailto:|#)/i.test(href)) return _m;
      const r = /^(?:\.\/)?references\/(.+?)(?:\.md)?$/.exec(href);
      if (r) return `[${text}](#${slug(`${skill}-ref-${r[1]}`)})`;
      return `${text} (\`${href}\`)`;
    },
  );
}

const seen = new Set<string>();
/** Drops paragraphs (>= 200 chars) already emitted elsewhere in the archive. */
function dedup(body: string): string {
  return body
    .split(/\n{2,}/)
    .filter((p) => {
      const t = p.trim();
      if (t.length < 200 || t.startsWith("```")) return true;
      const h = new Bun.CryptoHasher("sha1")
        .update(t.replace(/\s+/g, " "))
        .digest("base64");
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    })
    .join("\n\n");
}
const squeeze = (s: string) =>
  s
    .replace(/[ \t]+$/gm, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

async function load(): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const d of readdirSync(SKILLS, { withFileTypes: true })) {
    const f = join(SKILLS, d.name, "SKILL.md");
    if (!d.isDirectory() || !existsSync(f)) continue;
    const { fm, body } = front(await Bun.file(f).text());
    const name = String(fm.name ?? d.name);
    const refs: Skill["refs"] = [];
    const rd = join(SKILLS, d.name, "references");
    if (existsSync(rd))
      for await (const p of new Bun.Glob("**/*.md").scan(rd))
        refs.push({
          path: p.replace(/\\/g, "/"),
          body: front(await Bun.file(join(rd, p)).text()).body,
        });
    refs.sort((a, b) => a.path.localeCompare(b.path));
    out.push({
      name,
      desc: String(fm.description ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      dir: d.name,
      body,
      refs,
      domain: domainOf(name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Packs sections into files of at most `budget` bytes (a single oversized section gets its own file). */
function pack(
  prefix: string,
  sections: { title: string; text: string }[],
  budget: number,
) {
  const files: { name: string; text: string; titles: string[] }[] = [];
  let cur = { text: "", titles: [] as string[] };
  const flush = () => {
    if (cur.titles.length)
      files.push({ name: "", text: cur.text, titles: cur.titles });
    cur = { text: "", titles: [] };
  };
  for (const s of sections) {
    if (
      cur.titles.length &&
      Buffer.byteLength(cur.text) + Buffer.byteLength(s.text) > budget
    )
      flush();
    cur.text += `${s.text}\n\n`;
    cur.titles.push(s.title);
  }
  flush();
  files.forEach(
    (f, i) => (f.name = `${prefix}${files.length > 1 ? `-${i + 1}` : ""}.md`),
  );
  return files;
}

export async function archive(opts: {
  out: string;
  budgetKB: number;
  refsCapKB: number;
}) {
  const budget = opts.budgetKB * 1024;
  const cap = opts.refsCapKB * 1024;
  mkdirSync(opts.out, { recursive: true });
  for (const f of readdirSync(opts.out))
    if (/\.(md|json)$/.test(f)) rmSync(join(opts.out, f));

  const skills = await load();
  const written: { file: string; bytes: number; sha256: string }[] = [];
  const put = async (file: string, text: string) => {
    if (SECRET.test(text))
      throw new Error(`secret-like content in ${file}: aborted`);
    await Bun.write(join(opts.out, file), text);
    written.push({
      file,
      bytes: Buffer.byteLength(text),
      sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    });
  };

  // Conventions + memory (verbatim, not deduplicated: they are the contract).
  const rd = async (p: string) =>
    existsSync(p) ? squeeze(await Bun.file(p).text()) : "";
  const conv = [
    `## AGENTS.md\n\n${await rd(join(ROOT, "AGENTS.md"))}`,
    `## SOUL.md\n\n${await rd(join(ROOT, ".agents", "SOUL.md"))}`,
    `## CLAUDE.md (conventions)\n\n${await rd(join(ROOT, "CLAUDE.md"))}`,
  ].join("\n\n");
  const memIndex = await rd(join(MEMDIR, "MEMORY.md"));
  const memFiles = existsSync(MEMDIR)
    ? readdirSync(MEMDIR)
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
        .sort()
    : [];
  let memText =
    "# Memory (Claude project memory, synced; Gemini writes back through memory_add, append-only)\n\n";
  for (const f of memFiles)
    memText += `## ${f.replace(/\.md$/, "")}\n\n${front(await Bun.file(join(MEMDIR, f)).text()).body.trim()}\n\n`;
  await put("memory.md", memText);

  // Skills: SKILL.md bodies by domain; references in separate files, each reference capped.
  const byDom = new Map<string, Skill[]>();
  for (const s of skills)
    byDom.set(s.domain, [...(byDom.get(s.domain) ?? []), s]);
  const idx: string[] = [];
  let refsTruncated = 0;
  for (const [dom, list] of [...byDom].sort()) {
    const sec = list.map((s) => ({
      title: s.name,
      text: `<a id="${slug(s.name)}"></a>\n\n# Skill: ${s.name}\n\n> ${s.desc}\n\n${dedup(squeeze(links(s.body, s.name)))}`,
    }));
    const files = pack(`skills-${dom}`, sec, budget);
    for (const f of files) {
      await put(
        f.name,
        `<!-- skills archive: domain ${dom}; one section per skill; links point to anchors in the same or refs-${dom} files -->\n\n${f.text}`,
      );
      for (const t of f.titles)
        idx.push(
          `- [${t}](${f.name}#${slug(t)}): ${list.find((s) => s.name === t)!.desc.slice(0, 160)}`,
        );
    }
    const rsec: { title: string; text: string }[] = [];
    for (const s of list)
      for (const r of s.refs) {
        let body = dedup(squeeze(links(r.body, s.name)));
        if (Buffer.byteLength(body) > cap) {
          body = `${body.slice(0, cap)}\n\n[truncated at ${opts.refsCapKB} KB: full text in .agents/skills/${s.dir}/references/${r.path}]`;
          refsTruncated++;
        }
        rsec.push({
          title: `${s.name}/${r.path}`,
          text: `<a id="${slug(`${s.name}-ref-${r.path.replace(/\.md$/, "")}`)}"></a>\n\n# ${s.name}: references/${r.path}\n\n${body}`,
        });
      }
    for (const f of pack(`refs-${dom}`, rsec, budget))
      await put(f.name, f.text);
  }

  const index = `# Aphrody skills archive (generated ${new Date().toISOString().slice(0, 10)} by \`just skills-archive\`)\n\nHow to use: each skill is a procedure; read the matching section before acting. Skills: ${skills.length}. Files: skills-<domain>*.md (bodies), refs-<domain>*.md (references), memory.md (owner memory), this index.\n\n# Conventions\n\n${conv}\n\n# Memory index\n\n${memIndex}\n\n# Skills index\n\n${idx.join("\n")}\n`;
  await put("00-index.md", index);
  await Bun.write(
    join(opts.out, "manifest.json"),
    `${JSON.stringify({ generated: new Date().toISOString(), skills: skills.length, memoryFiles: memFiles.length, refsTruncated, files: written }, null, 2)}\n`,
  );
  return {
    skills: skills.length,
    files: written.length,
    bytes: written.reduce((a, b) => a + b.bytes, 0),
    refsTruncated,
    out: opts.out,
  };
}

if (import.meta.main) {
  const a = Bun.argv.slice(2);
  const opt = (k: string, d: string) =>
    a.includes(k) ? a[a.indexOf(k) + 1] : d;
  const r = await archive({
    out: resolve(opt("--out", join(ROOT, "var", "skills-archive"))),
    budgetKB: Number(opt("--budget", "900")),
    refsCapKB: Number(opt("--refs-cap", "60")),
  });
  console.log(
    `skills-archive: ${r.skills} skills -> ${r.files} files, ${(r.bytes / 1e6).toFixed(2)} MB, ${r.refsTruncated} refs truncated, ${r.out}`,
  );
  if (a.includes("--publish")) {
    const bucket = Bun.env.SKILLS_ARCHIVE_BUCKET ?? "aphrody-backups";
    const files = readdirSync(r.out);
    // Cloudflare REST: PUT /accounts/<id>/r2/buckets/<bucket>/objects/<key> (token from the vault, account id from device/cloudflare/cloudflare.toml).
    const acct =
      Bun.env.CLOUDFLARE_ACCOUNT_ID ??
      (
        Bun.TOML.parse(
          await Bun.file(
            join(ROOT, "device", "cloudflare", "cloudflare.toml"),
          ).text(),
        ) as any
      ).account;
    if (!Bun.env.CLOUDFLARE_API_TOKEN)
      throw new Error("CLOUDFLARE_API_TOKEN missing");
    for (const f of files) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${acct}/r2/buckets/${bucket}/objects/${encodeURIComponent(`skills/${f}`)}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${Bun.env.CLOUDFLARE_API_TOKEN}`,
            "content-type": f.endsWith(".json")
              ? "application/json"
              : "text/markdown; charset=utf-8",
          },
          body: Bun.file(join(r.out, f)),
        },
      );
      if (!res.ok)
        throw new Error(
          `r2 put ${f}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`,
        );
    }
    console.log(`published ${files.length} objects to r2://${bucket}`);
  }
}
