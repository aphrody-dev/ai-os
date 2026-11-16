// Continuous self-improvement loop (Hermes style): collect -> distill (ai-os routed model) -> apply -> log.
// usage: bun tools/agents/learn-loop.ts [run|collect|install|status] [--since <ISO|hours>] [--no-apply] [--no-llm] [--model provider/model]
// Pieces reused: learn journal (aphrody-nhitl), skill `learn`, just agents-sync, ai-os brain sync, ai-os review docs, gh, hygiene, commit.ts.
// Safety: secrets redacted in and out, memories deleted only with a valid cited source, nothing under ~/.claude or ~/.gemini removed wholesale.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const HOME = (process.env.USERPROFILE ?? process.env.HOME)!.replaceAll("\\", "/");
const ROOT = join(import.meta.dir, "..", "..").replaceAll("\\", "/");
const LEARN = `${HOME}/.claude/learning`;
const RUNS = `${LEARN}/runs`;
const STATE = `${LEARN}/loop-state.json`;
const LOCK = `${LEARN}/loop.lock`;
const PROJECT = process.env.LEARN_PROJECT ?? "C--aphrody";
const MEM = `${HOME}/.claude/projects/${PROJECT}/memory`;
const REPOS = (
  process.env.LEARN_REPOS ??
  "aphrody-labs/ay,aphrody-labs/shenron,aphrody-labs/rosegriffon,aphrody-labs/open,aphrody-labs/dioxus-monorepo,aphrody-labs/browser"
).split(",");
const TEST_TARGETS = (process.env.LEARN_TESTS ?? "frameworks/ai-os/src/brain").split(",");
const TASK = "Aphrody\\LearnLoop";

const args = Bun.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) ?? "run";
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---------- helpers ----------
const SECRET =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_\w{20,}|gho_\w{20,}|github_pat_\w{20,}|AIza[\w-]{30,}|xox[bp]-[\w-]+|eyJ[\w-]{20,}\.[\w-]{10,}\.[\w-]{10,}|Bearer\s+\S{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|token|secret|passw(?:or)?d)["']?\s*[=:]\s*["']?[^\s"',;]{6,})/gi;
const redact = (s: string) => s.replace(SECRET, "[redacted]");
const hasSecret = (s: string) => ((SECRET.lastIndex = 0), SECRET.test(s));
const clip = (s: string, n: number) => redact(s.replace(/\s+/g, " ").trim()).slice(0, n);
const sh = async (c: string[], cwd = ROOT, timeout = 180_000) => {
  const p = Bun.spawn(c, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
  const t = setTimeout(() => p.kill(), timeout);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(t);
  return { code: await p.exited, out: o, err: e };
};
const readJson = <T>(f: string, d: T): T => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
const mt = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};
const walk = (dir: string, ext: string, out: string[] = [], depth = 6): string[] => {
  if (depth < 0 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, ext, out, depth - 1);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
};

type Sig = { id: string; src: string; cite: string; text: string; flag?: boolean };
type State = {
  lastRun?: string;
  ci?: Record<string, { total: number; fail: number }>;
  tests?: Record<string, { pass: number; fail: number }>;
  hygiene?: number;
};

