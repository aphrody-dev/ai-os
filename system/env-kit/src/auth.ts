// SPDX-License-Identifier: Apache-2.0
/**
 * `ay auth` / `env-kit auth`: one idempotent pass over every authentication and network access of
 * the fleet. `status` only reads; `repair` fixes what needs no password; `gh-secrets` pushes GitHub
 * Actions secrets from the OS store; `tunnels` moves cloudflared tokens into systemd credentials.
 *
 * The inventory (hosts, tunnels, WireGuard interfaces, renewal units, GitHub secrets) is the
 * `[nodes.*]` and `[auth.*]` tables of device/deploy.toml. Secret values come from the OS store
 * (@aphrody/env-kit/vault/sync), then from `.env`; they are never printed. Browser logins (gcloud, npm, vercel,
 * wrangler) only start with `--browser`: they open the default Chrome profile, where the owner
 * clicks the sign-in and consent screens himself.
 */

import { spawnSync } from "./spawn.ts";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveSecret,
  secretGet,
  secretHas,
  secretList,
  secretSet,
  storeInfo,
} from "@aphrody/env-kit/vault/sync";
import { whoami } from "./whoami";
import { expandSync } from "./discover.ts";

export type Status = "ok" | "fixed" | "invalid" | "missing" | "action" | "skip";

export interface Check {
  kind: string;
  target: string;
  host: string;
  status: Status;
  /** Command and its non-secret result. */
  proof: string;
  /** What the owner (or `repair --browser`) has to do when the status is not ok. */
  fix?: string;
}

interface HostAuth {
  tunnels?: Record<string, string>;
  wireguard?: string[];
  units?: string[];
  repair?: boolean;
}

export interface Manifest {
  nodes: Record<
    string,
    { ssh_alias: string; ssh_user?: string; role?: string }
  >;
  auth: {
    github?: {
      repo_secrets?: Record<string, string[]>;
      org_secrets?: Record<string, string[]>;
    };
    hosts?: Record<string, HostAuth>;
    /** WireGuard public keys known to be leaked: any peer still using one is reported invalid. */
    wireguard?: { revoked?: string[] };
    /** Keyless CI: GitHub Actions OIDC federations, and the long-lived secrets each one replaces. */
    oidc?: { gcp?: OidcGcp; replaces?: Record<string, string> };
  };
  cloud?: { cloudflare_account_id?: string };
}

export interface OidcGcp {
  project: string;
  project_number: string;
  pool: string;
  provider: string;
  issuer: string;
  /** CEL condition on the GitHub OIDC claims (mandatory for the GitHub issuer); no spaces (gcloud.cmd goes through cmd.exe). */
  condition: string;
  service_account: string;
  repos: string[];
  /** gcloud account that administers the pool (project owner). */
  account: string;
}

export interface AuthOptions {
  root: string;
  json?: boolean;
  only?: string[];
  browser?: boolean;
  dryRun?: boolean;
  /** Positional arguments after the subcommand (login targets, mint provider and command). */
  args?: string[];
  /** Probe the services that need a browser (status): otherwise only their last recorded state is read. */
  deep?: boolean;
  /** Persist a renewed credential (store + .env + user env); provided by the CLI. */
  persist?: (key: string, value: string) => void;
}

const CMD_SHIMS = new Set(["gcloud", "npm", "agy"]);

const LOCAL =
  process.platform === "win32" ? "pc" : (process.env.HOSTNAME ?? "local");

/** No local browser: ssh session, or Linux without a display. Logins then use the device flow (RFC 8628). */
export const HEADLESS =
  !!process.env.SSH_CONNECTION ||
  (process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY);

