// Anchoring of reviews on the official Google sources (config/review.json `sources`): Chromium and depot_tools style
// guides, google/eng-practices, google/styleguide, ChromiumOS, Android, Bazel. Read from the official repository:
// `gh api` for GitHub, gitiles (`?format=JSON` / `?format=TEXT`) for *.googlesource.com, never a browser.
// Local cache <src>/var/review/sources/ (ignored by git): one file per source + index.json (source commit, date,
// URL); refreshed at most once a day (REVIEW_SOURCES_TTL_MS), the old copy serves if the network is down.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type SourceSpec = {
  id: string;
  topics: string[];
  path: string;
  github?: string;
  gitiles?: string;
  ref?: string;
};
export type SourceMeta = {
  id: string;
  url: string;
  commit: string;
  fetched: string;
  bytes: number;
  stale?: boolean;
  error?: string;
};
export type Fetcher = (
  s: SourceSpec,
) => Promise<{ text: string; commit: string; url: string }>;

const DAY = 864e5;

/** Atomic write: neighboring temporary file then rename (no half-written copy after a crash). */
function atomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

async function run(argv: string[], timeoutMs = 30_000) {
  const p = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: timeoutMs,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `${argv[0]} ${argv[1]} : code ${code} ${err.slice(0, 200)}`,
    );
  return out;
}

/** GitHub (gh api) or gitiles: content at the commit that last touched the file, and that commit. */
export const officialFetch: Fetcher = async (s) => {
  if (s.github) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(s.github) || /\.\./.test(s.path))
      throw new Error(`source invalide : ${s.id}`);
    const ref =
      s.ref ??
      (
        await run(["gh", "api", `repos/${s.github}`, "--jq", ".default_branch"])
      ).trim();
    const commit = (
      await run([
        "gh",
        "api",
        `repos/${s.github}/commits?path=${encodeURIComponent(s.path)}&sha=${encodeURIComponent(ref)}&per_page=1`,
        "--jq",
        ".[0].sha",
      ])
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new Error(`${s.id}: commit not found`);
    const text = await run([
      "gh",
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${s.github}/contents/${s.path}?ref=${commit}`,
    ]);
    return {
      text,
      commit,
      url: `https://github.com/${s.github}/blob/${commit}/${s.path}`,
    };
  }
  if (s.gitiles) {
    const base = s.gitiles.replace(/\/+$/, "");
    if (
      !/^https:\/\/[\w.-]+\.googlesource\.com\//.test(base) ||
      /\.\./.test(s.path)
    )
      throw new Error(`source gitiles hors googlesource.com : ${s.id}`);
    const ref = s.ref ?? "HEAD";
    const log = await fetch(`${base}/+log/${ref}/${s.path}?format=JSON&n=1`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!log.ok) throw new Error(`${s.id} : gitiles HTTP ${log.status}`);
    // gitiles response prefixed by )]}' (anti-XSSI).
    const j = JSON.parse((await log.text()).replace(/^\)\]\}'\s*/, ""));
    const commit = String(j.log?.[0]?.commit ?? "");
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new Error(`${s.id}: commit not found`);
    const r = await fetch(`${base}/+/${commit}/${s.path}?format=TEXT`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`${s.id} : gitiles HTTP ${r.status}`);
    const text = Buffer.from(await r.text(), "base64").toString("utf8");
    return { text, commit, url: `${base}/+/${commit}/${s.path}` };
  }
  throw new Error(`${s.id} : ni github ni gitiles`);
};

export class SourceCache {
  readonly dir: string;
  private index: Record<string, SourceMeta>;
  constructor(
    root: string,
    private fetcher: Fetcher = officialFetch,
    private ttlMs = Number(Bun.env.REVIEW_SOURCES_TTL_MS ?? DAY),
  ) {
    this.dir = join(root, "var", "review", "sources");
    mkdirSync(this.dir, { recursive: true });
    const f = join(this.dir, "index.json");
    try {
      this.index = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    } catch {
      this.index = {}; // corrupted index: everything is reread from the official repositories
    }
  }
  private save() {
    atomic(
      join(this.dir, "index.json"),
      `${JSON.stringify(this.index, null, 2)}\n`,
    );
  }
  private file = (id: string) =>
    join(this.dir, `${id.replace(/[^\w.-]/g, "_")}.md`);