// ---------- 1. collect ----------
const CORRECT =
  /(?<![\p{L}])(non|nan|stop|arr[eê]te|jamais|faux|erreur|pourquoi|encore|d[eé]j[aà]|putain|merde|nul|inutile|bordel|ridicule|j'ai dit|n'importe quoi|wrong|never|don't|do not|why did|again|broken|slop|useless|0\/10)(?![\p{L}])|!!|[A-Z]{12,}/iu;

async function collect(since: number, prev: State) {
  const sigs: Sig[] = [];
  const counts: Record<string, { seen: number; kept: number; note?: string }> = {};
  const next: State = { ...prev };
  const add = (src: string, s: Omit<Sig, "id" | "src">) => {
    const n = sigs.filter((x) => x.src === src).length + 1;
    sigs.push({ id: `${src}${n}`, src, ...s });
    counts[src].kept++;
  };
  const cnt = (src: string) => (counts[src] ??= { seen: 0, kept: 0 });

  // T: Claude transcripts (owner messages)
  cnt("T");
  const projDir = `${HOME}/.claude/projects`;
  const T: Sig[] = [];
  let tFiles = 0;
  for (const p of readdirSync(projDir)) {
    const d = `${projDir}/${p}`;
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".jsonl"))) {
      const fp = `${d}/${f}`;
      if (mt(fp) < since) continue;
      tFiles++;
      const lines = readFileSync(fp, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!l.includes('"type":"user"')) return;
        let o: any;
        try {
          o = JSON.parse(l);
        } catch {
          return;
        }
        if (o.type !== "user" || o.isSidechain || o.isMeta) return;
        if (o.timestamp && Date.parse(o.timestamp) < since) return;
        const c = o.message?.content;
        const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
        if (!t || /^<(system-reminder|task-notification|command-|local-command)|^You are (a|an) |^Caveat:|^\[Request interrupted/.test(t)) return;
        if (t.length > 4000) return; // sub-agent briefs, pasted logs
        counts.T.seen++;
        if (!CORRECT.test(t)) return;
        T.push({ id: "", src: "T", cite: `transcript ${p}/${f.replace(".jsonl", "")}:${i + 1}`, text: clip(t, 380), flag: true });
      });
    }
  }
  counts.T.note = `${tFiles} files`;
  T.slice(-25).forEach((s) => add("T", s));

  // A: agy (Antigravity) conversations
  cnt("A");
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(`${HOME}/.gemini/antigravity-cli/conversation_summaries.db`, { readonly: true });
    const rows = db.query("select conversation_id,title,preview,step_count,status,last_modified_time from conversation_summaries").all() as any[];
    db.close();
    const recent = rows.filter((r) => Date.parse(r.last_modified_time) >= since);
    counts.A.seen = recent.length;
    recent.slice(-12).forEach((r) =>
      add("A", { cite: `agy conversation ${r.conversation_id}`, text: clip(`${r.title} | ${r.preview} | steps=${r.step_count} status=${r.status}`, 300) }),
    );
  } catch (e) {
    counts.A.note = `unavailable: ${String(e).slice(0, 80)}`;
  }
  const brain = walk(`${HOME}/.gemini/antigravity-cli/brain`, ".md", [], 3).filter((f) => mt(f) >= since);
  cnt("AB").seen = brain.length;
  brain.slice(-6).forEach((f) => add("AB", { cite: `agy brain ${f.split("brain/")[1]}`, text: clip(readFileSync(f, "utf8"), 300) }));

  // B: background agent task outputs
  cnt("B");
  const tmp = `${process.env.TEMP ?? `${HOME}/AppData/Local/Temp`}`.replaceAll("\\", "/") + "/claude";
  const outs = walk(tmp, ".output", [], 4).filter((f) => mt(f) >= since);
  counts.B.seen = outs.length;
  for (const f of outs) {
    const t = readFileSync(f, "utf8");
    if (/Exit code [1-9]|\bFAIL\b|\berror\b|failed/i.test(t.slice(-1500)) && counts.B.kept < 12)
      add("B", { cite: `task output ${f.split("claude/")[1]}`, text: clip(t.slice(-500), 300), flag: true });
  }

  // R: Gemini verdicts (docs/reviews of this repo + commits of the other repos)
  cnt("R");
  const rv = walk(`${ROOT}/docs/reviews`, ".md", [], 4).filter((f) => mt(f) >= since && !f.endsWith("README.md"));
  counts.R.seen = rv.length;
  for (const f of rv.slice(-15)) {
    const t = readFileSync(f, "utf8");
    const note = /Note\s*:\s*\*?\*?\s*([\d.]+)\s*\/\s*20/.exec(t)?.[1];
    const first = /^\s*1\.\s+(.*)$/m.exec(t)?.[1] ?? t.slice(0, 200);
    add("R", { cite: `review ${relative(ROOT, f).replaceAll("\\", "/")}`, text: clip(`note ${note ?? "?"}/20 | ${first}`, 330), flag: note ? Number(note) < 14 : false });
  }
  for (const r of ["shenron", "rosegriffon"]) {
    const x = await sh(["gh", "api", `repos/aphrody-labs/${r}/commits?path=docs/reviews&since=${new Date(since).toISOString()}&per_page=5`]);
    try {
      const j = JSON.parse(x.out) as any[];
      counts.R.seen += j.length;
      j.forEach((c) => add("R", { cite: `review commit ${c.html_url}`, text: clip(c.commit.message, 250) }));
    } catch {
      counts.R.note = `${counts.R.note ?? ""} ${r}: no docs/reviews`.trim();
    }
  }

  // C: CI (gh run list + failed logs)
  cnt("C");
  next.ci = {};
  for (const repo of REPOS) {
    const x = await sh(["gh", "run", "list", "-R", repo, "-L", "40", "--json", "databaseId,workflowName,conclusion,createdAt,url,displayTitle"]);
    let runs: any[] = [];
    try {
      runs = JSON.parse(x.out).filter((r: any) => Date.parse(r.createdAt) >= since);
    } catch {
      counts.C.note = `${counts.C.note ?? ""} ${repo}: ${x.err.slice(0, 40).trim()}`.trim();
      continue;
    }
    const fails = runs.filter((r) => r.conclusion === "failure");
    next.ci[repo] = { total: runs.length, fail: fails.length };
    counts.C.seen += runs.length;
    const p = prev.ci?.[repo];
    const delta = p ? ` (fail delta ${fails.length - p.fail >= 0 ? "+" : ""}${fails.length - p.fail} vs last run)` : "";
    add("C", { cite: `gh run list ${repo}`, text: `${repo}: ${runs.length} runs, ${fails.length} failed${delta}` });
    const seenWf = new Set<string>();
    for (const r of fails) {
      if (seenWf.has(r.workflowName) || seenWf.size >= 2) continue;
      seenWf.add(r.workflowName);
      const l = await sh(["gh", "run", "view", String(r.databaseId), "-R", repo, "--log-failed"], ROOT, 60_000);
      add("C", { cite: `run ${r.url}`, text: clip(`${r.workflowName} "${r.displayTitle}": ${l.out.slice(-600) || l.err}`, 420), flag: true });
    }
  }

  // H: hygiene
  cnt("H");
  const hy = await sh(["bun", "scripts/hygiene.ts"], ROOT, 240_000);
  const hl = (hy.out + hy.err).split("\n").filter((l) => /\S/.test(l));
  counts.H.seen = hl.length;
  next.hygiene = hl.length;
  add("H", { cite: "bun scripts/hygiene.ts", text: clip(`exit ${hy.code}, ${hl.length} lines${prev.hygiene !== undefined ? `, delta ${hl.length - prev.hygiene}` : ""}; ${hl.slice(-4).join(" / ")}`, 360) });

  // U: tests
  cnt("U");
  next.tests = {};
  for (const t of TEST_TARGETS) {
    const x = await sh(["bun", "test", t], ROOT, 300_000);
    const all = x.out + x.err;
    const pass = Number(/(\d+) pass/.exec(all)?.[1] ?? 0);
    const fail = Number(/(\d+) fail/.exec(all)?.[1] ?? 0);
    next.tests[t] = { pass, fail };
    counts.U.seen += pass + fail;
    const p = prev.tests?.[t];
    add("U", {
      cite: `bun test ${t}`,
      text: `${t}: ${pass} pass, ${fail} fail${p ? ` (delta pass ${pass - p.pass}, fail ${fail - p.fail})` : ""}`,
      flag: fail > 0,
    });
  }

  // J: learn journal (learn-capture hook)
  cnt("J");
  const jl = existsSync(`${LEARN}/journal.jsonl`) ? readFileSync(`${LEARN}/journal.jsonl`, "utf8").split("\n").filter(Boolean) : [];
  jl.forEach((l, i) => {
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      return;
    }
    if (Date.parse(o.ts) < since) return;
    counts.J.seen++;
    const body = [...(o.errors ?? []), ...(o.fixes ?? [])].join(" | ");
    if (body && counts.J.kept < 10) add("J", { cite: `journal.jsonl:${i + 1} session ${o.session}`, text: clip(body, 300) });
  });

  return { sigs, counts, next };
}

