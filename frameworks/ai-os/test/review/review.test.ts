// ai-os review: scores per the archived verdict contract, target (paths, ranges, commit), anchoring (cached official
// sources, checklists), parallel voices then judge, engine fallback, sha256 cache + singleflight, NHITL,
// fix loop frozen after two rounds without progress, wiring into the orchestrator.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cachedEngine,
  collect,
  type Config,
  diffFiles,
  type Engine,
  mine,
  parseFindings,
  parseJudgeScore,
  parseScore,
  review,
  upsertIndex,
} from "../../src/review/index.ts";
import {
  excerpt,
  type Fetcher,
  SourceCache,
  topicsOf,
} from "../../src/review/sources.ts";
import { viaFile } from "../../src/llm/agents.ts";
import { software } from "../../src/orch/lifecycle.ts";
import { srcRoot } from "../../src/orch/fleet.ts";

const realConfig: Config = JSON.parse(
  readFileSync(join(import.meta.dir, "../../config/review.json"), "utf8"),
);

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const d = mkdtempSync(join(tmpdir(), "ai-os-review-"));
  temps.push(d);
  const g = (...a: string[]) => {
    const p = Bun.spawnSync(["git", "-C", d, ...a], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  g("init", "-q", "-b", "main");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
  g("add", ".");
  g("commit", "-q", "-m", "a");
  const first = g("rev-parse", "HEAD");
  writeFileSync(join(d, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(d, "run.sh"), "echo {{x}}\n");
  g("add", ".");
  g("commit", "-q", "-m", "b");
  mkdirSync(join(d, "docs", "reviews"), { recursive: true });
  writeFileSync(
    join(d, "docs", "reviews", "CHECKLISTS.md"),
    "# L\n\n## bun-ts\n- [ ] Object.hasOwn\n\n## shell-justfile\n- [ ] pas de {{param}}\n",
  );
  writeFileSync(
    join(d, "docs", "reviews", "INDEX.md"),
    "# Index\n\n| Doc | Score | Problèmes principaux | Statut |\n|---|---|---|---|\n| x | 7/20 | y | corrigé |\n",
  );
  return { d, first, g };
}

test("/20 score: all formats of the archived verdicts", () => {
  expect(parseScore("**Note : 11/20**")).toBe(11);
  expect(parseScore("Note : **12,5/20**.")).toBe(12.5);
  expect(parseScore("Score: 7 / 20 — triples faux")).toBe(7);
  expect(parseScore("- **Note** : 9,5/20.")).toBe(9.5);
  expect(parseScore("Note provisoire : **9,5/20**.")).toBe(9.5);
  expect(parseScore("note 11,5/20 sur la cohérence")).toBe(11.5);
  expect(parseScore("critère 2 / 6 seulement")).toBeUndefined();
  expect(parseScore("Note : 25/20")).toBeUndefined();
  expect(parseJudgeScore("Notes : Gemini 3,5/20, juge 4/20.")).toBe(4);
});

test("defects table (legacy French labels)", () => {
  const f = parseFindings(
    "Note : 9/20\n| # | fichier:ligne | gravité | défaut | correction | source |\n|---|---|---|---|---|---|\n| 1 | a.ts:3 | haute | injection | argv | checklist:shell-justfile |\n| x | pas une ligne | | | |\n",
  );
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({
    where: "a.ts:3",
    severity: "haute",
    source: "checklist:shell-justfile",
  });
});

test("target: numbered paths, range, commit, filter, refusal outside the root", async () => {
  const { d, first } = repo();
  const p = await collect(["src/a.ts"], { root: d });
  expect(p.kind).toBe("paths");
  expect(p.text).toContain("1| export const a = 2;");
  const r = await collect([`${first}..HEAD`], { root: d });
  expect(r.kind).toBe("revs");
  expect(r.files).toEqual(["run.sh", "src/a.ts"]);
  const c = await collect(["HEAD", "--", "src"], { root: d });
  expect(c.files).toEqual(["src/a.ts"]);
  expect(diffFiles(c.text)).toEqual(["src/a.ts"]);
  await expect(collect(["nope-xyz"], { root: d })).rejects.toThrow(
    /unknown target/,
  );
  await expect(collect(["HEAD", "--", "../x"], { root: d })).rejects.toThrow(
    /hors de src/,
  );
  await expect(
    collect(["--upload-pack=x..HEAD"], { root: d }),
  ).rejects.toThrow();
  const t = await collect(["src/a.ts"], { root: d, maxBytes: 10 });
  expect(t.truncated).toBeGreaterThan(0);
  expect(t.text).toContain("[truncated");
});

test("sources: topics, relevant excerpts, daily cache, stale copy offline", async () => {
  expect(topicsOf(["system/x/a.ts", "justfile"], realConfig.topics)).toEqual(
    expect.arrayContaining(["bun-ts", "shell-justfile"]),
  );
  const doc =
    "# T\n\nintro\n\n## Spawn\n\nAlways set a timeout on spawn calls.\n\n## Other\n\nunrelated text about colors\n";
  expect(excerpt(doc, "Bun.spawn timeout", 60)).toContain("timeout on spawn");
  const root = mkdtempSync(join(tmpdir(), "ai-os-review-src-"));
  let calls = 0;
  let fail = false;
  const f: Fetcher = async (s) => {
    calls++;
    if (fail) throw new Error("hors ligne");
    return {
      text: `# ${s.id}\n\nrègle`,
      commit: "a".repeat(40),
      url: `https://x/${s.id}`,
    };
  };
  const spec = {
    id: "s1",
    topics: ["*"],
    github: "google/eng-practices",
    path: "x.md",
  };
  const c = new SourceCache(root, f);
  expect((await c.get(spec))!.meta.commit).toBe("a".repeat(40));
  await c.get(spec);
  expect(calls).toBe(1); // moins d'un jour : pas de nouvel appel
  fail = true;
  const stale = await new SourceCache(root, f, 0).get(spec);
  expect(stale!.meta.stale).toBe(true);
  expect(stale!.text).toContain("règle");
  expect(existsSync(join(root, "var", "review", "sources", "index.json"))).toBe(
    true,
  );
});

const cfgFor = (): Config => ({
  ...realConfig,
  sources: [
    { id: "s1", topics: ["*"], github: "google/eng-practices", path: "x.md" },
  ],
  stale_rounds: 2,
  rounds: 5,
  // These stubs answer in the legacy markdown format.
  output: { strict: false },
});
const fakeSources = (root: string) =>
  new SourceCache(root, async () => ({
    text: "## Rule\n\nKeep CLs small.",
    commit: "b".repeat(40),
    url: "https://github.com/google/eng-practices/blob/b/x.md",
  }));

test("tribunal: parallel voices, judge with pleas, fallback, verdicts, INDEX, NHITL", async () => {
  const { d, first } = repo();
  const prompts: Record<string, string> = {};
  let inflight = 0;
  let peak = 0;
  const engine: Engine = async (p, prompt) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await Bun.sleep(20);
    inflight--;
    if (p === "broken")
      return { ok: false, text: "quota épuisé", cls: "quota", ms: 1 };
    prompts[p] = prompt;
    const n = p === "g" ? 12 : p === "c" ? 14 : 13;
    return {
      ok: true,
      text: `Score: ${n}/20\n## Defects\n| # | file:line | severity | defect | fix | source |\n|---|---|---|---|---|---|\n| 1 | src/a.ts:1 | moyenne | constante | nommer | s1 |\n`,
      ms: 5,
    };
  };
  const recorded: any[] = [];
  const r = await review({
    root: d,
    spec: [`${first}..HEAD`],
    config: cfgFor(),
    engine,
    providers: async (n) =>
      n === "gemini" ? ["broken", "g"] : n === "claude" ? ["c"] : ["j"],
    sources: fakeSources(d),
    nhitl: { record: (v) => recorded.push(v) },
    now: () => "2026-11-13",
    slug: "t",
  });
  expect(peak).toBe(2); // gemini et claude ensemble, juge ensuite
  expect(prompts.j).toContain("Plea of the Gemini voice");
  expect(prompts.j).toContain("Plea of the Claude voice");
  expect(prompts.g).toContain("Object.hasOwn"); // bun-ts section of CHECKLISTS.md injected
  expect(prompts.g).toContain("Keep CLs small");
  expect(r.score).toBe(13);
  expect(r.status).toBe("needs-fix");
  expect(r.voices.find((v) => v.voice === "gemini")!.provider).toBe("g");
  const judge = readFileSync(
    join(d, "docs", "reviews", "judge-2026-11-13-t.md"),
    "utf8",
  );
  expect(parseScore(judge)).toBe(13);
  expect(judge).toContain("eng-practices");
  expect(
    readFileSync(join(d, "docs", "reviews", "gemini-2026-11-13-t.md"), "utf8"),
  ).toContain("broken failed (quota");
  const idx = readFileSync(join(d, "docs", "reviews", "INDEX.md"), "utf8");
  expect(idx).toContain("](judge-2026-11-13-t.md)");
  expect(idx).toContain("| x | 7/20 | y | corrigé |");
  expect(recorded.every((v) => v.status === "fixed")).toBe(true);

  // Plus aucun moteur : violation NHITL ouverte, status "no-engine".
  recorded.length = 0;
  const none = await review({
    root: d,
    spec: ["src/a.ts"],
    config: cfgFor(),
    engine,
    providers: async () => [],
    sources: null,
    nhitl: { record: (v) => recorded.push(v) },
    write: false,
  });
  expect(none.status).toBe("no-engine");
  expect(
    recorded.filter(
      (v) => v.status === "open" && v.category === "engine_missing",
    ),
  ).toHaveLength(3);
});

test("boucle de correction : freeze after two rounds without progress, compliant at the threshold", async () => {
  const { d } = repo();
  let round = 0;
  const scores = [10, 12, 12, 11, 15];
  const engine: Engine = async (p) => ({
    ok: true,
    text: `Note : ${p === "j" ? scores[round - 1] : 9}/20`,
    ms: 1,
  });
  const fixes: number[] = [];
  const base = {
    root: d,
    spec: ["src/a.ts"],
    config: cfgFor(),
    engine,
    providers: async (n: string) => [n === "judge" ? "j" : "v"],
    sources: null,
    nhitl: null,
    write: false,
    fix: true,
    fixer: async (o: { round: number }) => {
      fixes.push(o.round);
      return { ok: true, note: "ok", ref: "HEAD" };
    },
    log: (e: Record<string, unknown>) => {
      if (e.ev === "round") round = e.round as number;
    },
  };
  const r = await review(base);
  expect(r.history).toEqual([10, 12, 12, 11]);
  expect(r.status).toBe("frozen");
  expect(fixes).toEqual([1, 2, 3]);

  round = 0;
  scores.splice(0, scores.length, 14, 17);
  fixes.length = 0;
  const ok = await review(base);
  expect(ok.status).toBe("compliant");
  expect(ok.history).toEqual([14, 17]);
  expect(fixes).toEqual([1]);
});

test("engine: sha256 key + singleflight + relay cache, failures not kept", async () => {
  let n = 0;
  const call = (async (_h: unknown, p: string) => {
    n++;
    await Bun.sleep(20);
    return p === "bad"
      ? { ok: false, text: "x", cls: "quota", ms: 1, tokens: 0 }
      : { ok: true, text: "Note : 12/20", ms: 1, tokens: 1 };
  }) as any;
  const e = cachedEngine(
    { id: "t", local: true, src: ".", roles: [], maxAgents: 1 },
    { db: ":memory:", call },
  );
  const [a, b] = await Promise.all([e("p", "x", 1000), e("p", "x", 1000)]);
  expect(n).toBe(1);
  expect([a.cache, b.cache].sort()).toEqual(["coalesced", "miss"]);
  await Bun.sleep(10);
  expect((await e("p", "x", 1000)).cache).toBe("hit");
  expect(n).toBe(1);
  await e("bad", "x", 1000);
  await e("bad", "x", 1000);
  expect(n).toBe(3);
});

test("INDEX: row replaced by key, otherwise appended", () => {
  const base =
    "| Doc | Score | P | S |\n|---|---|---|---|\n| a ([v](judge-x.md)) | 1/20 | p | s |\n";
  expect(
    upsertIndex(
      base,
      "](judge-x.md)",
      "| a ([v](judge-x.md)) | 2/20 | p | s |",
    ),
  ).not.toContain("1/20");
  expect(
    upsertIndex(base, "](judge-y.md)", "| b |").trim().split("\n"),
  ).toHaveLength(4);
});

test("mining: scores of the real verdicts in docs/reviews", () => {
  const m = mine(srcRoot());
  const ai = m.verdicts.find((v) => v.file === "gemini-2026-11-13-ai-os.md");
  if (!ai) return; // partial repository
  expect(ai.score).toBe(11);
  expect(
    m.verdicts.find((v) => v.file === "judge-2026-11-13-ci.md")?.score,
  ).toBe(4);
  expect(m.byVoice.gemini!.n).toBeGreaterThan(10);
});

test("orchestrateur : le cycle software passe par le tribunal, consigne agy longue par fichier", () => {
  const wf = software({ paths: ["frameworks/ai-os"] });
  const r = wf.steps.find((s) => s.id === "review")!;
  expect(r.tool).toBe("review");
  expect(wf.steps.find((s) => s.id === "fix")!.deps).toEqual(["review"]);
  expect(wf.steps.some((s) => s.tool === "gemini_review")).toBe(false);
  const msg = viaFile("x".repeat(9000));
  const file = msg.match(/file (.+?) \(/)![1]!;
  expect(readFileSync(file, "utf8")).toHaveLength(9000);
  rmSync(dirname(file), { recursive: true, force: true });
});

test("guardrails: confined slug, secrets dropped and redacted, defects table only (legacy French heading), truncated review never compliant", async () => {
  const { d, g } = repo();
  writeFileSync(join(d, ".env"), "TOKEN=x\n");
  writeFileSync(
    join(d, "src", "k.ts"),
    `const k = '${"ghp_" + "A".repeat(28)}';\n`,
  );
  g("add", "-f", ".env", "src/k.ts");
  g("commit", "-q", "-m", "c");
  const c = await collect([".", "--"], { root: d }).catch(() =>
    collect(["src", ".env"], { root: d }),
  );
  expect(c.files).not.toContain(".env");
  expect(c.text).not.toContain("ghp_" + "AAAA");
  expect(c.text).toContain("[secret]");
  expect(
    parseFindings(
      "| # | a | b | c | d |\n| 1 | grief | x | y | z |\n## Défauts\n| # | f | g | d | c | s |\n| 1 | a.ts:1 | haute | vrai | fix | - |\n## Synthèse\n| 2 | x | y | z | w |",
    ),
  ).toHaveLength(1);
  const engine: Engine = async () => ({
    ok: true,
    text: "Note : 19/20",
    ms: 1,
  });
  const base = {
    root: d,
    config: { ...cfgFor(), max_bytes: 40 },
    engine,
    providers: async () => ["e"],
    sources: null,
    nhitl: null,
    write: false,
  };
  await expect(
    review({ ...base, spec: ["src/a.ts"], slug: "../../x" }),
  ).rejects.toThrow(/invalid slug/);
  const r = await review({ ...base, spec: ["src/a.ts"] });
  expect(r.score).toBe(19);
  expect(r.status).toBe("incomplete");
});
