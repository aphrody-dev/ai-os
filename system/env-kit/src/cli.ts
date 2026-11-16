#!/usr/bin/env bun
import { spawnSync } from "./spawn.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { syncAllEditorConfigs } from "./editors";
import { GOOGLE_SCOPES, googleOAuthLoopback } from "./google-auth.ts";
import { gmailProfile, listMessages, sendMessage } from "./gmail.ts";
import { contextEnv, detectContext, exportLines } from "./google-context.ts";
import { formatIdentities, whoami } from "./whoami";
import { collectChecks, loadManifest, runAuth } from "./auth";
import {
  secretDelete,
  secretGet,
  secretHas,
  secretList,
  secretSet,
  storeInfo,
} from "@aphrody/env-kit/vault/sync";
import {
  DEFAULT_MONOREPO_ENV_PATH,
  exportForCloudflareDevVars,
  exportForVercelEnv,
  isSecretKey,
  loadMonorepoEnv,
  maskValue,
  parseDotEnv,
  planEnvMerge,
  upsertEnvFileKey,
} from "./index";

const DOCTOR_SECTIONS: ReadonlyArray<{
  title: string;
  keys: readonly string[];
}> = [
  {
    title: "GitHub & Forge",
    keys: ["GITHUB_TOKEN", "GH_TOKEN"],
  },
  {
    title: "Figma & Design",
    keys: [
      "FIGMA_ACCESS_TOKEN",
      "FIGMA_TOKEN",
      "FIGMA_MATERIAL_ICONS_LOCAL_DIR",
    ],
  },
  {
    title: "Package Registries (npm, Crates.io, PyPI, NuGet)",
    keys: [
      "NPM_TOKEN",
      "CARGO_REGISTRY_TOKEN",
      "UV_PUBLISH_TOKEN",
      "TWINE_PASSWORD",
      "NUGET_API_KEY",
    ],
  },
  {
    title: "Native & Systems Toolchains (Rust, C/C++, Go, Lua)",
    keys: [
      "CARGO_HOME",
      "RUSTC_WRAPPER",
      "CC",
      "CMAKE_GENERATOR",
      "CUDA_PATH",
      "VULKAN_SDK",
      "GOPATH",
      "LUA_PATH",
    ],
  },
  {
    title: "Cloud Infrastructure (GCP, Vercel, Neon, Cloudflare)",
    keys: [
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_REGION",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "VERCEL_TOKEN",
      "VERCEL_ORG_ID",
      "NEON_API_KEY",
      "NEON_ORG_ID",
      "DATABASE_URL",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CF_API_TOKEN",
    ],
  },
  {
    title: "AI Models & Local Inference",
    keys: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_WORKSPACE_ID",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "OPENAI_API_KEY",
      "EXA_API_KEY",
      "CTX7_API_KEY",
      "RING3_BASE_URL",
      "PI_LU_BASE_URL",
    ],
  },
];

function setWindowsUserEnv(key: string, value: string): void {
  if (process.platform !== "win32") return;
  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::SetEnvironmentVariable($env:__EK_KEY, $env:__EK_VAL, 'User')",
    ],
    {
      env: {
        ...process.env,
        __EK_KEY: key,
        __EK_VAL: value,
      },
      stdio: "ignore",
    },
  );
  if (res.status !== 0) {
    throw new Error(`Failed to persist ${key} into Windows User Environment`);
  }
}

function lockWindowsEnvAcl(envPath: string): void {
  if (process.platform !== "win32" || !existsSync(envPath)) return;
  const user = process.env.USERNAME ?? process.env.USER ?? "user";
  spawnSync(
    "icacls.exe",
    [
      envPath,
      "/inheritance:r",
      "/grant:r",
      `${user}:(F)`,
      "*S-1-5-18:(F)",
      "*S-1-5-32-544:(F)",
    ],
    { stdio: "ignore" },
  );
}