// ---------- 2. distill ----------
const kinds = ["memory", "skill", "rule", "ticket", "retire"] as const;
type Item = {
  kind: (typeof kinds)[number];
  slug: string;
  title: string;
  description?: string;
  body: string;
  type?: string;
  sources: string[];
  target?: string;
};

function memoryInventory() {
  if (!existsSync(MEM)) return [] as { f: string; d: string }[];
  return readdirSync(MEM)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .map((f) => ({ f, d: /description:\s*"?(.*?)"?\s*$/m.exec(readFileSync(`${MEM}/${f}`, "utf8"))?.[1] ?? "" }));
}

const plausible = (i: any) =>
  (kinds as readonly string[]).includes(i?.kind) &&
  /^[a-z0-9-]{3,48}$/.test(i?.slug ?? "") &&
  !(kinds as readonly string[]).includes(i.slug) &&
  Array.isArray(i.sources) &&
  i.sources.length > 0 &&
  String(i.body ?? "").length >= 60 &&
  String(i.title ?? "").length >= 12;

async function distill(sigs: Sig[], model?: string) {
  const inv = memoryInventory();
  const head =
    `You distill durable lessons for a coding-agent team from the signals below.\n\nEXISTING MEMORIES:\n${inv.map((m) => `- ${m.f}: ${m.d.slice(0, 90)}`).join("\n")}\n\nSIGNALS:\n` +
    sigs.map((s) => `[${s.id}]${s.flag ? "!" : ""} ${s.text}`).join("\n").slice(0, 12000);
  const tail =
    `\n\nTASK: return ONLY a JSON array (max 8 items), no prose, starting with "[". Item: {"kind":"memory|skill|rule|ticket|retire","slug":"kebab-case","title":"...","description":"one concrete line","body":"fact. Why: ... How to apply: ...","type":"user|feedback|project|reference","sources":["T1","C2"],"target":"existing-memory-file.md (retire only)"}.\n` +
    `Rules: never invent; every item cites signal ids in "sources"; "feedback" memory = owner correction (T signals); skill needs >=2 sources of the same procedure; "rule" = one short sentence for CLAUDE.md; "ticket" = a concrete defect (CI failure, review finding, failing test); "retire" only when a signal directly contradicts a listed memory. Prefer an existing memory slug. No secrets. English. Nothing durable: [].`;
  const { llmAsk } = await import(`${ROOT}/frameworks/ai-os/src/llm/model.ts`);
  const { listModels } = await import(`${ROOT}/frameworks/ai-os/src/llm/models.ts`);
  // local first (providers() order), then the next discovered provider if the answer is not parsable
  const cands: string[] = model ?? Bun.env.LEARN_MODEL
    ? [(model ?? Bun.env.LEARN_MODEL)!]
    : (await listModels()).filter((r: any) => r.available && r.models[0]).map((r: any) => r.models[0].id).slice(0, 6);
  let raw = "";
  for (const id of cands) {
    try {
      const r = await llmAsk(id, head + tail, "You output strict JSON only.", { temperature: 0 });
      raw = r.text;
      const m = /\[[\s\S]*\]/.exec(r.text);
      const items = m ? (JSON.parse(m[0]) as Item[]) : null;
      if (Array.isArray(items) && items.some(plausible)) return { items, model: r.model as string, ms: r.ms as number, raw };
    } catch (e) {
      raw = String(e).slice(0, 200);
    }
  }
  return { items: [] as Item[], model: cands.join(" > "), ms: 0, raw };
}

