// Council + fallback routing. Replaces the two legacy copies (ai-triad/src/runners/triad-runner.ts,
// ai-os/src/triad/index.ts). Members are discovered models (../llm) or external agent CLIs (claude, codex, gemini, agy).
import { resolveExe } from "../llm/agents";
import { generateText } from "../llm/generate";
import type { LanguageModel } from "../llm/types";
import { redactText } from "./secrets";

export type Member =
  | { id: string; kind: "model"; model: LanguageModel }
  | { id: string; kind: "cli"; argv: (prompt: string) => string[] };

export type MemberResult = {
  id: string;
  ok: boolean;
  output: string;
  durationMs: number;
  error?: string;
  quota?: boolean;
};

const QUOTA_RE =
  /(rate[ _-]?limit|429|quota|insufficient_quota|credit balance|too many requests|resource_exhausted|overloaded)/i;

/** argv builders for agent CLIs found on PATH (non-interactive print mode). */
export const CLI: Record<string, (p: string) => string[]> = {
  claude: (p) => ["claude", "-p", p, "--output-format", "text"],
  codex: (p) => ["codex", "exec", p, "--skip-git-repo-check"],
  gemini: (p) => ["gemini", "-p", p],
  agy: (p) => ["agy", "-p", p, "--output-format", "text"],
  fx: (p) => ["fx", "ask", p],
};

export async function ask(
  m: Member,
  prompt: string,
  timeoutMs = 120_000,
): Promise<MemberResult> {
  const t0 = performance.now();
  const done = (ok: boolean, output: string, error?: string): MemberResult => ({
    id: m.id,
    ok,
    output: redactText(output, Bun.env),
    durationMs: Math.round(performance.now() - t0),
    error: error && redactText(error, Bun.env),
    quota: !!error && QUOTA_RE.test(error),
  });
  try {
    if (m.kind === "model") {
      const r = await generateText({
        model: m.model,
        prompt,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return done(true, r.text);
    }
    const rawArgv = m.argv(prompt);
    const argv = [resolveExe(rawArgv[0]!), ...rawArgv.slice(1)];
    const p = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return code === 0
      ? done(true, out.trim())
      : done(false, out, err || `exit ${code}`);
  } catch (e) {
    return done(false, "", e instanceof Error ? e.message : String(e));
  }
}

/** Try members in order until one succeeds. */
export async function route(chain: Member[], prompt: string) {
  const trail: string[] = [];
  let last: MemberResult | undefined;
  for (const m of chain) {
    const r = await ask(m, prompt);
    trail.push(`${m.id}:${r.ok ? "ok" : r.quota ? "quota" : "err"}`);
    if (r.ok) return { ...r, trail };
    last = r;
  }
  return {
    ...(last ?? {
      id: "none",
      ok: false,
      output: "",
      durationMs: 0,
      error: "empty chain",
    }),
    trail,
  };
}

/** Ask all members in parallel and produce a markdown consensus report. */
export async function council(members: Member[], prompt: string) {
  const findings = await Promise.all(members.map((m) => ask(m, prompt)));
  const ok = findings.filter((f) => f.ok).length;
  const summary = [
    `# Council (${ok}/${findings.length} responded)`,
    ...findings.map(
      (f) =>
        `\n## ${f.id} (${f.ok ? "ok" : "failed"}, ${f.durationMs}ms)\n${f.ok ? f.output : `Error: ${f.error}`}`,
    ),
  ].join("\n");
  return { prompt, findings, succeeded: ok, summary };
}