const COUPLED_KEYS: Readonly<Record<string, readonly string[]>> = {
  // The GitHub MCP plugin reads GITHUB_PERSONAL_ACCESS_TOKEN; gh reads GH_TOKEN.
  GITHUB_TOKEN: ["GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"],
  GH_TOKEN: ["GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"],
  GITHUB_PERSONAL_ACCESS_TOKEN: ["GITHUB_TOKEN", "GH_TOKEN"],
  FIGMA_ACCESS_TOKEN: ["FIGMA_TOKEN"],
  FIGMA_TOKEN: ["FIGMA_ACCESS_TOKEN"],
  GEMINI_API_KEY: ["GOOGLE_API_KEY"],
  GOOGLE_API_KEY: ["GEMINI_API_KEY"],
};

function runDoctor(envPath: string): number {
  const loaded = loadMonorepoEnv({ envPath, injectProcessEnv: false });
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");

  console.log(
    "=== env-kit Doctor (Zero-Leakage Credential & Toolchain Audit) ===",
  );
  console.log(`Master .env : ${envPath} [exists=${existsSync(envPath)}]`);

  if (process.platform === "win32" && existsSync(envPath)) {
    const acl = spawnSync("icacls.exe", [envPath], { encoding: "utf8" });
    const aclLines = (acl.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("Successfully processed"));
    console.log(`NTFS ACLs   : ${aclLines.join(" | ")}`);
  }

  const gitExcludes = spawnSync(
    "git",
    ["config", "--global", "--get", "core.excludesFile"],
    { encoding: "utf8" },
  );
  console.log(
    `Git Guard   : core.excludesFile=${(gitExcludes.stdout ?? "").trim() || "UNSET"}`,
  );

  for (const section of DOCTOR_SECTIONS) {
    console.log(`\n--- ${section.title} ---`);
    for (const key of section.keys) {
      const val = loaded.parsed[key] || process.env[key] || "";
      console.log(`  ${key.padEnd(32)} : ${maskValue(key, val)}`);
    }
  }

  console.log("\n--- Editor & Agent Harness Wiring ---");
  const targets: ReadonlyArray<[string, string]> = [
    ["OpenCode", join(home, ".config", "opencode", "opencode.jsonc")],
    ["Zed", join(appData, "Zed", "settings.json")],
    ["Pi Settings", join(home, ".pi", "agent", "settings.json")],
    ["Pi Models", join(home, ".pi", "agent", "models.json")],
    ["npmrc", join(home, ".npmrc")],
    ["Claude Settings", join(home, ".claude", "settings.json")],
    ["Claude MCP", join(home, ".claude.json")],
    ["Gemini CLI", join(home, ".gemini", "settings.json")],
    [
      "Antigravity CLI",
      join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
    ],
    ["Antigravity MCP", join(home, ".gemini", "config", "mcp_config.json")],
    ["Vercel CLI Auth", join(appData, "com.vercel.cli", "Data", "auth.json")],
    [
      "Wrangler OAuth",
      join(appData, "xdg.config", ".wrangler", "config", "default.toml"),
    ],
    [
      "Cloudflare CLI",
      join(appData, "xdg.config", "cloudflare", "config", "default.json"),
    ],
  ];

  for (const [label, path] of targets) {
    const exists = existsSync(path);
    let detail = exists ? "READY" : "MISSING";
    if (exists && label === "npmrc") {
      const content = readFileSync(path, "utf8");
      detail = content.includes("${NPM_TOKEN}")
        ? "READY (env-interpolated ${NPM_TOKEN})"
        : "READY";
    }
    console.log(`  ${label.padEnd(18)} : ${detail} (${path})`);
  }

  return 0;
}

/** Secrets also go to the OS store (DPAPI / systemd-creds); a host without one keeps .env only. */
function storeSecret(key: string, value: string): void {
  if (!isSecretKey(key, value) || !value) return;
  try {
    secretSet(key, value);
  } catch (e) {
    console.error(
      `[env-kit] secret store unavailable for ${key}: ${(e as Error).message}`,
    );
  }
}