// ---------- 3. apply ----------
const dirty = async (p: string) => (await sh(["git", "status", "--porcelain", "--", p])).out.trim() !== "";
const today = () => new Date().toISOString().slice(0, 10);
const tok = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
const jac = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

async function apply(items: Item[], sigs: Sig[], log: string[]) {
  const byId = new Map(sigs.map((s) => [s.id, s]));
  const changed: string[] = [];
  const skipped: string[] = [];
  const edited = { mem: 0, skill: 0, rule: 0, ticket: 0, retire: 0 };
  for (const it of items) {
    const why = (m: string) => skipped.push(`${it.kind}/${it.slug}: ${m}`);
    if (!plausible(it)) { why("implausible (generic slug, short body or title)"); continue; }
    if (!kinds.includes(it.kind) || !/^[a-z0-9-]{3,48}$/.test(it.slug ?? "")) { why("bad kind or slug"); continue; }
    const srcs = [...new Set(it.sources ?? [])];
    if (!srcs.length || srcs.some((s) => !byId.has(s))) { why("uncited or unknown source ids"); continue; }
    const cite = srcs.map((s) => `${s}=${byId.get(s)!.cite}`).join("; ");
    const body = redact(String(it.body ?? "")).slice(0, 1200);
    const title = redact(String(it.title ?? it.slug)).slice(0, 100);
    const desc = redact(String(it.description ?? title)).replace(/\n/g, " ").slice(0, 150);
    if (!body.trim()) { why("empty body"); continue; }

    if (it.kind === "memory") {
      mkdirSync(MEM, { recursive: true });
      const inv = memoryInventory();
      const tk = tok(`${it.slug} ${desc}`);
      const near = inv.find((m) => m.f === `${it.slug}.md` || jac(tk, tok(`${m.f} ${m.d}`)) > 0.55);
      if (near) {
        const p = `${MEM}/${near.f}`;
        const cur = readFileSync(p, "utf8");
        if (cur.includes(body.slice(0, 60))) { why("duplicate of " + near.f); continue; }
        appendFileSync(p, `\n## Update ${today()}\n${body}\nSources: ${cite}\n`);
        log.push(`- memory updated ${near.f} (merged, not duplicated) <- ${cite}`);
      } else {
        const type = ["user", "feedback", "project", "reference"].includes(it.type ?? "") ? it.type : "feedback";
        writeFileSync(`${MEM}/${it.slug}.md`, `---\nname: ${it.slug}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n---\n\n${body}\n\nSources: ${cite}\n`);
        const idx = `${MEM}/MEMORY.md`;
        const cur = existsSync(idx) ? readFileSync(idx, "utf8") : "";
        writeFileSync(idx, `${cur.replace(/\s*$/, "\n")}- [${title}](${it.slug}.md) — ${desc.slice(0, 100)}\n`);
        log.push(`- memory created ${it.slug}.md <- ${cite}`);
      }
      edited.mem++;
    } else if (it.kind === "retire") {
      const f = it.target?.replace(/[^a-z0-9.-]/gi, "");
      if (!f || !existsSync(`${MEM}/${f}`) || f === "MEMORY.md") { why("retire target missing"); continue; }
      unlinkSync(`${MEM}/${f}`);
      const idx = `${MEM}/MEMORY.md`;
      if (existsSync(idx)) writeFileSync(idx, readFileSync(idx, "utf8").split("\n").filter((l) => !l.includes(`(${f})`)).join("\n"));
      log.push(`- memory retired ${f} (contradicted) <- ${cite}`);
      edited.retire++;
    } else if (it.kind === "skill") {
      if (srcs.length < 2) { why("skill needs >=2 sources"); continue; }
      const p = `${ROOT}/.agents/skills/${it.slug}/SKILL.md`;
      if (existsSync(p)) {
        if (readFileSync(p, "utf8").includes(body.slice(0, 60))) { why("skill already has it"); continue; }
        if (await dirty(`.agents/skills/${it.slug}`)) { why("skill dirty in shared tree"); continue; }
        appendFileSync(p, `\n## Learned ${today()}\n${body}\n\nSources: ${cite}\n`);
        log.push(`- skill improved ${it.slug} <- ${cite}`);
      } else {
        mkdirSync(`${ROOT}/.agents/skills/${it.slug}`, { recursive: true });
        writeFileSync(p, `---\nname: ${it.slug}\ndescription: ${desc}\n---\n\n${body}\n\nSources: ${cite}\n`);
        log.push(`- skill created ${it.slug} <- ${cite}`);
      }
      changed.push(`.agents/skills/${it.slug}/SKILL.md`);
      edited.skill++;
    } else if (it.kind === "rule") {
      const p = `${ROOT}/CLAUDE.md`;
      const cur = readFileSync(p, "utf8");
      const line = `- ${body.replace(/\s+/g, " ").slice(0, 200)} (src: ${srcs.map((s) => byId.get(s)!.cite).join("; ").slice(0, 160)})`;
      if (cur.includes(body.slice(0, 50))) { why("rule already present"); continue; }
      const H = "## Learned rules (generated by `just learn`)";
      const had = cur.includes(H);
      const nl = had ? cur.replace(H, `${H}\n\n${line}`) : `${cur.replace(/\s*$/, "\n")}\n${H}\n\n${line}\n`;
      const sec = /## Learned rules[^\n]*\n([\s\S]*)$/.exec(nl)![1].split("\n").filter((l) => l.startsWith("- "));
      if (sec.length > 20) { why("learned-rules section full (20)"); continue; }
      writeFileSync(p, nl);
      log.push(`- rule added to CLAUDE.md: ${line}`);
      if (!changed.includes("CLAUDE.md")) changed.push("CLAUDE.md");
      edited.rule++;
    } else if (it.kind === "ticket") {
      const p = `${ROOT}/docs/project/backlog.md`;
      mkdirSync(`${ROOT}/docs/project`, { recursive: true });
      const cur = existsSync(p) ? readFileSync(p, "utf8") : "# Backlog (generated by `just learn`; one line per defect, with its source)\n\n";
      if (cur.includes(`\`${it.slug}\``)) { why("ticket exists"); continue; }
      writeFileSync(p, `${cur.replace(/\s*$/, "\n")}- [ ] \`${it.slug}\` ${title}: ${body.replace(/\s+/g, " ").slice(0, 240)} (${today()}; src: ${cite})\n`);
      log.push(`- ticket ${it.slug} -> docs/project/backlog.md <- ${cite}`);
      if (!changed.includes("docs/project/backlog.md")) changed.push("docs/project/backlog.md");
      edited.ticket++;
    }
  }
  return { changed, skipped, edited };
}