function sh(
  cmd: string,
  args: string[],
  opts: { input?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    timeout: opts.timeout ?? 30_000,
    env: opts.env ?? process.env,
    // Only the .cmd shims need cmd.exe; their arguments never contain spaces or quotes.
    shell: process.platform === "win32" && CMD_SHIMS.has(cmd),
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    code: r.status ?? -1,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

const has = (cmd: string): boolean =>
  process.platform === "win32"
    ? sh("where", [cmd], { timeout: 5000 }).ok
    : sh("sh", ["-c", `command -v ${cmd}`], { timeout: 5000 }).ok;

/** Keep the first line, drop anything that looks like a credential. */
function clean(s: string, max = 140): string {
  return s
    .split("\n")[0]!
    .replace(
      /(gh[pousr]_|github_pat_|cfat_|cfut_|npm_|sk-|AIza|eyJ)[A-Za-z0-9_\-.]+/g,
      "<redacted>",
    )
    .slice(0, max);
}

export function loadManifest(root: string): Manifest {
  const raw = expandSync(readFileSync(join(root, "device", "deploy.toml"), "utf8"));
  const m = Bun.TOML.parse(raw) as unknown as Manifest;
  m.auth ??= {};
  return m;
}

// --- Local CLIs --------------------------------------------------------------------------------

function checkGh(o: AuthOptions): Check[] {
  if (!has("gh"))
    return [
      {
        kind: "cli",
        target: "gh",
        host: LOCAL,
        status: "missing",
        proof: "gh missing",
      },
    ];
  const r = sh("gh", ["api", "user", "-q", ".login"]);
  const out: Check[] = [];
  if (r.ok)
    out.push({
      kind: "cli",
      target: "gh",
      host: LOCAL,
      status: "ok",
      proof: `gh api user -> ${r.out}`,
    });
  else {
    // The env token may be stale while the keyring login is fine: re-export the keyring token.
    const env = { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" };
    const k = sh("gh", ["api", "user", "-q", ".login"], { env });
    if (k.ok && o.persist && !o.dryRun) {
      const t = sh("gh", ["auth", "token"], { env });
      if (t.ok && t.out) o.persist("GITHUB_TOKEN", t.out);
      out.push({
        kind: "cli",
        target: "gh",
        host: LOCAL,
        status: "fixed",
        proof: `keyring login ${k.out}; GITHUB_TOKEN/GH_TOKEN re-exported`,
      });
    } else if (o.browser && !o.dryRun) {
      // Device flow (one-time code): gh prints the code, the owner approves it once in any browser.
      const l = spawnSync(
        "gh",
        [
          "auth",
          "login",
          "--hostname",
          "github.com",
          "--git-protocol",
          "ssh",
          "--web",
          ...(HEADLESS ? [] : ["--clipboard"]),
          "--scopes",
          "workflow,admin:org",
        ],
        { stdio: "inherit", timeout: 600_000, env },
      );
      const again = sh("gh", ["api", "user", "-q", ".login"], { env });
      if (again.ok && o.persist) {
        const t = sh("gh", ["auth", "token"], { env });
        if (t.ok && t.out) o.persist("GITHUB_TOKEN", t.out);
      }
      out.push({
        kind: "cli",
        target: "gh",
        host: LOCAL,
        status: again.ok ? "fixed" : "action",
        proof: `gh auth login --web (device code) -> ${l.status === 0 ? again.out : `code ${l.status}`}`,
      });
    } else
      out.push({
        kind: "cli",
        target: "gh",
        host: LOCAL,
        status: "invalid",
        proof: clean(r.err),
        fix: "ay auth login gh (device code, un clic)",
      });
  }
  const scopes = sh("gh", ["api", "-i", "user"]);
  const line = scopes.out.split("\n").find((l) => /^x-oauth-scopes:/i.test(l));
  if (line) {
    const s = line.slice(line.indexOf(":") + 1).trim();
    const need = ["repo", "workflow", "admin:org"].filter(
      (x) => !s.split(/,\s*/).includes(x),
    );
    out.push({
      kind: "cli",
      target: "gh-scopes",
      host: LOCAL,
      status: need.length ? "action" : "ok",
      proof: `x-oauth-scopes: ${s}`,
      fix: need.length
        ? `gh auth refresh -s ${need.join(",")} (navigateur)`
        : undefined,
    });
  }
  if (o.persist && !o.dryRun) sh("gh", ["auth", "setup-git"]);
  return out;
}

function checkGcloud(o: AuthOptions): Check[] {
  if (!has("gcloud"))
    return [
      {
        kind: "cli",
        target: "gcloud",
        host: LOCAL,
        status: "missing",
        proof: "gcloud missing",
      },
    ];
  const cfg = sh(
    "gcloud",
    ["config", "configurations", "list", "--format=json"],
    { timeout: 60_000 },
  );
  const auth = sh("gcloud", ["auth", "list", "--format=json"], {
    timeout: 60_000,
  });
  if (!cfg.ok || !auth.ok)
    return [
      {
        kind: "cli",
        target: "gcloud",
        host: LOCAL,
        status: "invalid",
        proof: clean(cfg.err || auth.err),
      },
    ];
  const accounts = new Set(
    (JSON.parse(auth.out) as { account: string }[]).map((a) => a.account),
  );
  const out: Check[] = [];
  for (const c of JSON.parse(cfg.out) as {
    name: string;
    properties?: { core?: { account?: string } };
  }[]) {
    const acct = c.properties?.core?.account;
    if (!acct) continue;
    const target = `gcloud:${c.name}`;
    if (accounts.has(acct)) {
      const tok = sh(
        "gcloud",
        ["auth", "print-access-token", acct, "--quiet"],
        { timeout: 60_000 },
      );
      out.push({
        kind: "cli",
        target,
        host: LOCAL,
        status: tok.ok ? "ok" : "invalid",
        proof: `gcloud auth print-access-token ${acct} -> ${tok.ok ? "token issued (not displayed)" : clean(tok.err)}`,
        fix: tok.ok ? undefined : `gcloud auth login ${acct} (navigateur)`,
      });
      continue;
    }
    const sa = acct.endsWith(".iam.gserviceaccount.com");
    if (!sa && o.browser && !o.dryRun && !HEADLESS) {
      const r = sh(
        "gcloud",
        ["auth", "login", acct, "--brief", "--update-adc"],
        { timeout: 600_000 },
      );
      out.push({
        kind: "cli",
        target,
        host: LOCAL,
        status: r.ok ? "fixed" : "action",
        proof: `gcloud auth login ${acct} -> ${r.ok ? "ok" : clean(r.err)}`,
      });
      if (r.ok) accounts.add(acct);
      continue;
    }
    out.push({
      kind: "cli",
      target,
      host: LOCAL,
      status: "action",
      proof: `gcloud auth list: ${acct} without credentials`,
      fix: sa
        ? `keyless: ay auth mint gcp --sa ${acct} -- <cmd> (impersonation, 1 h token)`
        : HEADLESS
          ? `browserless: ay auth mint gcp --sa <service account> -- <cmd>`
          : `ay auth login gcloud (gcloud auth login ${acct})`,
    });
  }
  const adc = sh(
    "gcloud",
    ["auth", "application-default", "print-access-token", "--quiet"],
    { timeout: 60_000 },
  );
  out.push({
    kind: "cli",
    target: "gcloud:adc",
    host: LOCAL,
    status: adc.ok ? "ok" : "action",
    proof: `gcloud auth application-default print-access-token -> ${adc.ok ? "token issued (not displayed)" : clean(adc.err)}`,
    fix: adc.ok
      ? undefined
      : "gcloud auth application-default login (navigateur)",
  });
  return out;
}

interface Simple {
  target: string;
  bin: string;
  args: string[];
  ok: (r: ReturnType<typeof sh>) => string | false;
  /** Login command, device flow first when there is no local browser. */
  login?: (headless: boolean) => string[];
  fix: string;
  /** Persist the renewed token after a browser login. */
  after?: () => [string, string] | undefined;
}

const npmToken = (): [string, string] | undefined => {
  const r = sh("npm", ["config", "get", "//registry.npmjs.org/:_authToken"]);
  return r.ok && r.out && r.out !== "undefined" && r.out !== "null"
    ? ["NPM_TOKEN", r.out]
    : undefined;
};

const SIMPLE: Simple[] = [
  {
    target: "cf",
    bin: "cf",
    args: ["whoami", "--json"],
    fix: "CLOUDFLARE_API_TOKEN (ay secret set) ; agents : ay auth mint cloudflare",
    login: () => ["auth", "login"],
    ok: (r) => {
      try {
        const j = JSON.parse(r.out);
        return j.authenticated && j.tokenValid
          ? `authenticated, ${j.authSource}`
          : false;
      } catch {
        return false;
      }
    },
  },
  {
    target: "wrangler",
    bin: "wrangler",
    args: ["whoami", "--json"],
    fix: "CLOUDFLARE_API_TOKEN or ay auth login wrangler (--device, browserless)",
    login: (h) => ["login", ...(h ? ["--device"] : [])],
    ok: (r) => (r.ok ? "whoami --json ok" : false),
  },
  {
    target: "vercel",
    bin: "vercel",
    args: ["whoami"],
    fix: "ay auth login vercel",
    login: () => ["login"],
    ok: (r) => (r.ok ? r.out.split("\n").pop()! : false),
  },
  {
    target: "npm",
    bin: "npm",
    args: ["whoami"],
    fix: "ay auth login npm (npm login --auth-type=web)",
    login: () => ["login", "--auth-type=web"],
    ok: (r) => (r.ok ? r.out : false),
    after: npmToken,
  },
  {
    target: "claude",
    bin: "claude",
    args: ["auth", "status"],
    fix: "ay auth login claude; browserless host: claude setup-token",
    login: (h) => (h ? ["setup-token"] : ["auth", "login"]),
    ok: (r) => {
      try {
        const j = JSON.parse(r.out);
        return j.loggedIn ? `loggedIn, ${j.authMethod}` : false;
      } catch {
        return false;
      }
    },
  },
  {
    target: "codex",
    bin: "codex",
    args: ["login", "status"],
    fix: "ay auth login codex (--device-auth, browserless)",
    login: (h) => ["login", ...(h ? ["--device-auth"] : [])],
    ok: (r) => (r.ok ? clean(r.out || r.err) || "logged in" : false),
  },
  {
    target: "agy",
    bin: "agy",
    args: ["--version"],
    fix: "connexion Antigravity (compte Google, navigateur)",
    ok: (r) =>
      r.ok || r.out ? `present (Google auth managed by Antigravity)` : false,
  },
];

function checkSimple(o: AuthOptions): Check[] {
  const pick = o.args?.length
    ? SIMPLE.filter((s) => o.args!.includes(s.target))
    : SIMPLE;
  return pick.map((s): Check => {
    if (!has(s.bin))
      return {
        kind: "cli",
        target: s.target,
        host: LOCAL,
        status: "skip",
        proof: `${s.bin} missing`,
      };
    const r = sh(s.bin, s.args, { timeout: 60_000 });
    const okText = s.ok(r);
    if (okText)
      return {
        kind: "cli",
        target: s.target,
        host: LOCAL,
        status: "ok",
        proof: `${s.bin} ${s.args.join(" ")} -> ${clean(okText)}`,
      };
    if (o.browser && s.login && !o.dryRun) {
      const login = s.login(HEADLESS);
      const l = spawnSync(s.bin, login, {
        stdio: "inherit",
        timeout: 600_000,
        shell: process.platform === "win32" && CMD_SHIMS.has(s.bin),
      });
      const again = s.ok(sh(s.bin, s.args, { timeout: 60_000 }));
      const t = again && s.after?.();
      if (t && o.persist) o.persist(t[0], t[1]);
      return {
        kind: "cli",
        target: s.target,
        host: LOCAL,
        status: again ? "fixed" : "action",
        proof: `${s.bin} ${login.join(" ")} -> ${l.status === 0 ? "ok" : `code ${l.status}`}`,
      };
    }
    return {
      kind: "cli",
      target: s.target,
      host: LOCAL,
      status: "invalid",
      proof: `${s.bin} ${s.args.join(" ")} -> ${clean(r.err || r.out) || `code ${r.code}`}`,
      fix: s.fix,
    };
  });
}

// --- Browser ------------------------------------------------------------------------------------

function checkBrowser(): Check[] {
  if (process.platform !== "win32") return [];
  const out: Check[] = [];
  const state = join(
    process.env.LOCALAPPDATA ?? "",
    "Google",
    "Chrome",
    "User Data",
    "Local State",
  );
  try {
    const cache =
      JSON.parse(readFileSync(state, "utf8"))?.profile?.info_cache ?? {};
    for (const [dir, p] of Object.entries(cache) as [
      string,
      { user_name?: string; name?: string },
    ][]) {
      out.push({
        kind: "browser",
        target: `chrome:${dir}`,
        host: LOCAL,
        status: p.user_name ? "ok" : "action",
        proof: `Local State info_cache -> ${p.user_name || "not signed in"} (${p.name ?? ""})`,
        fix: p.user_name
          ? undefined
          : "sign in to the Chrome profile (owner click)",
      });
    }
  } catch {
    out.push({
      kind: "browser",
      target: "chrome",
      host: LOCAL,
      status: "missing",
      proof: "Local State illisible",
    });
  }
  for (const [target, key] of [
    ["claude-in-chrome", "com.anthropic.claude_code_browser_extension"],
  ] as const) {
    const r = sh("reg", [
      "query",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${key}`,
      "/ve",
    ]);
    const manifest = r.out.match(/REG_SZ\s+(.+)$/m)?.[1]?.trim();
    const ok = !!manifest && existsSync(manifest);
    out.push({
      kind: "browser",
      target,
      host: LOCAL,
      status: ok ? "ok" : "invalid",
      proof: `reg NativeMessagingHosts\\${key} -> ${ok ? "manifest present" : "missing"}`,
      fix: ok
        ? undefined
        : target === "claude-in-chrome"
          ? "claude --chrome (reinstalls the native host)"
          : undefined,
    });
  }
  if (has("agent-browser")) {
    const r = sh("agent-browser", ["--version"]);
    out.push({
      kind: "browser",
      target: "agent-browser",
      host: LOCAL,
      status: r.ok ? "ok" : "invalid",
      proof: `agent-browser --version -> ${clean(r.out || r.err)}`,
    });
  }
  return out;
}

// --- Tokens (env-kit whoami) and store -----------------------------------------------------------

async function checkTokens(): Promise<Check[]> {
  // Same precedence as every consumer: the OS store first, then the environment (.env).
  const env: Record<string, string | undefined> = { ...process.env };
  try {
    for (const n of secretList()) env[n] = secretGet(n) ?? env[n];
  } catch {
    // No store on this host: environment only.
  }
  const ids = await whoami(env);
  return ids.map(
    (i) =>
      ({
        kind: "token",
        target: i.provider,
        host: LOCAL,
        status:
          i.status === "ok"
            ? "ok"
            : i.status === "unset"
              ? "missing"
              : "invalid",
        proof: `whoami ${i.provider} -> ${i.status}${i.identity ? ` ${i.identity}` : ""}`,
        fix:
          i.status === "ok"
            ? undefined
            : `renew the ${i.provider} token then ay secret set <NAME>`,
      }) satisfies Check,
  );
}

function checkStore(): Check[] {
  try {
    const info = storeInfo();
    const names = secretList();
    return [
      {
        kind: "store",
        target: info.backend,
        host: LOCAL,
        status: "ok",
        proof: `${info.dir}: ${names.length} secrets`,
      },
    ];
  } catch (e) {
    return [
      {
        kind: "store",
        target: "secret-store",
        host: LOCAL,
        status: "invalid",
        proof: clean(String(e)),
      },
    ];
  }
}

// --- GitHub Actions secrets ------------------------------------------------------------------------

const SYNC_STATE = () => join(storeInfo().dir, ".gh-sync.json");

function syncKey(): Buffer {
  let k = secretGet("ENV_KIT_SYNC_KEY");
  if (!k) {
    k = randomBytes(32).toString("base64");
    secretSet("ENV_KIT_SYNC_KEY", k);
  }
  return Buffer.from(k, "base64");
}

function readState(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SYNC_STATE(), "utf8"));
  } catch {
    return {};
  }
}

/** `apply`: push every drifted secret (`gh secret set --body -` reads the value on stdin). */
/** Secrets whose provider can be asked whether the value is still accepted (env-kit whoami). */
const PROVIDER_OF: Record<string, string> = {
  CLOUDFLARE_API_TOKEN: "cloudflare",
  VERCEL_TOKEN: "vercel",
  HOSTINGER_API_TOKEN: "hostinger",
  NPM_TOKEN: "npm",
  CARGO_REGISTRY_TOKEN: "crates.io",
  NEON_API_KEY: "neon",
  SUPABASE_ACCESS_TOKEN: "supabase",
};

/** Providers rejecting the value that would be pushed: such a secret is never sent to GitHub. */
async function rejectedSecrets(): Promise<Set<string>> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(PROVIDER_OF)) env[k] = resolveSecret(k);
  const ids = await whoami(env);
  const bad = new Set(
    ids.filter((i) => i.status === "invalid").map((i) => i.provider),
  );
  return new Set(
    Object.entries(PROVIDER_OF)
      .filter(([, p]) => bad.has(p))
      .map(([k]) => k),
  );
}

export function syncGithubSecrets(
  m: Manifest,
  o: AuthOptions,
  apply: boolean,
  rejected = new Set<string>(),
): Check[] {
  const out: Check[] = [];
  const state = readState();
  const key = syncKey();
  const targets: [scope: "--repo" | "--org", owner: string, names: string[]][] =
    [
      ...Object.entries(m.auth.github?.repo_secrets ?? {}).map(
        ([r, n]) => ["--repo", r, n] as ["--repo", string, string[]],
      ),
      ...Object.entries(m.auth.github?.org_secrets ?? {}).map(
        ([r, n]) => ["--org", r, n] as ["--org", string, string[]],
      ),
    ];
  for (const [scope, owner, names] of targets) {
    const list = sh("gh", [
      "secret",
      "list",
      scope,
      owner,
      "--json",
      "name,updatedAt",
    ]);
    const remote = new Map<string, string>(
      list.ok
        ? (JSON.parse(list.out) as { name: string; updatedAt: string }[]).map(
            (s) => [s.name, s.updatedAt],
          )
        : [],
    );
    for (const name of names) {
      const target = `${owner}:${name}`;
      const value = resolveSecret(name);
      if (!value) {
        out.push({
          kind: "ci",
          target,
          host: "github",
          status: remote.has(name) ? "action" : "missing",
          proof: `${remote.has(name) ? `present on GitHub (${remote.get(name)})` : "missing on GitHub"}, missing from storage`,
          fix: `ay secret set ${name} (value from the provider), then ay auth gh-secrets`,
        });
        continue;
      }
      if (rejected.has(name)) {
        out.push({
          kind: "ci",
          target,
          host: "github",
          status: "invalid",
          proof: `whoami ${PROVIDER_OF[name]} -> invalid: value not pushed`,
          fix: `renew ${name} at the provider, ay secret set ${name}`,
        });
        continue;
      }
      const fp = createHmac("sha256", key)
        .update(`${scope}:${target}\0${value}`)
        .digest("hex");
      if (remote.has(name) && state[`${scope}:${target}`] === fp) {
        out.push({
          kind: "ci",
          target,
          host: "github",
          status: "ok",
          proof: `gh secret list ${scope} ${owner} -> ${name} ${remote.get(name)}, empreinte locale identique`,
        });
        continue;
      }
      if (!apply || o.dryRun) {
        out.push({
          kind: "ci",
          target,
          host: "github",
          status: "action",
          proof: `${remote.has(name) ? "value not synced by ay" : "missing on GitHub"}`,
          fix: "ay auth gh-secrets",
        });
        continue;
      }
      const r = sh(
        "gh",
        [
          "secret",
          "set",
          name,
          scope,
          owner,
          ...(scope === "--org"
            ? name === "APHRODY_APP_KEY"
              ? ["--visibility", "selected", "--repos", "src"]
              : ["--visibility", "all"]
            : []),
          "--body",
          "-",
        ],
        { input: value },
      );
      if (r.ok) state[`${scope}:${target}`] = fp;
      out.push({
        kind: "ci",
        target,
        host: "github",
        status: r.ok ? "fixed" : "invalid",
        proof: `gh secret set ${name} ${scope} ${owner} -> ${r.ok ? "ok" : clean(r.err)}`,
      });
    }
  }
  if (apply && !o.dryRun)
    writeFileSync(SYNC_STATE(), JSON.stringify(state, null, 1));
  return out;
}

// --- Fleet: ssh, WireGuard, cloudflared, renewal units (one ssh session per host) ------------------

/** Bash run on each host (stdin of `ssh <alias> bash -s`); prints `kind\ttarget\tstatus\tproof`. */
export function hostScript(
  h: HostAuth,
  pubkeys: string[],
  repair: boolean,
  revoked: string[] = [],
): string {
  const q = (xs: string[]) =>
    xs.map((x) => `'${x.replace(/'/g, "")}'`).join(" ");
  return `set -u
S=; [ "$(id -u)" = 0 ] || S="sudo -n"
p() { printf '%s\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3" "$4"; }
REPAIR=${repair ? 1 : 0}
mkdir -p ~/.ssh && chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys
for k in ${q(pubkeys)}; do
  fp=$(printf '%s\\n' "$k" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')
  blob=\${k#* }; blob=\${blob%% *}
  if grep -qF "$blob" ~/.ssh/authorized_keys; then p ssh-key "$fp" ok "authorized_keys contient la clé"
  elif [ $REPAIR = 1 ]; then printf '%s\\n' "$k" >> ~/.ssh/authorized_keys; p ssh-key "$fp" fixed "ajoutée à authorized_keys"
  else p ssh-key "$fp" action "absente de authorized_keys"; fi
done
for u in ${q(Object.keys(h.tunnels ?? {}))}; do
  a=$(systemctl is-active "$u.service" 2>/dev/null)
  if [ "$a" != active ] && [ $REPAIR = 1 ]; then $S systemctl restart "$u.service" 2>/dev/null; sleep 3; a=$(systemctl is-active "$u.service"); st=$([ "$a" = active ] && echo fixed || echo invalid)
  else st=$([ "$a" = active ] && echo ok || echo invalid); fi
  n=$($S journalctl -u "$u" -n 200 -o cat --no-pager 2>/dev/null | grep -c 'Registered tunnel connection')
  cred=$(systemctl cat "$u.service" 2>/dev/null | grep -E "^LoadCredentialEncrypted=" || true)
  p tunnel "$u" "$st" "systemctl is-active=$a, connexions enregistrées (200 dernières lignes)=$n, jeton=$([ -n "$cred" ] && echo systemd-creds || echo fichier)"
done
now=$(date +%s)
for i in ${q(h.wireguard ?? [])}; do
  hs=$($S wg show "$i" latest-handshakes 2>/dev/null) || { p wireguard "$i" invalid "wg show $i: interface absente ou sudo refusé"; continue; }
  tot=0; fresh=0; stale=
  while read -r k t; do [ -z "$k" ] && continue; tot=$((tot+1)); if [ "$t" != 0 ] && [ $((now-t)) -lt 180 ]; then fresh=$((fresh+1)); else stale="$stale \${k:0:8}"; fi; done <<< "$hs"
  st=ok; [ $fresh = 0 ] && st=invalid; [ $fresh != 0 ] && [ $fresh != $tot ] && st=action
  p wireguard "$i" $st "wg show $i latest-handshakes: $fresh/$tot pairs < 180 s\${stale:+ ; sans handshake:$stale}"
  for r in ${q(revoked)}; do
    grep -qF "$r" <<< "$hs" && p wireguard-key "$i:\${r:0:8}" invalid "pair encore actif avec une clé révoquée (device/deploy.toml [auth.wireguard].revoked)"
  done
done
for u in ${q(h.units ?? [])}; do
  f=$(systemctl is-failed "$u.service" 2>/dev/null); r=$(systemctl show -p Result --value "$u.service" 2>/dev/null)
  p unit "$u" $([ "$f" = failed ] && echo invalid || echo ok) "systemctl is-failed=$f Result=$r"
done
`;
}

function pubkeysFor(alias: string): string[] {
  const g = sh("ssh", ["-G", alias]);
  if (!g.ok) return [];
  const files = g.out
    .split("\n")
    .filter((l) => l.startsWith("identityfile "))
    .map((l) => l.slice(13).trim().replace(/^~/, homedir()));
  return files
    .map((f) => `${f}.pub`)
    .filter(existsSync)
    .map((f) =>
      readFileSync(f, "utf8").trim().split(/\s+/).slice(0, 2).join(" "),
    );
}

export function checkFleet(
  m: Manifest,
  o: AuthOptions,
  repair: boolean,
): Check[] {
  const out: Check[] = [];
  for (const [node, n] of Object.entries(m.nodes ?? {})) {
    const h = m.auth.hosts?.[node] ?? {};
    const canRepair = repair && h.repair !== false && !o.dryRun;
    const t0 = Date.now();
    const r = sh(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        n.ssh_alias,
        "bash",
        "-s",
      ],
      {
        input: hostScript(
          h,
          pubkeysFor(n.ssh_alias),
          canRepair,
          m.auth.wireguard?.revoked ?? [],
        ),
        timeout: 90_000,
      },
    );
    if (!r.ok && !r.out) {
      out.push({
        kind: "ssh",
        target: n.ssh_alias,
        host: node,
        status: "invalid",
        proof: `ssh -o BatchMode=yes ${n.ssh_alias} -> ${clean(r.err) || `code ${r.code}`}`,
        fix: "check the key (ssh -G) and network access (WireGuard/public IP)",
      });
      continue;
    }
    out.push({
      kind: "ssh",
      target: n.ssh_alias,
      host: node,
      status: "ok",
      proof: `ssh -o BatchMode=yes ${n.ssh_alias} bash -s -> ok (${Date.now() - t0} ms)`,
    });
    for (const line of r.out.split("\n")) {
      const [kind, target, status, proof] = line.split("\t");
      if (kind && target && status && proof)
        out.push({ kind, target, host: node, status: status as Status, proof });
    }
  }
  // GitHub over ssh (git remotes).
  const gh = sh("ssh", [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "git@github.com",
  ]);
  const who = (gh.err + gh.out).match(/Hi ([^!]+)!/)?.[1];
  out.push({
    kind: "ssh",
    target: "git@github.com",
    host: LOCAL,
    status: who ? "ok" : "invalid",
    proof: `ssh -T git@github.com -> ${who ? `Hi ${who}` : clean(gh.err)}`,
  });
  if (process.platform === "win32") {
    const sc = sh("sc", ["query", "state=", "all"]);
    const names = [
      ...sc.out.matchAll(/SERVICE_NAME:\s+(WireGuardTunnel\$\S+)/g),
    ].map((x) => x[1]!);
    for (const s of names) {
      const q = sh("sc", ["query", s]);
      const running = /RUNNING/.test(q.out);
      out.push({
        kind: "wireguard",
        target: s.replace("WireGuardTunnel$", ""),
        host: LOCAL,
        status: running ? "ok" : "action",
        proof: `sc query ${s} -> ${running ? "RUNNING" : "STOPPED"}`,
        fix: running ? undefined : "start the tunnel in WireGuard (UAC)",
      });
    }
  }
  return out;
}

async function cfApi(path: string, init: RequestInit = {}): Promise<any> {
  const t = resolveSecret("CLOUDFLARE_API_TOKEN");
  if (!t) throw new Error("CLOUDFLARE_API_TOKEN missing");
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json()) as {
    success: boolean;
    result: any;
    errors?: { code: number }[];
  };
  if (!j.success)
    throw new Error(
      `Cloudflare HTTP ${r.status} ${j.errors?.map((e) => e.code).join(",")}`,
    );
  return j.result;
}

export async function checkTunnelsApi(m: Manifest): Promise<Check[]> {
  const acct =
    m.cloud?.cloudflare_account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const wanted = new Set(
    Object.values(m.auth.hosts ?? {}).flatMap((h) =>
      Object.values(h.tunnels ?? {}),
    ),
  );
  if (!resolveSecret("CLOUDFLARE_API_TOKEN"))
    return [
      {
        kind: "tunnel-api",
        target: "cfd_tunnel",
        host: "cloudflare",
        status: "skip",
        proof:
          "CLOUDFLARE_API_TOKEN missing on this host (check done from the PC)",
      },
    ];
  try {
    const list = (await cfApi(
      `/accounts/${acct}/cfd_tunnel?is_deleted=false&per_page=100`,
    )) as { name: string; status: string; connections?: unknown[] }[];
    return list.map(
      (t) =>
        ({
          kind: "tunnel-api",
          target: t.name,
          host: "cloudflare",
          status:
            t.status === "healthy"
              ? "ok"
              : wanted.has(t.name)
                ? "invalid"
                : "action",
          proof: `GET cfd_tunnel -> ${t.status}, ${t.connections?.length ?? 0} connexions${wanted.has(t.name) ? "" : " (hors manifeste)"}`,
        }) satisfies Check,
    );
  } catch (e) {
    return [
      {
        kind: "tunnel-api",
        target: "cfd_tunnel",
        host: "cloudflare",
        status: "invalid",
        proof: clean(String(e)),
      },
    ];
  }
}

/**
 * Re-key every manifest tunnel from the Cloudflare API: the connector token goes through ssh stdin
 * into `systemd-creds encrypt` (/etc/credstore.encrypted/cloudflared-<tunnel>), a drop-in points the
 * unit at `$CREDENTIALS_DIRECTORY`, the plaintext token file is removed. Idempotent: the host only
 * rewrites and restarts when the decrypted credential differs.
 */
export async function deployTunnels(
  m: Manifest,
  o: AuthOptions,
): Promise<Check[]> {
  const acct =
    m.cloud?.cloudflare_account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const out: Check[] = [];
  let list: { id: string; name: string }[];
  try {
    list = await cfApi(
      `/accounts/${acct}/cfd_tunnel?is_deleted=false&per_page=100`,
    );
  } catch (e) {
    return [
      {
        kind: "tunnel",
        target: "cfd_tunnel",
        host: "cloudflare",
        status: "invalid",
        proof: clean(String(e)),
      },
    ];
  }
  for (const [node, h] of Object.entries(m.auth.hosts ?? {})) {
    const alias = m.nodes[node]?.ssh_alias;
    if (!alias || h.repair === false) continue;
    for (const [unit, name] of Object.entries(h.tunnels ?? {})) {
      const t = list.find((x) => x.name === name);
      if (!t) {
        out.push({
          kind: "tunnel",
          target: unit,
          host: node,
          status: "missing",
          proof: `tunnel ${name} missing from the account`,
        });
        continue;
      }
      const token = (await cfApi(
        `/accounts/${acct}/cfd_tunnel/${t.id}/token`,
      )) as string;
      const cred = `cloudflared-${name}`;
      const script = `set -eu
S=; [ "$(id -u)" = 0 ] || S="sudo -n"
IFS= read -r TOK
DRY=${o.dryRun ? 1 : 0}
f=/etc/credstore.encrypted/${cred}
frag=$(systemctl show -p FragmentPath --value ${unit}.service)
orig=$(grep -E '^ExecStart=' "$frag" | tail -1 | cut -d= -f2-)
oldf=$(printf '%s' "$orig" | sed -nE 's#.*--token-file ([^ ]+).*#\\1#p')
new=$(printf '%s' "$orig" | sed -E 's#--token-file [^ ]+#--token-file %d/${cred}#')
d=/etc/systemd/system/${unit}.service.d
want="# ay auth tunnels: connector token from the Cloudflare API, encrypted with systemd-creds (credential ID = embedded name).
[Service]
LoadCredentialEncrypted=${cred}:$f
ExecStart=
ExecStart=$new"
cur=$($S systemd-creds decrypt --name=${cred} "$f" - 2>/dev/null || true)
changed=0
if [ "$cur" != "$TOK" ]; then
  [ $DRY = 1 ] && { echo drift-token; exit 0; }
  $S mkdir -p /etc/credstore.encrypted
  printf "%s" "$TOK" | $S systemd-creds encrypt --name=${cred} - "$f" 2>/dev/null; changed=1
fi
if [ "$($S cat $d/20-token-credential.conf 2>/dev/null)" != "$want" ]; then
  [ $DRY = 1 ] && { echo drift-unit; exit 0; }
  $S mkdir -p $d; printf '%s\\n' "$want" | $S tee $d/20-token-credential.conf >/dev/null; $S systemctl daemon-reload; changed=1
fi
[ $changed = 1 ] && { $S systemctl restart ${unit}.service; sleep 8; }
a=$(systemctl is-active ${unit}.service || true)
n=$($S journalctl -u ${unit} --since "-2min" -o cat --no-pager | grep -c 'Registered tunnel connection' || true)
# The plaintext token file is no longer read once the unit runs from the credential.
[ "$a" = active ] && [ -n "$oldf" ] && [ -e "$oldf" ] && [ $DRY = 0 ] && $S rm -f "$oldf"
echo "$a changed=$changed connexions=$n"`;
      const b64 = Buffer.from(script).toString("base64");
      const r = sh(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          alias,
          `bash -c "$(echo ${b64} | base64 -d)"`,
        ],
        { input: `${token}\n`, timeout: 120_000 },
      );
      const res = r.out.split("\n").pop() ?? "";
      out.push({
        kind: "tunnel",
        target: unit,
        host: node,
        status: res.startsWith("drift")
          ? "action"
          : res.startsWith("active changed=1")
            ? "fixed"
            : res.startsWith("active")
              ? "ok"
              : "invalid",
        proof: `jeton API ${name} -> systemd-creds ${cred}: ${res || clean(r.err)}`,
      });
    }
  }
  return out;
}

/**
 * Roll CLOUDFLARE_API_TOKEN in place (PUT /accounts/<id>/tokens/<id>/value: same id, same
 * policies, new value; the old value stops working). Needs "Account API Tokens Write" on the token
 * itself. The new value goes straight to persist() (store, .env, user env), then to GitHub.
 */
export async function rotateCloudflare(
  m: Manifest,
  o: AuthOptions,
): Promise<Check[]> {
  const acct =
    m.cloud?.cloudflare_account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!o.persist) throw new Error("rotate needs a persist callback");
  try {
    const v = (await cfApi(`/accounts/${acct}/tokens/verify`)) as {
      id: string;
    };
    if (o.dryRun)
      return [
        {
          kind: "token",
          target: "cloudflare",
          host: "cloudflare",
          status: "action",
          proof: `token ${v.id}: roll planned (dry-run)`,
        },
      ];
    const value = (await cfApi(`/accounts/${acct}/tokens/${v.id}/value`, {
      method: "PUT",
      body: "{}",
    })) as string;
    o.persist("CLOUDFLARE_API_TOKEN", value);
    const again = (await cfApi(`/accounts/${acct}/tokens/verify`)) as {
      id: string;
      status: string;
    };
    return [
      {
        kind: "token",
        target: "cloudflare",
        host: "cloudflare",
        status:
          again.id === v.id && again.status === "active" ? "fixed" : "invalid",
        proof: `PUT tokens/${v.id}/value -> new token active, old one revoked`,
      },
      ...syncGithubSecrets(m, o, true),
    ];
  } catch (e) {
    return [
      {
        kind: "token",
        target: "cloudflare",
        host: "cloudflare",
        status: "invalid",
        proof: clean(String(e)),
      },
    ];
  }
}

