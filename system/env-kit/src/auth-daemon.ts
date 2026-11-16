/**
 * `ay auth daemon`: a single authentication service per host, instead of sign-in retries.
 *
 * - Probes the real state of each credential every `--every` minutes (5 by default): `auth-state.json` is
 *   never older than that period, and `ay auth status` stays a direct probe (no cache).
 * - Refreshes on its own whatever refreshes without a human (`repair` without a browser: keychain gh token, CI secrets,
 *   tunnels, ssh keys); tokens with a refresh token (gcloud, service-account impersonation, codex, claude
 *   setup-token) renew inside their CLI at each probe.
 * - Last resort: a credential that requires a click is reported once per 24 h, all grouped in a
 *   single toast; no page is opened until the owner clicks it: the click runs `<binary> auth login <target>`
 *   (auth-toast.ts, auth-services.ts), a single sign-in for that target.
 * Files: <state>/auth-state.json (last probe), <state>/auth-prompts.json (last reports).
 */
import { readJson, stateDir, writeJson } from "./auth-paths.ts";
import { loginUri, notify } from "./auth-toast.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuthOptions,
  type Check,
  collectChecks,
  type Manifest,
  runAuth,
} from "./auth";
import { secretGet, secretList } from "@aphrody/env-kit/vault/sync";

const DAY = 86_400_000;

/** The PC holds the reference vault: CI secrets, OIDC, fleet, tunnels and API tokens are probed and pushed from it. */
const PC =
  process.platform === "win32" || process.env.AY_AUTH_REFRESH_ALL === "1";
/**
 * Credentials a Linux runner needs (tools/agents/runner.ts: gh for push, claude and codex for the
 * tasks); the other CLIs (cf, wrangler, vercel, gcloud, gh admin scopes) are the PC's business, which pushes the
 * values. AY_AUTH_TARGETS (comma-separated list) replaces this list.
 */
export const RUNNER_TARGETS = (process.env.AY_AUTH_TARGETS ?? "gh,claude,codex")
  .split(",")
  .filter(Boolean);
export const scope = (checks: Check[], pc = PC) =>
  pc
    ? checks
    : checks.filter(
        (c) => c.kind === "store" || RUNNER_TARGETS.includes(c.target),
      );

export { stateDir };

const key = (c: Check) => `${c.host}/${c.target}`;
/** Credential that waits for a human gesture (not a mere missing tool). */
// Only a person's credentials (CLI, browser, API tokens) can require their gesture; CI, OIDC, fleet
// or unit gaps are agent work, kept in auth-state.json but never reported to the owner.
const OWNER_KINDS = new Set(["cli", "browser", "token", "store"]);
export const needsOwner = (c: Check) =>
  OWNER_KINDS.has(c.kind) && (c.status === "action" || c.status === "invalid");

/** Targets to report now: at most once per 24 h each. */
export function due(
  checks: Check[],
  prompts: Record<string, number>,
  now = Date.now(),
): Check[] {
  return checks.filter(
    (c) => needsOwner(c) && now - (prompts[key(c)] ?? 0) >= DAY,
  );
}

export async function pass(m: Manifest, o: AuthOptions, refresh: boolean) {
  const at = new Date().toISOString();
  // Vault values on each pass: a token rotated elsewhere does not leave a stale copy in the environment.
  for (const n of secretList()) {
    // Value without a line ending: systemd-creds often returns a trailing \n, refused in an HTTP header.
    const v = secretGet(n)?.trim();
    if (v) process.env[n] = v;
  }
  // Refresh without a human first, then the probe that is authoritative.
  // The PC (reference vault) repairs everything; the other hosts only their CLIs and their storage, so that no
  // host pushes its copies to the GitHub secrets or the fleet.
  const only = PC ? o.only : ["cli", "store"];
  if (refresh)
    await collectChecks(m, { ...o, only, browser: false }, true).catch(
      () => [],
    );
  const checks = scope(
    await collectChecks(
      m,
      { ...o, only: PC ? o.only : ["cli", "store"], browser: false },
      false,
    ),
  );
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "auth-state.json"), { at, checks });
  const pf = join(dir, "auth-prompts.json");
  const prompts = readJson<Record<string, number>>(pf, {});
  const now = Date.now();
  const d = due(checks, prompts, now);
  if (d.length) {
    // One toast for the lot; one click opens the sign-in (of the single target, or the picker for several).
    notify(
      `${d.length} credential(s) to reconnect`,
      d.map((c) => `${key(c)} : ${c.fix ?? c.proof}`),
      loginUri(d.length === 1 ? d[0]!.target : ""),
    );
    for (const c of d) prompts[key(c)] = now;
    writeJson(pf, prompts);
  }
  return {
    at,
    total: checks.length,
    owner: checks.filter(needsOwner).map(key),
    notified: d.map(key),
  };
}

export async function daemon(m: Manifest, o: AuthOptions): Promise<number> {
  const a = o.args ?? [];
  const opt = (n: string) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const every = Math.max(1, Number(opt("--every") ?? 5)) * 60_000;
  const refreshEvery = Math.max(every, Number(opt("--refresh") ?? 30) * 60_000);
  let lastRefresh = 0;
  do {
    const refresh = Date.now() - lastRefresh >= refreshEvery;
    if (refresh) lastRefresh = Date.now();
    const r = await pass(m, o, refresh);
    console.log(JSON.stringify(r));
    if (a.includes("--once")) break;
    await Bun.sleep(every);
  } while (true);
  return 0;
}

/** Last probe if it is younger than `maxAgeMs` (5 min by default), otherwise undefined: never a stale state. */
export function lastState(
  maxAgeMs = 5 * 60_000,
): { at: string; checks: Check[] } | undefined {
  const p = join(stateDir(), "auth-state.json");
  if (!existsSync(p)) return undefined;
  const s = readJson<{ at: string; checks: Check[] } | undefined>(p, undefined);
  return s && Date.now() - Date.parse(s.at) <= maxAgeMs ? s : undefined;
}
