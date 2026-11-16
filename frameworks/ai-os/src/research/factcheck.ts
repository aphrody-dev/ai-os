// Fact-check (replaces legacy knowledge-engine/src/factcheck/verifier.ts): extract atomic claims, verify each
// against fetched sources with a subagent, return verdicts + markdown report.
import { generateText } from "../llm/generate";
import type { LanguageModel, ToolSet } from "../llm/types";

export type Verdict = {
  claim: string;
  status: "supported" | "refuted" | "uncertain";
  evidence: string;
};

const json = (t: string) => {
  const m = t.match(/[[{][\s\S]*[\]}]/);
  try {
    return m ? JSON.parse(m[0]) : undefined;
  } catch {
    return undefined;
  }
};

export async function factCheck(
  text: string,
  model: LanguageModel,
  tools?: ToolSet,
  maxClaims = 12,
): Promise<Verdict[]> {
  const ex = await generateText({
    model,
    prompt: `List the atomic, checkable factual claims in the text below (max ${maxClaims}). Return ONLY a JSON array of strings.\n\n${text}`,
  });
  const claims: string[] = (json(ex.text) ?? [])
    .filter((c: unknown) => typeof c === "string")
    .slice(0, maxClaims);
  return Promise.all(
    claims.map(async (claim) => {
      const r = await generateText({
        model,
        tools,
        maxSteps: 6,
        prompt: `Verify this claim using the tools (fetch primary sources). Return ONLY JSON {"status":"supported"|"refuted"|"uncertain","evidence":"<source URL + quote>"}.\n\nClaim: ${claim}`,
      });
      const v = json(r.text) ?? {};
      const status = ["supported", "refuted", "uncertain"].includes(v.status)
        ? v.status
        : "uncertain";
      return { claim, status, evidence: String(v.evidence ?? "") } as Verdict;
    }),
  );
}

export function factCheckReport(v: Verdict[]) {
  const n = (s: Verdict["status"]) => v.filter((x) => x.status === s).length;
  return [
    `# Fact-check: ${n("supported")} supported, ${n("refuted")} refuted, ${n("uncertain")} uncertain`,
    ...v.map((x) => `- **${x.status}** ${x.claim}\n  ${x.evidence}`),
  ].join("\n");
}
