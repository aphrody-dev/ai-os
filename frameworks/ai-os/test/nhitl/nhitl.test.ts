// Index NHITL : classement des fins de tour, expurgation, lecture de la file, remplacement par source et tri humain.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NHITL_DB = join(
  mkdtempSync(join(tmpdir(), "ai-os-nhitl-")),
  "nhitl.sqlite",
);
const { Index, redact, fingerprint } = await import("../../src/nhitl/index.ts");
const { classifyTail, parseQueueDump, scanLedger } =
  await import("../../src/nhitl/scanners.ts");

test("fins de tour qui rendent la main", () => {
  expect(
    classifyTail("Tout est poussé. Veux-tu que je lance aussi le déploiement ?")
      ?.category,
  ).toBe("conditional_offer");
  expect(
    classifyTail("Commit abc123. J'attends ton feu vert pour la suite.")
      ?.category,
  ).toBe("passive_wait");
  expect(
    classifyTail("Fait.\n\nReste au propriétaire : cliquer Authorize.")
      ?.category,
  ).toBe("owner_todo");
  expect(classifyTail("Quel port préfères-tu ?")?.category).toBe(
    "final_question",
  );
  expect(
    classifyTail("Commits a1b2c3 et d4e5f6 poussés sur main."),
  ).toBeUndefined();
});

test("aucun secret dans les extraits", () => {
  const s = redact(
    `clé ${"sk-ant-oat01-" + "A".repeat(24)} et ${"ghp_" + "B".repeat(24)} fin`,
  );
  expect(s).not.toContain("sk-ant");
  expect(s).not.toContain("ghp_");
  expect(redact("x".repeat(500)).length).toBeLessThanOrEqual(160);
});

test("agent queue: auth failure, requeue, held effect", () => {
  const dump = [
    "@@failed /q/failed/t1.json",
    JSON.stringify({ id: "t1", role: "coder" }),
    "@@result t1",
    JSON.stringify({
      id: "t1",
      status: "failed",
      attempts: [{ provider: "claude", reason: "provider_unavailable" }],
    }),
    "@@new /q/new/t2.json",
    JSON.stringify({ id: "t2", role: "growth", approval: "owner" }),
    "@@outbox /x/outbox/run/step.json",
  ].join("\n");
  const v = parseQueueDump("prd", dump);
  expect(v.map((x) => x.category).sort()).toEqual([
    "held_effect",
    "owner_approval",
    "queue_failed_auth",
  ]);
});

test("remplacement par source et tri persistant", () => {
  const ix = new Index();
  const mk = (n: string) => ({
    id: fingerprint("code", n),
    source: "code" as const,
    location: n,
    category: "interactive_prompt",
    severity: "high" as const,
    excerpt: n,
    fix: "f",
    status: "open" as const,
  });
  ix.replace("code", [mk("a"), mk("b")]);
  ix.triage(mk("a").id, "inevitable", "garde-fou");
  ix.replace("code", [mk("a")]);
  const rows = ix.list({ source: "code" }) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("inevitable");
  expect((ix.list({ q: "interactive_prompt" }) as any[]).length).toBe(1);
  ix.close();
});

test("versioned registry readable", () => {
  const l = scanLedger();
  expect(l.length).toBeGreaterThan(5);
  expect(
    l.every((e) => ["open", "fixed", "inevitable"].includes(e.status)),
  ).toBe(true);
});