  /** Text of a source, refreshed if the copy is over a day old (or `force`). Stale copy if the network fails. */
  async get(
    s: SourceSpec,
    force = false,
  ): Promise<{ text: string; meta: SourceMeta } | null> {
    const m = this.index[s.id];
    const age = m ? Date.now() - Date.parse(m.fetched) : Infinity;
    if (
      m?.error &&
      !existsSync(this.file(s.id)) &&
      age < Math.min(this.ttlMs, 3600_000) &&
      !force
    )
      return null;
    const fresh = m && !m.error && age < this.ttlMs;
    if (fresh && !force && existsSync(this.file(s.id)))
      return { text: readFileSync(this.file(s.id), "utf8"), meta: m };
    try {
      const r = await this.fetcher(s);
      const meta: SourceMeta = {
        id: s.id,
        url: r.url,
        commit: r.commit,
        fetched: new Date().toISOString(),
        bytes: r.text.length,
      };
      atomic(this.file(s.id), r.text);
      this.index[s.id] = meta;
      this.save();
      return { text: r.text, meta };
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 200);
      if (m && existsSync(this.file(s.id)))
        return {
          text: readFileSync(this.file(s.id), "utf8"),
          meta: { ...m, stale: true, error },
        };
      this.index[s.id] = {
        id: s.id,
        url: "",
        commit: "",
        fetched: new Date().toISOString(),
        bytes: 0,
        error,
      };
      this.save();
      return null;
    }
  }

  /** Refreshes all sources (daily task `ai-os review sources`). */
  async refresh(specs: SourceSpec[], force = true) {
    const out: SourceMeta[] = [];
    for (const s of specs) {
      const r = await this.get(s, force);
      out.push(r?.meta ?? this.index[s.id]!);
    }
    return out;
  }
}

/** Topics of a set of files according to the config/review.json `topics` patterns. */
export function topicsOf(files: string[], patterns: Record<string, string>) {
  const out = new Set<string>();
  for (const [t, re] of Object.entries(patterns)) {
    const r = new RegExp(re, "i");
    if (files.some((f) => r.test(f.replace(/\\/g, "/")))) out.add(t);
  }
  return [...out].sort();
}

/** Sections of a Markdown document (#..### headings), with their title. */
export function sections(text: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  let cur = { title: "", body: "" };
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,3}\s/.test(line)) {
      if (cur.body.trim()) out.push(cur);
      cur = { title: line.replace(/^#+\s*/, "").trim(), body: `${line}\n` };
    } else cur.body += `${line}\n`;
  }
  if (cur.body.trim()) out.push(cur);
  return out;
}

const words = (s: string) =>
  new Set(
    (s.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []).filter(
      (w) => !STOP.has(w),
    ),
  );
const STOP = new Set(
  "this that with from have will your when then than what which their there should would could must into only also each such more most some other these those been were they them make made used uses using code file files line lines".split(
    " ",
  ),
);

/** Most relevant excerpts of a source for a diff: sections ranked by the diff words they contain. */
export function excerpt(text: string, subject: string, budget: number): string {
  const want = words(subject);
  const ranked = sections(text)
    .map((s, i) => {
      const w = words(s.body);
      let hit = 0;
      for (const x of want) if (w.has(x)) hit++;
      return { ...s, i, score: hit / Math.sqrt(1 + s.body.length / 500) };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const picked: typeof ranked = [];
  let used = 0;
  for (const s of ranked) {
    if (used >= budget) break;
    const body = s.body.slice(0, Math.max(0, budget - used));
    picked.push({ ...s, body });
    used += body.length;
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map((s) => s.body.trim())
    .join("\n\n");
}
