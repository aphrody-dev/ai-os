// `<binary> auth login [service]` and `<binary> auth status`: one entry point for every sign-in. Services with their own
// flow (web sessions) are registered here; the others (gh, gcloud, cf, ...) are the CLI checks of auth.ts.
// The binary name is read from tools/identity.toml; no message names a script path.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readSession } from "./auth-paths.ts";
import { cliBinary, identityRoot } from "./identity.ts";
import { loginUri, parseLoginUri } from "./auth-toast.ts";
import type { AuthOptions, Check } from "./auth.ts";

export type Service = {
  id: string;
  aliases: string[];
  label: string;
  /** Current state; `deep` may start a browser, otherwise only the last recorded state is read. */
  probe: (deep: boolean) => Promise<Check>;
  /** Interactive sign-in (opens a window, watches it, closes it). 0 = signed in. */
  login: () => Promise<number>;
};

/** Modules of the monorepo loaded by path, so that env-kit keeps no static dependency on them. */
const load = async (rel: string[]) =>
  import(pathToFileURL(join(identityRoot(), ...rel)).href);

const HOST = process.platform === "win32" ? "pc" : "local";

export const geminiWeb: Service = {
  id: "gemini-web",
  aliases: ["gemini"],
  label: "Gemini web (gemini.google.com, relay Chrome)",
  async probe(deep) {
    const fix = `${cliBinary()} auth login gemini-web`;
    let ok: boolean | undefined;
    let proof = "";
    if (deep) {
      const m = await load([
        "frameworks",
        "ai-os",
        "src",
        "review",
        "gemini-web.ts",
      ]).catch(() => null);
      if (m) {
        const s = await m
          .probeSession()
          .catch((e: Error) => `error: ${e.message}`);
        ok = s === "ok";
        proof = `relay Chrome page -> ${s === "ok" ? "signed in" : s === "login" ? "not signed in" : String(s)}`;
      }
    }
    if (ok === undefined) {
      const s = readSession("gemini-web");
      ok = s?.ok;
      proof = s
        ? `last state ${new Date(s.at).toISOString()} -> ${s.ok ? "signed in" : (s.note ?? "not signed in")}`
        : "no recorded state";
    }
    return {
      kind: "browser",
      target: "gemini-web",
      host: HOST,
      status: ok === undefined ? "skip" : ok ? "ok" : "action",
      proof,
      fix: ok === false ? fix : undefined,
    };
  },
  async login() {
    const m = await load(["frameworks", "ai-os", "src", "relay", "web-login.ts"]);
    const r = await m.signInGeminiWeb({
      log: (s: string) => console.log(`[auth] ${s}`),
    });
    console.log(r.ok ? "Gemini web: signed in." : `Gemini web: ${r.note}.`);
    return r.ok ? 0 : 1;
  },
};

export const SERVICES: Service[] = [geminiWeb];

/** CLI targets of auth.ts under their service-style names. */
export const CLI_ALIASES: Record<string, string> = {
  github: "gh",
  cloudflare: "cf",
  google: "gcloud",
};

export const findService = (name: string, services = SERVICES) =>
  services.find((s) => s.id === name || s.aliases.includes(name));

export type Deps = {
  services: Service[];
  /** Existing CLI logins (auth.ts runAuth("login")). */
  runCli: (targets: string[]) => Promise<number>;
  /** Everything that needs the owner now (status checks, shallow). */
  attention: () => Promise<Check[]>;
  isTTY: boolean;
  ask: (question: string) => string | null;
  out: (s: string) => void;
};

/** What to log in, from the arguments: `[service...]`, `--uri <login uri>`, or nothing (list and pick). */
export async function dispatchLogin(args: string[], d: Deps): Promise<number> {
  const ui = args.indexOf("--uri");
  const uri = ui >= 0 ? (args[ui + 1] ?? "") : undefined;
  let targets = args.filter((a) => !a.startsWith("-") && a !== uri);
  if (uri !== undefined) {
    const s = parseLoginUri(uri);
    if (s === undefined) {
      d.out("unrecognized sign-in link");
      return 2;
    }
    if (s) targets = [s];
  }
  if (!targets.length) {
    const need = await d.attention();
    if (!need.length) {
      d.out("Nothing needs attention.");
      return 0;
    }
    if (!d.isTTY) targets = need.map((c) => c.target);
    else {
      d.out("Needs attention:");
      need.forEach((c, i) => d.out(`  ${i + 1}. ${c.target}  ${c.proof}`));
      const a = d.ask(
        `Sign in to which? [1-${need.length}, a = all, Enter = none] `,
      );
      if (!a) return 0;
      targets =
        a.trim().toLowerCase() === "a"
          ? need.map((c) => c.target)
          : a
              .split(/[\s,]+/)
              .map((n) => need[Number(n) - 1]?.target)
              .filter((t): t is string => !!t);
      if (!targets.length) return 2;
    }
  }
  let code = 0;
  const cli: string[] = [];
  for (const t of targets) {
    const svc = findService(t, d.services);
    if (svc) code ||= await svc.login();
    else cli.push(CLI_ALIASES[t] ?? t);
  }
  if (cli.length) code ||= await d.runCli(cli);
  return code;
}

/** Re-exported for the toast: link that opens the sign-in of one service. */
export { loginUri };
export type { AuthOptions };