async function readStdin(): Promise<string> {
  const text = await Bun.stdin.text();
  return text.replace(/\r?\n$/, "");
}

/** The async vault (system/env-kit/vault) when this env-kit runs inside the monorepo; else undefined. */
type VaultModule = typeof import("../../vault/src/index.ts");
let vaultModule: Promise<VaultModule | undefined> | undefined;
export function loadVault(): Promise<VaultModule | undefined> {
  const p = join(import.meta.dir, "..", "..", "vault", "src", "index.ts");
  vaultModule ??= existsSync(p)
    ? import(p).catch(() => undefined)
    : Promise.resolve(undefined);
  return vaultModule;
}

/** Store API: async vault (same files, no FFI on the event loop) or the sync fallback. */
async function secretApi() {
  const v = await loadVault();
  if (v)
    return {
      get: v.getSecret,
      set: (n: string, x: string) => v.setSecret(n, x),
      has: v.hasSecret,
      list: v.listSecrets,
      rm: v.deleteSecret,
      // A secret scoped to hosts is sealed for them at once; the scheduled sync pushes it.
      after: async (n: string) => {
        const [policy, registry] = await Promise.all([
          v.loadPolicy(),
          v.loadRegistry(),
        ]);
        const hosts = v
          .scopeOf(n, registry[n]?.kind ?? "token", policy, registry)
          .filter((h) => h !== "pc");
        if (hosts.length) await v.sealOutbox(hosts).catch(() => undefined);
      },
    };
  return {
    get: async (n: string) => secretGet(n),
    set: async (n: string, x: string) => secretSet(n, x),
    has: async (n: string) => secretHas(n),
    list: async () => secretList(),
    rm: async (n: string) => secretDelete(n),
    after: async (_n: string) => {},
  };
}

async function runSecretCommand(
  envPath: string,
  args: readonly string[],
): Promise<number> {
  const S = await secretApi();
  const sub = args[0] ?? "list";
  const name = args[1];
  const json = args.includes("--json");
  if (sub === "info") {
    const info = storeInfo();
    console.log(json ? JSON.stringify(info) : `${info.backend} ${info.dir}`);
    return 0;
  }
  if (sub === "list") {
    const names = await S.list();
    console.log(json ? JSON.stringify(names) : names.join("\n"));
    return 0;
  }
  if (sub === "set" && name) {
    // The value only ever arrives on stdin (never argv, so never in shell history or ps).
    if (process.stdin.isTTY) {
      console.error(
        "env-kit secret set: pipe the value on stdin (clipboard, provider CLI), never type it",
      );
      return 2;
    }
    const value = await readStdin();
    if (!value) return 1;
    await S.set(name, value);
    await S.after(name);
    // Length only: maskValue() shows values whose name does not look secret.
    console.log(
      `[env-kit] ${name} -> ${storeInfo().backend} (SET [len=${value.length}])`,
    );
    return 0;
  }
  // No "get": a captured stdout (agent, CI log) is not a terminal, so a TTY guard cannot keep a
  // value out of a transcript. Secrets reach a consumer only through its env or its stdin.
  if (sub === "exec" || sub === "pipe") {
    const sep = args.indexOf("--");
    const names = args
      .slice(1, sep < 0 ? undefined : sep)
      .filter((a) => !a.startsWith("--"));
    const command = sep < 0 ? [] : args.slice(sep + 1);
    if (
      !names.length ||
      !command.length ||
      (sub === "pipe" && names.length !== 1)
    ) {
      console.error(
        `Usage: env-kit secret ${sub} NAME${sub === "exec" ? " [NAME...]" : ""} -- <cmd> [args...]`,
      );
      return 2;
    }
    const values = await Promise.all(
      names.map(async (n) => [n, await S.get(n)] as const),
    );
    const missing = values.filter(([, v]) => v === undefined).map(([n]) => n);
    if (missing.length) {
      console.error(`[env-kit] absent from the store: ${missing.join(", ")}`);
      return 1;
    }
    const r = spawnSync(command[0]!, command.slice(1), {
      stdio: sub === "pipe" ? ["pipe", "inherit", "inherit"] : "inherit",
      input: sub === "pipe" ? values[0]![1] : undefined,
      env:
        sub === "exec"
          ? { ...process.env, ...Object.fromEntries(values) }
          : process.env,
    });
    return r.status ?? 1;
  }
  if (sub === "has" && name) return (await S.has(name)) ? 0 : 1;
  if (sub === "rm" && name) return (await S.rm(name)) ? 0 : 1;
  if (sub === "import") {
    // .env -> store, for the given keys or every secret-like key; idempotent.
    const env = existsSync(envPath)
      ? parseDotEnv(readFileSync(envPath, "utf8"))
      : {};
    const keys = args.slice(1).filter((a) => !a.startsWith("--"));
    let n = 0;
    for (const [k, v] of Object.entries(env)) {
      if (!v || (keys.length ? !keys.includes(k) : !isSecretKey(k, v)))
        continue;
      if ((await S.get(k)) === v) continue;
      await S.set(k, v);
      await S.after(k);
      n++;
    }
    console.log(
      `[env-kit] secret import: ${n} updated, ${(await S.list()).length} in ${storeInfo().dir}`,
    );
    return 0;
  }
  console.error(
    "Usage: env-kit secret <info|list|set NAME (stdin)|exec NAME.. -- cmd|pipe NAME -- cmd|has NAME|rm NAME|import [KEY...]>",
  );
  return 2;
}

