// SPDX-License-Identifier: Apache-2.0
/**
 * `env-kit whoami`: asks every provider who the configured credentials belong to, in parallel.
 * Prints identities only (login, e-mail, account name); secrets are read from the process env and
 * never printed. A provider whose credential is missing reports `unset`, a rejected one `invalid`.
 */

import { spawnSync } from "./spawn.ts";

export interface Identity {
  provider: string;
  status: "ok" | "unset" | "invalid";
  identity?: string;
  detail?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function run(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function json(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; body: any }> {
  try {
    const r = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: r.ok, body: await r.json().catch(() => null) };
  } catch {
    return { ok: false, body: null };
  }
}

const cli = (provider: string, out: string | null): Identity =>
  out
    ? { provider, status: "ok", identity: out.split("\n")[0] }
    : { provider, status: "invalid" };

/** OVH signed request: X-Ovh-Signature = "$1$" + sha1(secret+consumer+method+url+body+timestamp). */
async function ovhMe(env: Env): Promise<Identity> {
  const ak = env.OVH_APPLICATION_KEY,
    as = env.OVH_APPLICATION_SECRET,
    ck = env.OVH_CONSUMER_KEY;
  if (!ak || !as || !ck) return { provider: "ovh", status: "unset" };
  const base = env.OVH_ENDPOINT?.startsWith("http")
    ? env.OVH_ENDPOINT
    : "https://eu.api.ovh.com/1.0";
  const time = await fetch(`${base}/auth/time`)
    .then((r) => r.text())
    .catch(() => `${Math.floor(Date.now() / 1000)}`);
  const url = `${base}/me`;
  const sig =
    "$1$" +
    new Bun.CryptoHasher("sha1")
      .update(`${as}+${ck}+GET+${url}++${time.trim()}`)
      .digest("hex");
  const r = await json(url, {
    headers: {
      "X-Ovh-Application": ak,
      "X-Ovh-Consumer": ck,
      "X-Ovh-Timestamp": time.trim(),
      "X-Ovh-Signature": sig,
    },
  });
  return r.ok
    ? {
        provider: "ovh",
        status: "ok",
        identity: `${r.body?.nichandle} <${r.body?.email}>`,
      }
    : { provider: "ovh", status: "invalid" };
}

async function cloudflare(env: Env): Promise<Identity> {
  const t = env.CLOUDFLARE_API_TOKEN;
  if (!t) return { provider: "cloudflare", status: "unset" };
  const h = { headers: { Authorization: `Bearer ${t}` } };
  // User tokens verify on /user, account-owned tokens (cfat_) on /accounts/<id>.
  let v = await json(
    "https://api.cloudflare.com/client/v4/user/tokens/verify",
    h,
  );
  if (!v.ok && env.CLOUDFLARE_ACCOUNT_ID)
    v = await json(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/tokens/verify`,
      h,
    );
  if (!v.ok) return { provider: "cloudflare", status: "invalid" };
  const acc = await json(
    "https://api.cloudflare.com/client/v4/accounts?per_page=5",
    h,
  );
  const names = (acc.body?.result ?? [])
    .map((a: { name: string }) => a.name)
    .join(", ");
  return {
    provider: "cloudflare",
    status: "ok",
    identity: names || "token active",
    detail: `token ${v.body?.result?.status}`,
  };
}

async function hostinger(env: Env): Promise<Identity> {
  const t = env.HOSTINGER_API_TOKEN;
  if (!t) return { provider: "hostinger", status: "unset" };
  const r = await json(
    "https://developers.hostinger.com/api/vps/v1/virtual-machines",
    {
      headers: { Authorization: `Bearer ${t}` },
    },
  );
  const vms = Array.isArray(r.body) ? r.body : (r.body?.data ?? []);
  return r.ok
    ? {
        provider: "hostinger",
        status: "ok",
        identity:
          vms.map((v: { hostname: string }) => v.hostname).join(", ") ||
          "token active",
      }
    : { provider: "hostinger", status: "invalid" };
}

function claudeStatus(env: Env): Record<string, string | boolean> | null {
  const r = spawnSync("claude", ["auth", "status"], {
    encoding: "utf8",
    timeout: 20_000,
    env: env as NodeJS.ProcessEnv,
  });
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

/** Both Claude identities: the claude.ai account (OAuth) and whether an API key overrides it. */
function claude(env: Env): Identity[] {
  const { ANTHROPIC_API_KEY, ...rest } = env;
  const oauth = claudeStatus(rest);
  const out: Identity[] = [
    oauth?.loggedIn && oauth.authMethod === "claude.ai"
      ? {
          provider: "claude.ai",
          status: "ok",
          identity: String(oauth.email),
          detail: `${oauth.subscriptionType} until ${String(oauth.loginExpiresAt).slice(0, 10)}`,
        }
      : oauth?.loggedIn && oauth.authMethod === "oauth_token"
        ? // Long-lived token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN, vault): same subscription, no session.
          {
            provider: "claude.ai",
            status: "ok",
            identity: "CLAUDE_CODE_OAUTH_TOKEN",
            detail: "claude setup-token (1 an)",
          }
        : { provider: "claude.ai", status: "invalid" },
  ];
  if (ANTHROPIC_API_KEY) {
    const k = claudeStatus(env);
    out.push({
      provider: "claude-api",
      status: k?.loggedIn ? "ok" : "invalid",
      identity: "ANTHROPIC_API_KEY",
      detail:
        "overrides claude.ai in claude CLI sessions (connectors disabled)",
    });
  }
  return out;
}

/**
 * crates.io API tokens may not read /me: a valid token gets 403 "only on the crates.io website",
 * a rejected one 403 "authentication failed". crates.io also requires a User-Agent.
 */
async function cratesIo(env: Env): Promise<Identity> {
  const t = env.CARGO_REGISTRY_TOKEN;
  if (!t) return { provider: "crates.io", status: "unset" };
  const r = await json("https://crates.io/api/v1/me", {
    headers: {
      Authorization: t,
      "User-Agent": "aphrody-env-kit (contact@aphrody.com)",
    },
  });
  const detail = String(r.body?.errors?.[0]?.detail ?? "");
  if (r.ok)
    return {
      provider: "crates.io",
      status: "ok",
      identity: r.body?.user?.login,
    };
  return /only be performed on the crates.io website/.test(detail)
    ? {
        provider: "crates.io",
        status: "ok",
        identity: "API token accepted",
        detail: "/me is website-only",
      }
    : { provider: "crates.io", status: "invalid" };
}

const bearer = (
  provider: string,
  url: string,
  token: string | undefined,
  pick: (b: any) => string | undefined,
  header = "Authorization",
  prefix = "Bearer ",
) =>
  token
    ? json(url, {
        headers: { [header]: `${prefix}${token}`, "User-Agent": "env-kit" },
      }).then((r): Identity =>
        r.ok
          ? { provider, status: "ok", identity: pick(r.body) ?? "token active" }
          : { provider, status: "invalid" },
      )
    : Promise.resolve<Identity>({ provider, status: "unset" });

function windows(): Identity {
  const user = run("whoami", []);
  const reg = run("reg", [
    "query",
    "HKCU\\Software\\Microsoft\\IdentityCRL\\UserExtendedProperties",
  ]);
  const msa = [...(reg ?? "").matchAll(/\\([^\\\s]+@[^\\\s]+)/g)].map(
    (m) => m[1],
  );
  return user
    ? {
        provider: "windows",
        status: "ok",
        identity: user,
        detail: msa.length
          ? `Microsoft account ${msa.join(", ")}`
          : "local account",
      }
    : { provider: "windows", status: "invalid" };
}

function gcloud(): Identity {
  const all = run("gcloud", ["auth", "list", "--format=value(account,status)"]);
  if (!all) return { provider: "gcloud", status: "invalid" };
  const rows = all.split("\n").map((l) => l.trim().split(/\s+/));
  const active = rows.find((r) => r[1] === "*" || r[1] === "ACTIVE")?.[0];
  return {
    provider: "gcloud",
    status: "ok",
    identity: active ?? rows[0]?.[0],
    detail: `${rows.length} accounts: ${rows.map((r) => r[0]).join(", ")}`,
  };
}

function steam(env: Env): Identity {
  try {
    const dir = env.STEAM_DIR ?? "C:/Program Files (x86)/Steam";
    const vdf = require("node:fs").readFileSync(
      `${dir}/config/loginusers.vdf`,
      "utf8",
    ) as string;
    const names = [...vdf.matchAll(/"AccountName"\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    return names.length
      ? {
          provider: "steam",
          status: "ok",
          identity: names.join(", "),
          detail: "local client",
        }
      : { provider: "steam", status: "unset" };
  } catch {
    return { provider: "steam", status: "unset" };
  }
}

/** Every identity probe, run concurrently. */
export async function whoami(env: Env = process.env): Promise<Identity[]> {
  const gh = run("gh", ["api", "user", "-q", `.login + " " + (.email // "")`]);
  const results = await Promise.all([
    Promise.resolve(windows()),
    Promise.resolve(
      cli("git", run("git", ["config", "--global", "user.email"])),
    ),
    Promise.resolve(cli("github", gh)),
    Promise.resolve(gcloud()),
    cloudflare(env),
    ovhMe(env),
    hostinger(env),
    bearer(
      "vercel",
      "https://api.vercel.com/v2/user",
      env.VERCEL_TOKEN,
      (b) => b?.user && `${b.user.username} <${b.user.email}>`,
    ),
    bearer(
      "neon",
      "https://console.neon.tech/api/v2/users/me",
      env.NEON_API_KEY,
      (b) => b?.email,
    ),
    bearer(
      "npm",
      "https://registry.npmjs.org/-/whoami",
      env.NPM_TOKEN,
      (b) => b?.username,
    ),
    cratesIo(env),
    bearer(
      "supabase",
      "https://api.supabase.com/v1/projects",
      env.SUPABASE_ACCESS_TOKEN,
      (b) =>
        Array.isArray(b)
          ? b.map((p: { name: string }) => p.name).join(", ")
          : undefined,
    ),
    Promise.resolve(steam(env)),
  ]);
  return [...results, ...claude(env)];
}

export function formatIdentities(ids: readonly Identity[]): string {
  return ids
    .map(
      (i) =>
        `  ${i.provider.padEnd(11)} ${i.status.padEnd(8)} ${i.identity ?? ""}${i.detail ? `  (${i.detail})` : ""}`,
    )
    .join("\n");
}