// --- Keyless CI: GitHub Actions OIDC -> GCP Workload Identity Federation ------------------------------

const gc = (g: OidcGcp, args: string[], timeout = 90_000) =>
  sh(
    "gcloud",
    [...args, `--project=${g.project}`, `--account=${g.account}`, "--quiet"],
    { timeout },
  );

const principalSet = (g: OidcGcp, repo: string) =>
  `principalSet://iam.googleapis.com/projects/${g.project_number}/locations/global/workloadIdentityPools/${g.pool}/attribute.repository/${repo}`;

/**
 * `status`: reads the pool, the provider and the service-account bindings. `apply` (`ay auth oidc`):
 * creates what is missing, idempotently. Also flags every long-lived CI secret that an OIDC
 * mechanism of `[auth.oidc.replaces]` makes unnecessary.
 */
export function checkOidc(
  m: Manifest,
  o: AuthOptions,
  apply: boolean,
): Check[] {
  const out: Check[] = [];
  const g = m.auth.oidc?.gcp;
  if (g && has("gcloud")) {
    const loc = ["--location=global"];
    let pool = gc(g, [
      "iam",
      "workload-identity-pools",
      "describe",
      g.pool,
      ...loc,
      "--format=value(state)",
    ]);
    if (!pool.ok && apply && !o.dryRun)
      pool = gc(g, [
        "iam",
        "workload-identity-pools",
        "create",
        g.pool,
        ...loc,
        "--display-name=GitHub-Actions",
        "--format=value(state)",
      ]);
    out.push({
      kind: "oidc",
      target: `gcp:${g.pool}`,
      host: "gcp",
      status: pool.ok ? "ok" : apply ? "invalid" : "action",
      proof: `workload-identity-pools describe ${g.pool} -> ${pool.ok ? pool.out || "ACTIVE" : clean(pool.err)}`,
      fix: pool.ok ? undefined : "ay auth oidc",
    });
    const pv = ["iam", "workload-identity-pools", "providers"];
    const mapping =
      "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.job_workflow_ref";
    let prov = gc(g, [
      ...pv,
      "describe",
      g.provider,
      `--workload-identity-pool=${g.pool}`,
      ...loc,
      "--format=value(attributeCondition)",
    ]);
    if (prov.ok && prov.out !== g.condition && apply && !o.dryRun)
      prov = gc(g, [
        ...pv,
        "update-oidc",
        g.provider,
        `--workload-identity-pool=${g.pool}`,
        ...loc,
        `--attribute-condition=${g.condition}`,
        `--attribute-mapping=${mapping}`,
        "--format=value(attributeCondition)",
      ]);
    else if (!prov.ok && apply && !o.dryRun)
      prov = gc(g, [
        ...pv,
        "create-oidc",
        g.provider,
        `--workload-identity-pool=${g.pool}`,
        ...loc,
        `--issuer-uri=${g.issuer}`,
        `--attribute-mapping=${mapping}`,
        `--attribute-condition=${g.condition}`,
        "--format=value(attributeCondition)",
      ]);
    const condOk = prov.ok && (prov.out === g.condition || prov.out === "");
    out.push({
      kind: "oidc",
      target: `gcp:${g.pool}/${g.provider}`,
      host: "gcp",
      status: condOk ? "ok" : "action",
      proof: `providers describe ${g.provider} -> ${prov.ok ? `condition ${prov.out || "(created)"}` : clean(prov.err)}`,
      fix: condOk ? undefined : "ay auth oidc",
    });
    const pol = gc(g, [
      "iam",
      "service-accounts",
      "get-iam-policy",
      g.service_account,
      "--format=json",
    ]);
    const members = new Set<string>(
      pol.ok
        ? (
            (JSON.parse(pol.out).bindings ?? []) as {
              role: string;
              members: string[];
            }[]
          )
            .filter((b) => b.role === "roles/iam.workloadIdentityUser")
            .flatMap((b) => b.members)
        : [],
    );
    for (const repo of g.repos) {
      const who = principalSet(g, repo);
      let ok = members.has(who);
      if (!ok && apply && !o.dryRun && pool.ok)
        ok = gc(g, [
          "iam",
          "service-accounts",
          "add-iam-policy-binding",
          g.service_account,
          "--role=roles/iam.workloadIdentityUser",
          `--member=${who}`,
          "--format=none",
        ]).ok;
      out.push({
        kind: "oidc",
        target: `gcp:${repo}`,
        host: "gcp",
        status: ok ? (members.has(who) ? "ok" : "fixed") : "action",
        proof: `${g.service_account} roles/iam.workloadIdentityUser -> ${ok ? "repository principalSet bound" : "missing"}`,
        fix: ok ? undefined : "ay auth oidc",
      });
    }
  }
  const remote = new Set<string>();
  for (const [scope, owners] of [
    ["--repo", Object.keys(m.auth.github?.repo_secrets ?? {})],
    ["--org", Object.keys(m.auth.github?.org_secrets ?? {})],
  ] as const)
    for (const owner of owners) {
      const l = sh("gh", [
        "secret",
        "list",
        scope,
        owner,
        "--json",
        "name",
        "-q",
        ".[].name",
      ]);
      for (const n of l.out.split("\n").filter(Boolean)) remote.add(n);
    }
  for (const [name, by] of Object.entries(m.auth.oidc?.replaces ?? {}))
    if (remote.has(name))
      out.push({
        kind: "oidc",
        target: name,
        host: "github",
        status: "action",
        proof: "long-lived secret still present on GitHub",
        fix: by,
      });
  return out;
}