export function setCredentialEverywhere(
  envPath: string,
  key: string,
  value: string,
): void {
  upsertEnvFileKey(envPath, key, value);
  setWindowsUserEnv(key, value);
  storeSecret(key, value);
  process.env[key] = value;

  const coupled = COUPLED_KEYS[key] ?? [];
  for (const mirrorKey of coupled) {
    upsertEnvFileKey(envPath, mirrorKey, value);
    setWindowsUserEnv(mirrorKey, value);
    storeSecret(mirrorKey, value);
    process.env[mirrorKey] = value;
  }

  lockWindowsEnvAcl(envPath);
  syncAllEditorConfigs();

  const updatedNames = [key, ...coupled].join(", ");
  console.log(
    `[env-kit] Updated ${updatedNames} -> ${maskValue(key, value)} across ${envPath}, Windows User Env, OpenCode, Zed, and Pi.`,
  );
}

/** Credential-like names pulled from the Windows user environment by `merge --from-windows`. */
const WINDOWS_CREDENTIAL_KEY =
  /(TOKEN|SECRET|KEY|PASSWORD|PASS|_ID|ACCOUNT|ENDPOINT|DSN|DATABASE_URL|WEBHOOK)/;

function readWindowsUserEnv(): Record<string, string> {
  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::GetEnvironmentVariables('User') | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0 || !res.stdout) return {};
  const all = JSON.parse(res.stdout) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(all).filter(
      ([k, v]) =>
        typeof v === "string" &&
        WINDOWS_CREDENTIAL_KEY.test(k) &&
        !/[\\/]/.test(v.slice(0, 3)),
    ),
  );
}

/**
 * `env-kit merge --source <name> [--from-windows] [--dry-run]`: merge dotenv text from stdin
 * (or the Windows user environment) into `.env`. Prints key names only, never values.
 */