// ---------- schedule ----------
async function install() {
  const bun = process.execPath.replaceAll("/", "\\");
  const script = `${ROOT}/tools/agents/learn-loop.ts`.replaceAll("/", "\\");
  const tr = `"${bun}" "${script}" run`;
  const c = await sh(["schtasks.exe", "/Create", "/F", "/TN", TASK, "/SC", "HOURLY", "/MO", "6", "/TR", tr]);
  const q = await sh(["schtasks.exe", "/Query", "/TN", TASK, "/FO", "LIST"]);
  const n = (await sh(["schtasks.exe", "/Query", "/FO", "CSV", "/NH"])).out.split("\n").filter((l) => l.includes("LearnLoop")).length;
  return `${c.out.trim() || c.err.trim()}\nentries named LearnLoop: ${n}\n${q.out.trim()}`;
}

// ---------- main ----------
mkdirSync(RUNS, { recursive: true });
if (cmd === "install") {
  console.log(await install());
  process.exit(0);
}
if (cmd === "status") {
  console.log(JSON.stringify(readJson(STATE, {}), null, 1));
  process.exit(0);
}
if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 2 * 3600_000) {
  console.error("another run is active (loop.lock < 2 h)");
  process.exit(0);
}
writeFileSync(LOCK, String(process.pid));
try {
  const prev = readJson<State>(STATE, {});
  const sOpt = opt("since");
  const since = sOpt
    ? /^\d+$/.test(sOpt) ? Date.now() - Number(sOpt) * 3600_000 : Date.parse(sOpt)
    : prev.lastRun ? Date.parse(prev.lastRun) : Date.now() - 48 * 3600_000;
  const t0 = new Date();
  const { sigs, counts, next } = await collect(since, prev);
  const log: string[] = [];
  let items: Item[] = [];
  let model = "none";
  let llmErr = "";
  if (cmd === "run" && !flag("no-llm")) {
    try {
      const d = await distill(sigs, opt("model"));
      items = d.items;
      model = `${d.model} (${d.ms} ms)`;
      if (!items.length) llmErr = `no parsable items; raw: ${clip(d.raw, 200)}`;
    } catch (e) {
      llmErr = String(e).slice(0, 200);
    }
  }
  let res = { changed: [] as string[], skipped: [] as string[], edited: { mem: 0, skill: 0, rule: 0, ticket: 0, retire: 0 } };
  const sync: string[] = [];
  let commit = "not attempted";
  if (cmd === "run" && !flag("no-apply")) {
    // paths dirty before our edit are never committed (shared tree)
    const pre = new Set<string>();
    for (const p of ["CLAUDE.md", "docs/project/backlog.md"]) if (await dirty(p)) pre.add(p);
    res = await apply(items, sigs, log);
    for (const [name, c] of [
      ["just agents-sync", ["bun", "system/machine-ts/src/toolchain.ts"]],
      ["ai-os brain sync", ["bun", "frameworks/ai-os/src/brain/cli.ts", "sync"]],
    ] as const) {
      const x = await sh([...c], ROOT, 300_000);
      sync.push(`- ${name}: exit ${x.code}; ${clip((x.out + x.err).split("\n").filter(Boolean).slice(-3).join(" / "), 260)}`);
    }
    const commitPaths = res.changed.filter((p) => !pre.has(p));
    if (res.changed.length && commitPaths.length) {
      const x = await sh(["bun", "scripts/commit.ts", "-m", `learn: distilled ${commitPaths.length} item(s) from ${Object.keys(counts).join(",")} signals`, ...(process.env.LEARN_PUSH ? ["--push"] : []), ...commitPaths]);
      commit = `exit ${x.code}: ${clip(x.out + x.err, 200)} paths=${commitPaths.join(", ")}`;
    } else commit = res.changed.length ? `skipped, dirty before edit: ${[...pre].join(", ")}` : "nothing to commit";
  }
  const out = [
    `\n# Run ${t0.toISOString()} (${cmd}, since ${new Date(since).toISOString()})`,
    `\n## Signals collected (seen / kept as signal)`,
    ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v.seen} / ${v.kept}${v.note ? ` (${v.note})` : ""}`),
    `\n## Distillation (model ${model})${llmErr ? ` ERROR: ${llmErr}` : ""}`,
    `- items proposed: ${items.length}; applied: memory ${res.edited.mem}, skill ${res.edited.skill}, rule ${res.edited.rule}, ticket ${res.edited.ticket}, retired ${res.edited.retire}`,
    ...log,
    ...res.skipped.map((s) => `- rejected ${s}`),
    `\n## Signals fed to the model`,
    ...sigs.map((s) => `- ${s.id}${s.flag ? "!" : ""} [${s.cite}] ${s.text.slice(0, 160)}`),
    `\n## Apply`,
    ...sync,
    `- commit: ${commit}`,
  ].join("\n");
  const logText = redact(out);
  appendFileSync(`${RUNS}/${today()}.md`, logText + "\n");
  next.lastRun = t0.toISOString();
  if (cmd === "run") writeFileSync(STATE, JSON.stringify(next, null, 1));
  console.log(logText);
} finally {
  try {
    unlinkSync(LOCK);
  } catch {}
}