// --- Short-lived, least-privilege credentials for one command (agents) -------------------------------

/**
 * `ay auth mint cloudflare --perm "Workers Scripts Write,DNS Write" [--ttl 900] -- cmd ...`: an account
 * token with only those permission groups, `expires_on` = now + ttl, injected as CLOUDFLARE_API_TOKEN
 * into the child, deleted when it exits (expired leftovers named ay-mint-* are purged first).
 * `ay auth mint gcp [--sa <email>] [--account <caller>] [--ttl 3600] -- cmd ...`: keyless service-account access token
 * (`gcloud auth print-access-token --impersonate-service-account`), as CLOUDSDK_AUTH_ACCESS_TOKEN and
 * GOOGLE_OAUTH_ACCESS_TOKEN. No value is printed.
 */
export async function mint(m: Manifest, o: AuthOptions): Promise<number> {
  const a = o.args ?? [];
  const sep = a.indexOf("--");
  const head = sep >= 0 ? a.slice(0, sep) : a;
  const cmd = sep >= 0 ? a.slice(sep + 1) : [];
  const opt = (k: string) =>
    head.includes(k) ? head[head.indexOf(k) + 1] : undefined;
  const provider = head[0];
  const ttl = Math.max(
    60,
    Number(opt("--ttl") ?? (provider === "gcp" ? 3600 : 900)),
  );
  if (!cmd.length) {
    console.error(
      'usage : ay auth mint cloudflare --perm "<groupe>,..." [--ttl s] -- <cmd> | ay auth mint gcp --sa <email> [--ttl s] -- <cmd>',
    );
    return 2;
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  let cleanup = async () => {};
  if (provider === "cloudflare") {
    const acct =
      m.cloud?.cloudflare_account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    const want = (opt("--perm") ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!want.length)
      throw new Error(
        "--perm requis (noms de groupes de permissions Cloudflare)",
      );
    const groups = (await cfApi(
      `/accounts/${acct}/tokens/permission_groups`,
    )) as { id: string; name: string; scopes: string[] }[];
    const sel = want.map(
      (w) =>
        groups.find((g) => g.name.toLowerCase() === w.toLowerCase()) ??
        (() => {
          throw new Error(`unknown permission group: ${w}`);
        })(),
    );
    const zone = sel.filter((g) => g.scopes.some((x) => x.includes(".zone")));
    const account = sel.filter((g) => !zone.includes(g));
    const res = `com.cloudflare.api.account.${acct}`;
    const policies = [
      ...(account.length
        ? [
            {
              effect: "allow",
              resources: { [res]: "*" },
              permission_groups: account.map(({ id }) => ({ id })),
            },
          ]
        : []),
      ...(zone.length
        ? [
            {
              effect: "allow",
              resources: {
                [res]: { "com.cloudflare.api.account.zone.*": "*" },
              },
              permission_groups: zone.map(({ id }) => ({ id })),
            },
          ]
        : []),
    ];
    const tokens = (await cfApi(`/accounts/${acct}/tokens?per_page=100`)) as {
      id: string;
      name: string;
      expires_on?: string;
    }[];
    for (const t of tokens)
      if (
        t.name.startsWith("ay-mint-") &&
        t.expires_on &&
        Date.parse(t.expires_on) < Date.now()
      )
        await cfApi(`/accounts/${acct}/tokens/${t.id}`, {
          method: "DELETE",
        }).catch(() => {});
    const exp = new Date(Date.now() + ttl * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
    const t = (await cfApi(`/accounts/${acct}/tokens`, {
      method: "POST",
      body: JSON.stringify({
        name: `ay-mint-${Date.now()}`,
        policies,
        expires_on: exp,
      }),
    })) as { id: string; value: string };
    env.CLOUDFLARE_API_TOKEN = t.value;
    env.CLOUDFLARE_ACCOUNT_ID = acct;
    console.error(
      `ay auth mint : jeton Cloudflare ${t.id} (${sel.map((g) => g.name).join(", ")}), expire ${exp}`,
    );
    cleanup = async () => {
      await cfApi(`/accounts/${acct}/tokens/${t.id}`, {
        method: "DELETE",
      }).catch(() => {});
    };
  } else if (provider === "gcp") {
    const sa = opt("--sa") ?? m.auth.oidc?.gcp?.service_account;
    if (!sa) throw new Error("--sa requis");
    // The caller account needs roles/iam.serviceAccountTokenCreator on the service account.
    const caller =
      opt("--account") ??
      m.auth.oidc?.gcp?.account ??
      (Bun.env.APHRODY_OWNER_GOOGLE_ACCOUNT || undefined);
    const r = sh(
      "gcloud",
      [
        "auth",
        "print-access-token",
        `--impersonate-service-account=${sa}`,
        ...(caller ? [`--account=${caller}`] : []),
        `--lifetime=${Math.min(ttl, 43200)}`,
        "--quiet",
      ],
      { timeout: 60_000 },
    );
    if (!r.ok || !r.out) {
      console.error(
        `ay auth mint gcp : ${clean(
          r.err
            .split("\n")
            .filter((l) => !l.startsWith("WARNING"))
            .join("\n"),
        )} (roles/iam.serviceAccountTokenCreator requis sur ${sa})`,
      );
      return 1;
    }
    env.CLOUDSDK_AUTH_ACCESS_TOKEN = r.out.split("\n").pop()!;
    env.GOOGLE_OAUTH_ACCESS_TOKEN = env.CLOUDSDK_AUTH_ACCESS_TOKEN;
    console.error(
      `ay auth mint: access token ${sa} (impersonation, ${Math.min(ttl, 43200)} s, keyless)`,
    );
  } else {
    console.error(
      `ay auth mint: unknown provider ${provider}. Expected: cloudflare, gcp`,
    );
    return 2;
  }
  try {
    const r = spawnSync(cmd[0]!, cmd.slice(1), {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    return r.status ?? 1;
  } finally {
    await cleanup();
  }
}

// --- GitHub App "aphrody" (github-app.ts, docs/infra/GITHUB-APP.md) ----------------------------------------

/** `ay auth github-app [create|install|status|hook|token|user|user-token|retire]` : voir github-app.ts. */
export async function githubApp(o: AuthOptions): Promise<number> {
  const { githubAppCommand } = await import("./github-app");
  return githubAppCommand(o.args ?? []);
}

// --- Entry ------------------------------------------------------------------------------------------

const KINDS = [
  "cli",
  "browser",
  "token",
  "store",
  "ci",
  "oidc",
  "fleet",
  "tunnel-api",
] as const;

/** Real probes (status) or passwordless repairs (repair); never a cache. */
export async function collectChecks(
  m: Manifest,
  o: AuthOptions,
  repair: boolean,
): Promise<Check[]> {
  const want = (k: string) => !o.only?.length || o.only.includes(k);
  const checks: Check[] = [];
  if (want("store")) checks.push(...checkStore());
  if (want("cli"))
    checks.push(
      ...(repair ? checkGh(o) : checkGh({ ...o, persist: undefined })),
      ...checkGcloud(repair ? o : { ...o, browser: false }),
      ...checkSimple(repair ? o : { ...o, browser: false }),
    );
  if (want("browser"))
    checks.push(
      ...checkBrowser(),
      ...(await Promise.all(
        (await import("./auth-services.ts")).SERVICES.map((s) =>
          s.probe(!!o.deep),
        ),
      )),
    );
  if (want("token")) checks.push(...(await checkTokens()));
  if (want("ci"))
    checks.push(...syncGithubSecrets(m, o, repair, await rejectedSecrets()));
  if (want("oidc")) checks.push(...checkOidc(m, o, false));
  if (want("fleet")) checks.push(...checkFleet(m, o, repair));
  if (want("tunnel-api")) checks.push(...(await checkTunnelsApi(m)));
  return checks;
}

export async function runAuth(sub: string, o: AuthOptions): Promise<number> {
  const m = loadManifest(o.root);
  const want = (k: string) => !o.only?.length || o.only.includes(k);
  const repair = sub === "repair";
  let checks: Check[] = [];
  if (sub === "mint") return mint(m, o);
  if (sub === "github-app") return githubApp(o);
  if (sub === "login") {
    // Device flow first (RFC 8628) where the CLI has it; only the CLIs whose check fails are logged in.
    const t = o.args ?? [];
    const lo = { ...o, browser: true };
    if (!t.length || t.includes("gh")) checks.push(...checkGh(lo));
    if (!t.length || t.includes("gcloud")) checks.push(...checkGcloud(lo));
    checks.push(...checkSimple(lo));
  } else if (sub === "status" || sub === "repair") {
    checks = await collectChecks(m, o, repair);
  } else if (sub === "daemon") {
    return (await import("./auth-daemon")).daemon(m, o);
  } else if (sub === "gh-secrets") {
    checks = syncGithubSecrets(m, o, true, await rejectedSecrets());
  } else if (sub === "rotate") {
    checks = await rotateCloudflare(m, o);
  } else if (sub === "oidc") {
    checks = checkOidc(m, o, true);
  } else if (sub === "tunnels") {
    checks = await deployTunnels(m, o);
  } else {
    console.error(
      `ay auth: unknown subcommand ${sub}. Expected: status, login [service], repair, daemon, oidc, mint, github-app, gh-secrets, tunnels, rotate`,
    );
    return 2;
  }
  if (o.json) console.log(JSON.stringify(checks, null, 2));
  else console.log(formatChecks(checks));
  return checks.some((c) => c.status === "invalid") ? 1 : 0;
}

export function formatChecks(checks: readonly Check[]): string {
  const rows = checks.map(
    (c) =>
      `${c.status.padEnd(7)} ${c.kind.padEnd(10)} ${`${c.host}/${c.target}`.padEnd(44)} ${c.proof}${c.fix ? `  => ${c.fix}` : ""}`,
  );
  const n = (s: Status) => checks.filter((c) => c.status === s).length;
  return `${rows.join("\n")}\n-- ${checks.length} checks: ${n("ok")} ok, ${n("fixed")} fixed, ${n("action")} action, ${n("invalid")} invalid, ${n("missing")} missing, ${n("skip")} skipped`;
}

export const AUTH_KINDS = KINDS;
export { secretHas };