async function runMerge(
  envPath: string,
  args: readonly string[],
): Promise<number> {
  const at = args.indexOf("--source");
  const fromWindows = args.includes("--from-windows");
  const source = at >= 0 ? args[at + 1] : fromWindows ? "windows" : undefined;
  if (!source) {
    console.error(
      "Usage: env-kit merge --source <host> [--dry-run] < file.env | env-kit merge --from-windows",
    );
    return 1;
  }
  const incoming = fromWindows
    ? readWindowsUserEnv()
    : parseDotEnv(await Bun.stdin.text());
  const local = existsSync(envPath)
    ? parseDotEnv(readFileSync(envPath, "utf8"))
    : {};
  const plan = planEnvMerge(local, incoming, source);
  const writes = { ...plan.added, ...plan.conflicts };
  if (!args.includes("--dry-run")) {
    for (const [k, v] of Object.entries(writes))
      upsertEnvFileKey(envPath, k, v);
    if (Object.keys(writes).length > 0) lockWindowsEnvAcl(envPath);
  }
  console.log(
    `[env-kit] merge ${source}: ${Object.keys(plan.added).length} added, ${Object.keys(plan.conflicts).length} conflicts kept as <KEY>__${source.toUpperCase()}, ${plan.same.length} identical`,
  );
  for (const k of Object.keys(plan.added).sort()) console.log(`  + ${k}`);
  for (const k of Object.keys(plan.conflicts).sort()) console.log(`  ~ ${k}`);
  return 0;
}

