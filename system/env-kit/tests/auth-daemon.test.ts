// auth daemon: a credential waiting on the owner is reported only once per 24 h.
import { expect, test } from "bun:test";
import { due, needsOwner } from "../src/auth-daemon";

const c = (target: string, status: string) =>
  ({ kind: "cli", target, host: "pc", status, proof: "" }) as any;

test("signalement au plus une fois par 24 h et par identifiant", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const checks = [
    c("npm", "action"),
    c("gh", "ok"),
    c("cf", "invalid"),
    c("agy", "skip"),
  ];
  expect(checks.filter(needsOwner).map((x) => x.target)).toEqual(["npm", "cf"]);
  const prompts = { "pc/npm": now - 3_600_000, "pc/cf": now - 86_400_001 };
  expect(due(checks, prompts, now).map((x) => x.target)).toEqual(["cf"]);
  expect(due(checks, {}, now).map((x) => x.target)).toEqual(["npm", "cf"]);
  expect(needsOwner({ ...c("NPM_TOKEN", "action"), kind: "oidc" })).toBe(false);
});

test("Linux runner: only gh, claude, codex and storage are probed", async () => {
  const { scope } = await import("../src/auth-daemon");
  const checks = [
    c("gh", "ok"),
    c("gh-scopes", "action"),
    c("cf", "invalid"),
    c("claude", "ok"),
    c("codex", "ok"),
    { ...c("systemd-creds-user", "ok"), kind: "store" },
  ];
  expect(scope(checks, false).map((x) => x.target)).toEqual([
    "gh",
    "claude",
    "codex",
    "systemd-creds-user",
  ]);
  expect(scope(checks, true)).toHaveLength(6);
});
