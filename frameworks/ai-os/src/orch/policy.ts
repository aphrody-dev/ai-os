// Validation point for external effects (publishing, sending a message, spending): refused by default.
// Only an explicit owner rule in .agents/owner-rules.json allows them:
//   { "rules": [ { "effect": "external", "step": "<regex>", "command": "<regex>", "granted": "AAAA-MM-JJ", "note": "…" } ] }
// Both expressions are anchored (full match): "step" targets the exact id of a step (a generated step
// "publish.x" does not benefit from a "publish" rule), "command" the full line of a cmd step.
// The file is written by the owner only (absent = every external effect refused).
// A refused step is not executed: it goes to the "held" state and its content (draft) is queued
// in var/agents/outbox/<run>/<step>.json for review.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type OwnerRule = {
  effect: "external";
  step?: string;
  command?: string;
  granted?: string;
  note?: string;
};

export function ownerRules(root: string): OwnerRule[] {
  const f = join(root, ".agents", "owner-rules.json");
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(j.rules)
      ? j.rules.filter(
          (r: any) =>
            r?.effect === "external" &&
            (typeof r.step === "string" || typeof r.command === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

const full = (re: string, s: string) => {
  try {
    return new RegExp(`^(?:${re})$`).test(s);
  } catch {
    return false;
  }
};

/** Rule that allows this step's external effect, or null (refused). */
export function allowExternal(
  root: string,
  step: string,
  command = "",
): OwnerRule | null {
  return (
    ownerRules(root).find(
      (r) =>
        typeof r.step === "string" &&
        full(r.step, step) &&
        (r.command === undefined || full(r.command, command)),
    ) ?? null
  );
}

/** Queues a refused external effect for the owner; returns the path relative to the root. */
export function hold(
  root: string,
  run: string,
  step: string,
  payload: unknown,
): string {
  const rel = join("var", "agents", "outbox", run);
  mkdirSync(join(root, rel), { recursive: true });
  const f = join(rel, `${step.replace(/[^\w.-]/g, "_")}.json`);
  writeFileSync(
    join(root, f),
    JSON.stringify(
      {
        run,
        step,
        held_at: new Date().toISOString(),
        reason:
          "external effect without an owner rule (.agents/owner-rules.json)",
        payload,
      },
      null,
      2,
    ),
  );
  return f.replace(/\\/g, "/");
}