function printHelp(): void {
  console.log(`env-kit — Multi-Language Environment & Secret Manager

Usage:
  env-kit whoami [--json]               Who every configured credential belongs to (parallel, masked)
  env-kit gcloud-context [--apply|--export]  Detect project/account/key from the current repo
  env-kit google-auth <gmail|calendar|drive>  One-click OAuth: approve in the browser, token to vault
  env-kit gmail <status|list|send>      Gmail automation (send needs --yes)
  env-kit doctor                       Audit masked status of all credentials, ACLs, and editors
  env-kit accounts status [--json]     (-> frameworks/google-ts/src/gcp) Inspect 3-principal gcloud configs, rclone, and org provider surfaces
  env-kit accounts init-gcloud         Idempotently initialize ai-agent, owner, org-contact, sa-automation
  env-kit accounts switch <principal>  Activate gcloud configuration for <ai|owner|org|sa>
  env-kit billing <status|plan|apply|lift|relink>  GCP billing via billing-agent (keyless): budgets, spend, idle resources
  env-kit accounts iam-bindings        Print idempotent GCP IAM policy bindings for project aphrody
  env-kit set <KEY> <VALUE>            Set key in <repo>/.env + Windows User Env + sync editors
  env-kit merge --source <host>        Merge dotenv from stdin into .env (new keys added, differing as KEY__HOST)
  env-kit merge --from-windows         Merge credential-like Windows user env vars into .env
  env-kit nuget-set-key <API_KEY>     Set NUGET_API_KEY and register with dotnet nuget config
  env-kit sync-editors                 Re-wire OpenCode, Zed, and Pi provider/MCP configs
  env-kit sync-gh                      Sync current 'gh auth token' into GITHUB_TOKEN & GH_TOKEN
  env-kit dev-vars <projectDir>        Write gitignored .dev.vars for Cloudflare wrangler dev
  env-kit vercel-env [projectDir]      Preview masked Vercel env summary (or write .env.local with --write)
  env-kit exec -- <cmd> [args...]      Execute command with <repo>/.env injected into child process
  env-kit secret <info|list|set|exec|pipe|has|rm|import>  OS secret store (DPAPI / systemd-creds); values in via stdin, out via child env/stdin only
  env-kit vault <init|add|import-chrome-csv|export-chrome-csv|sync|status|rotate|hosts|doc|fp|backup|restore|hello>  age vault per host
  env-kit auth status [--json] [--only k,..]  Every auth: CLIs, Chrome, tokens, store, CI secrets, ssh, WireGuard, tunnels
  env-kit auth repair [--browser]      Fix without password; --browser opens sign-in pages the owner clicks
  env-kit auth login [cli...]          Log in the CLIs whose check fails, device flow (RFC 8628) when headless
  env-kit auth oidc [--dry-run]        GitHub Actions OIDC -> GCP Workload Identity Federation ([auth.oidc])
  env-kit auth mint cloudflare --perm "<group>,..." [--ttl s] -- <cmd>   Scoped, expiring token for one command
  env-kit auth mint gcp --sa <email> [--ttl s] -- <cmd>                  Keyless service-account token (impersonation)
  env-kit auth github-app [create|install|status|hook|token|user|user-token|retire|crates-trust]  GitHub App "aphrody-labs"
  env-kit auth gh-secrets [--dry-run]  gh secret set from the store (device/deploy.toml [auth.github])
  env-kit auth tunnels [--dry-run]     cloudflared tokens from the Cloudflare API into systemd-creds
  env-kit auth rotate cloudflare       Roll CLOUDFLARE_API_TOKEN through the API; store, .env, user env, then gh-secrets
`);
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const cmd = argv[0];
  const envPath = process.env.ENV_KIT_FILE ?? DEFAULT_MONOREPO_ENV_PATH;

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return 0;
  }

  if (cmd === "doctor") {
    return runDoctor(envPath);
  }

  if (cmd === "whoami") {
    loadMonorepoEnv({ envPath, override: false, injectProcessEnv: true });
    const ids = await whoami(process.env);
    if (argv.includes("--json")) console.log(JSON.stringify(ids, null, 2));
    else
      console.log(`--- Identity (credentials -> owner, secrets never printed) ---
${formatIdentities(ids)}`);
    return ids.some((i) => i.status === "invalid") ? 1 : 0;
  }

  if (cmd === "secret") {
    return runSecretCommand(envPath, argv.slice(1));
  }

  // Vault: age envelopes per host, Chromium CSV, documents, profiles.
  if (cmd === "vault") {
    const p = join(import.meta.dir, "..", "..", "vault", "src", "cli.ts");
    if (!existsSync(p)) {
      console.error("env-kit vault: system/env-kit/vault absent (monorepo only)");
      return 2;
    }
    const { main: vaultMain } = (await import(p)) as {
      main: (a: string[]) => Promise<number>;
    };
    return vaultMain(argv.slice(1));
  }

  if (cmd === "auth") {
    loadMonorepoEnv({ envPath, override: false, injectProcessEnv: true });
    const flag = (n: string) => argv.includes(n);
    const only =
      argv.find((a) => a.startsWith("--only="))?.slice(7) ??
      (argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined);
    const root =
      process.env.SRC_ROOT ?? resolve(import.meta.dir, "..", "..", "..");
    const base = {
      root,
      json: flag("--json"),
      deep: (argv[1] ?? "status") === "status",
      browser: flag("--browser"),
      dryRun: flag("--dry-run"),
      only: only?.split(","),
      args:
        argv[1] === "mint" || argv[1] === "github-app"
          ? argv.slice(2)
          : argv[1] === "login"
            ? argv.slice(2).filter((a) => !a.startsWith("-"))
            : undefined,
      persist: (k: string, v: string) => setCredentialEverywhere(envPath, k, v),
    };
    if (argv[1] === "login") {
      // `<binary> auth login [service]`: services with their own flow, the CLIs of auth.ts, or a list to pick from.
      const svc = await import("./auth-services.ts");
      return svc.dispatchLogin(argv.slice(2), {
        services: svc.SERVICES,
        runCli: (t) => runAuth("login", { ...base, args: t }),
        attention: async () =>
          (
            await collectChecks(
              loadManifest(root),
              { ...base, deep: false, only: ["cli", "browser"], args: undefined },
              false,
            )
          ).filter((c) => c.status === "action" || c.status === "invalid"),
        isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
        ask: (q) => prompt(q),
        out: (s) => console.log(s),
      });
    }
    return runAuth(argv[1] ?? "status", base);
  }

  if (cmd === "accounts" || cmd === "billing") {
    // Google Cloud lives in frameworks/google-ts/src/gcp (split from env-kit); same commands.
    const gcp = Bun.resolveSync("@aphrody/google/gcp/cli", import.meta.dir);
    return spawnSync(process.execPath, [gcp, ...argv], { stdio: "inherit", env: process.env }).status ?? 1;
  }

  if (cmd === "set") {
    const key = argv[1];
    const val = argv[2];
    if (!key || val === undefined) {
      console.error("Usage: env-kit set <KEY> <VALUE>");
      return 1;
    }
    setCredentialEverywhere(envPath, key, val);
    return 0;
  }

  if (cmd === "merge") {
    return runMerge(envPath, argv.slice(1));
  }

  if (cmd === "nuget-set-key") {
    const apiKey = argv[1];
    if (!apiKey) {
      console.error("Usage: env-kit nuget-set-key <NUGET_API_KEY>");
      return 1;
    }
    setCredentialEverywhere(envPath, "NUGET_API_KEY", apiKey);
    console.log(
      "[env-kit] NUGET_API_KEY ready for `dotnet nuget push --api-key $env:NUGET_API_KEY -s https://api.nuget.org/v3/index.json`.",
    );
    return 0;
  }

  if (cmd === "sync-editors") {
    loadMonorepoEnv({ envPath, override: false, injectProcessEnv: true });
    const res = syncAllEditorConfigs();
    for (const f of res.updatedFiles) {
      console.log(`[env-kit] Synced editor config: ${f}`);
    }
    return 0;
  }

  if (cmd === "sync-gh") {
    const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
    const tok = (gh.stdout ?? "").trim();
    if (gh.status !== 0 || !tok) {
      console.error("[env-kit] Could not retrieve token from `gh auth token`.");
      return 1;
    }
    setCredentialEverywhere(envPath, "GITHUB_TOKEN", tok);
    return 0;
  }

  if (cmd === "gcloud-context") {
    loadMonorepoEnv({ envPath, override: false, injectProcessEnv: true });
    const ctx = detectContext(process.cwd());
    const envObj = contextEnv(ctx, process.env);
    if (argv.includes("--apply")) {
      // Switch the gcloud CLI config too, so ad hoc `gcloud` calls match the detected context.
      try {
        spawnSync(
          "gcloud",
          ["config", "configurations", "activate", ctx.name],
          { stdio: "ignore" },
        );
      } catch {}
      process.stdout.write(`${exportLines(envObj)}\n`);
      console.error(
        `[env-kit] context ${ctx.name}: project ${ctx.project}, account ${ctx.account}`,
      );
      return 0;
    }
    if (argv.includes("--export")) {
      process.stdout.write(`${exportLines(envObj)}\n`);
      return 0;
    }
    console.log(`context: ${ctx.name}`);
    console.log(`  project: ${ctx.project} (#${ctx.projectNumber})`);
    console.log(`  account: ${ctx.account}`);
    console.log(
      `  credentials: ${envObj.GOOGLE_APPLICATION_CREDENTIALS ?? "(ADC, no key file)"}`,
    );
    console.log(
      'run `eval "$(env-kit gcloud-context --apply)"` to apply to the current shell',
    );
    return 0;
  }

  if (cmd === "google-auth") {
    const surface = argv[1] ?? "gmail";
    const scopes = GOOGLE_SCOPES[surface];
    if (!scopes) {
      console.error(
        `Usage: env-kit google-auth <${Object.keys(GOOGLE_SCOPES).join("|")}>`,
      );
      return 1;
    }
    loadMonorepoEnv({ envPath, override: false, injectProcessEnv: true });
    const clientId = process.env.GOOGLE_INSTALLED_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_INSTALLED_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error(
        "[env-kit] GOOGLE_INSTALLED_CLIENT_ID/SECRET (desktop OAuth client) are required.",
      );
      return 1;
    }
    console.log(
      `[env-kit] Opening Google consent for ${surface}; approve in the browser (no password is typed here).`,
    );
    try {
      const tokens = await googleOAuthLoopback({
        clientId,
        clientSecret,
        scopes,
        openBrowser: (url) =>
          spawnSync(
            process.platform === "win32"
              ? "cmd"
              : process.platform === "darwin"
                ? "open"
                : "xdg-open",
            process.platform === "win32" ? ["/c", "start", "", url] : [url],
            { stdio: "ignore" },
          ),
      });
      setCredentialEverywhere(
        envPath,
        `GOOGLE_${surface.toUpperCase()}_REFRESH_TOKEN`,
        tokens.refresh_token,
      );
      console.log(
        `[env-kit] Stored GOOGLE_${surface.toUpperCase()}_REFRESH_TOKEN in the vault.`,
      );
      return 0;
    } catch (err) {
      console.error(`[env-kit] google-auth failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (cmd === "gmail") {
    loadMonorepoEnv({ envPath, override: false, injectProcessEnv: true });
    const creds = {
      clientId: process.env.GOOGLE_INSTALLED_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_INSTALLED_CLIENT_SECRET ?? "",
      refreshToken: process.env.GOOGLE_GMAIL_REFRESH_TOKEN ?? "",
    };
    if (!creds.refreshToken) {
      console.error(
        "[env-kit] No Gmail token. Run `env-kit google-auth gmail` first.",
      );
      return 1;
    }
    const sub = argv[1] ?? "status";
    try {
      if (sub === "status") {
        const p = await gmailProfile(creds);
        console.log(`gmail ${p.email}: ${p.unread} unread / ${p.total} total`);
        return 0;
      }
      if (sub === "list") {
        const query = argv.slice(2).join(" ") || "is:unread newer_than:7d";
        for (const m of await listMessages(creds, query))
          console.log(
            `  ${m.date.slice(0, 16).padEnd(16)} ${m.from.slice(0, 32).padEnd(32)} ${m.subject}`,
          );
        return 0;
      }
      if (sub === "send") {
        const to = argv[2];
        const subject = argv[3];
        const body = argv.slice(4).join(" ");
        if (!to || !subject || !body || !argv.includes("--yes")) {
          console.error(
            "Usage: env-kit gmail send <to> <subject> <body...> --yes  (sending needs explicit --yes)",
          );
          return 1;
        }
        const { id } = await sendMessage(
          creds,
          { to, subject, body: body.replace(" --yes", "") },
          true,
        );
        console.log(`gmail sent id=${id}`);
        return 0;
      }
      console.error(
        "Usage: env-kit gmail <status|list [query]|send <to> <subject> <body> --yes>",
      );
      return 1;
    } catch (err) {
      console.error(`[env-kit] gmail failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (cmd === "dev-vars") {
    const targetDir = argv[1] ?? process.cwd();
    const res = exportForCloudflareDevVars(targetDir, { envPath });
    console.log(
      `[env-kit] Wrote ${res.writtenKeys.length} keys (${res.writtenKeys.join(", ")}) to ${res.devVarsPath}`,
    );
    return 0;
  }

  if (cmd === "vercel-env") {
    const writeFlag = argv.includes("--write");
    const targetDir =
      argv.slice(1).find((a) => !a.startsWith("-")) ?? process.cwd();
    const exported = exportForVercelEnv({ envPath });
    console.log(
      `[env-kit] Prepared ${exported.count} Vercel environment entries:`,
    );
    for (const [k, masked] of Object.entries(exported.summary)) {
      console.log(`  ${k.padEnd(30)} : ${masked}`);
    }
    if (writeFlag) {
      const outFile = join(resolve(targetDir), ".env.local");
      await Bun.write(outFile, exported.toDotEnvLocal());
      console.log(`[env-kit] Wrote gitignored ${outFile}`);
    }
    return 0;
  }

  if (cmd === "exec") {
    const sepIdx = argv.indexOf("--");
    const childArgs = sepIdx >= 0 ? argv.slice(sepIdx + 1) : argv.slice(1);
    if (childArgs.length === 0) {
      console.error("Usage: env-kit exec -- <command> [args...]");
      return 1;
    }
    loadMonorepoEnv({ envPath, override: false, injectProcessEnv: true });
    const child = spawnSync(childArgs[0]!, childArgs.slice(1), {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    return child.status ?? 1;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  return 1;
}

if (import.meta.main) {
  // Top-level await keeps the loop alive while Bun.stdin is read; exitCode (not exit())
  // avoids truncating piped stdout on Windows.
  process.exitCode = await main();
}
