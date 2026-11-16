import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

// Monorepo root = three levels above this file (system/env-kit/src), ENV_KIT_ROOT overrides.
export const DEFAULT_MONOREPO_ENV_PATH = join(
  process.env.ENV_KIT_ROOT ?? resolve(import.meta.dir, "..", "..", ".."),
  ".env",
);

const SECRET_KEY_PATTERN =
  /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|DATABASE_URL|ADMIN_KEY|NUGET_API_KEY)/i;

const SECRET_VALUE_PREFIX_PATTERN =
  /^(sk-|AIza|figd_|gh[pousr]_|github_pat_|npm_|pypi-|ctx7sk-|vcp_|napi_|eyJ[A-Za-z0-9_-]+\.)/;

export interface LoadMonorepoEnvOptions {
  /** Optional explicit path to `.env`. Defaults to walking up from `startDir` or the monorepo `.env`. */
  envPath?: string;
  /** Starting directory when searching upward for `.env`. Defaults to `process.cwd()`. */
  startDir?: string;
  /** Logical service name used in validation diagnostics. */
  service?: string;
  /** Keys that must be non-empty after loading. Throws a masked error if any are missing. */
  required?: readonly string[];
  /** Override already-populated `process.env` keys. Defaults to `false`. */
  override?: boolean;
  /** Inject parsed keys into `process.env`. Defaults to `true`. */
  injectProcessEnv?: boolean;
}

export type RedactedEnvView = Readonly<Record<string, string>>;

export function isSecretKey(key: string, value = ""): boolean {
  if (
    key.endsWith("_DIR") ||
    key.endsWith("_PATH") ||
    key.endsWith("_HOME") ||
    (key.endsWith("_URL") && !/DATABASE_URL|WEBHOOK_URL/i.test(key))
  ) {
    if (!SECRET_VALUE_PREFIX_PATTERN.test(value)) {
      return false;
    }
  }
  return (
    SECRET_KEY_PATTERN.test(key) || SECRET_VALUE_PREFIX_PATTERN.test(value)
  );
}

export function maskValue(key: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return "UNSET";
  }
  if (isSecretKey(key, value)) {
    return `SET [len=${value.length}]`;
  }
  return value;
}

/**
 * Resolves the nearest `.env` walking upward from `startDir`, falling back to the monorepo `.env`.
 */
export function resolveMonorepoEnvPath(
  startDir: string = process.cwd(),
): string {
  let current = resolve(startDir);
  const root = parse(current).root;

  while (true) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (current === root) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return DEFAULT_MONOREPO_ENV_PATH;
}

/**
 * Zero-dependency `.env` parser supporting comments, `export `, single/double quotes, and `\n` / `\"` escapes.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;

    const eqIndex = normalized.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let rawVal = normalized.slice(eqIndex + 1).trim();
    let value = "";

    if (rawVal.startsWith('"')) {
      let i = 1;
      let escaped = false;
      const chars: string[] = [];
      while (i < rawVal.length) {
        const ch = rawVal[i]!;
        if (escaped) {
          if (ch === "n") chars.push("\n");
          else if (ch === "r") chars.push("\r");
          else if (ch === "t") chars.push("\t");
          else chars.push(ch);
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          break;
        } else {
          chars.push(ch);
        }
        i++;
      }
      value = chars.join("");
    } else if (rawVal.startsWith("'")) {
      const endQuote = rawVal.indexOf("'", 1);
      value = endQuote >= 1 ? rawVal.slice(1, endQuote) : rawVal.slice(1);
    } else {
      const commentIdx = rawVal.search(/\s+#/);
      if (commentIdx >= 0) {
        rawVal = rawVal.slice(0, commentIdx);
      }
      value = rawVal.trim();
    }

    result[key] = value;
  }

  return result;
}

/**
 * Formats a key-value pair safely for `.env` / `.dev.vars` files.
 */
export function formatEnvEntry(key: string, value: string): string {
  if (/[\s#"'\r\n]/.test(value)) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
    return `${key}="${escaped}"`;
  }
  return `${key}=${value}`;
}

/**
 * Creates a safe, redacted view over an environment dictionary so `JSON.stringify`,
 * `console.log`, and `Bun.inspect` never leak raw secret values.
 */
export function redactEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const key of Object.keys(source).sort()) {
    const val = source[key];
    if (val === undefined) continue;
    masked[key] = maskValue(key, val);
  }

  const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  Object.defineProperty(masked, inspectSymbol, {
    enumerable: false,
    value: () => ({ ...masked }),
  });
  Object.defineProperty(masked, "toJSON", {
    enumerable: false,
    value: () => ({ ...masked }),
  });

  return masked;
}

export interface LoadedMonorepoEnv {
  readonly envPath: string;
  readonly parsed: Record<string, string>;
  readonly redacted: Record<string, string>;
  get(key: string): string | undefined;
  require(key: string): string;
  toJSON(): Record<string, string>;
}

/**
 * Loads the monorepo `.env` (or nearest `.env`), injects missing keys into `process.env`
 * without overriding existing process env vars unless `override: true`, validates
 * `required` keys per service, and redacts secrets on `inspect` / `JSON.stringify`.
 *
 * Note on Bun v1.4.4 best practice:
 * Bun auto-loads `.env` in CWD and supports `bun --env-file=<repo>/.env` natively.
 * `loadMonorepoEnv` bridges nested monorepo subdirectories and enforces service contracts.
 */
export function loadMonorepoEnv(
  options: LoadMonorepoEnvOptions = {},
): LoadedMonorepoEnv {
  const envPath = options.envPath
    ? resolve(options.envPath)
    : resolveMonorepoEnvPath(options.startDir);
  const inject = options.injectProcessEnv ?? true;
  const override = options.override ?? false;

  const parsed: Record<string, string> = existsSync(envPath)
    ? parseDotEnv(readFileSync(envPath, "utf8"))
    : {};

  if (inject) {
    for (const [key, val] of Object.entries(parsed)) {
      if (val.length === 0 && !override && process.env[key] !== undefined) {
        continue;
      }
      const existing = process.env[key];
      if (override || existing === undefined || existing.length === 0) {
        if (val.length > 0 || override) {
          process.env[key] = val;
        }
      }
    }
  }

  const effectiveValue = (key: string): string | undefined => {
    const procVal = process.env[key];
    if (procVal !== undefined && procVal.length > 0) {
      return procVal;
    }
    const fileVal = parsed[key];
    return fileVal !== undefined && fileVal.length > 0 ? fileVal : undefined;
  };

  if (options.required && options.required.length > 0) {
    const missing = options.required.filter((k) => !effectiveValue(k));
    if (missing.length > 0) {
      const svc = options.service ? `[service=${options.service}] ` : "";
      throw new Error(
        `${svc}Missing required environment variables (${missing.join(", ")}) after checking process.env and ${envPath}`,
      );
    }
  }

  const mergedView: Record<string, string | undefined> = { ...parsed };
  for (const k of Object.keys(parsed)) {
    mergedView[k] = effectiveValue(k) ?? "";
  }
  const redacted = redactEnv(mergedView);
  const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

  const handle: LoadedMonorepoEnv = {
    envPath,
    parsed,
    redacted,
    get(key: string): string | undefined {
      return effectiveValue(key);
    },
    require(key: string): string {
      const val = effectiveValue(key);
      if (!val) {
        const svc = options.service ? `[service=${options.service}] ` : "";
        throw new Error(`${svc}Required environment variable ${key} is UNSET`);
      }
      return val;
    },
    toJSON(): Record<string, string> {
      return redacted;
    },
  };

  // Prevent raw `parsed` dictionary from being dumped via `console.log(handle)` or `Bun.inspect(handle)`
  Object.defineProperty(handle, "parsed", {
    value: parsed,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(handle, inspectSymbol, {
    enumerable: false,
    value: () => ({
      envPath,
      service: options.service ?? "default",
      variables: redacted,
    }),
  });

  return handle;
}

export interface ExportCloudflareDevVarsOptions {
  /** Explicit keys to include. Defaults to non-empty cloud/AI/DB/app secrets relevant to Workers. */
  keys?: readonly string[];
  /** Source `.env` path. Defaults to `<repo>/.env`. */
  envPath?: string;
}

const DEFAULT_CLOUDFLARE_DEV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "DATABASE_URL",
  "NEON_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "EXA_API_KEY",
  "CTX7_API_KEY",
  "GITHUB_TOKEN",
  "FIGMA_ACCESS_TOKEN",
  "SHENRON_MCP_ADMIN_TOKEN",
] as const;

/**
 * Generates a gitignored `.dev.vars` file in `targetDir` for Cloudflare `wrangler dev`.
 * Returns masked summary metadata (never raw values).
 */
export function exportForCloudflareDevVars(
  targetDir: string,
  options: ExportCloudflareDevVarsOptions = {},
): { devVarsPath: string; writtenKeys: string[] } {
  const absDir = resolve(targetDir);
  mkdirSync(absDir, { recursive: true });

  const loaded = loadMonorepoEnv({
    envPath: options.envPath,
    injectProcessEnv: false,
  });

  const candidateKeys = options.keys ?? DEFAULT_CLOUDFLARE_DEV_KEYS;
  const lines: string[] = [
    "# Auto-generated by env-kit for `wrangler dev`. Gitignored (.dev.vars).",
  ];
  const writtenKeys: string[] = [];

  for (const key of candidateKeys) {
    const val = process.env[key] || loaded.parsed[key];
    if (val && val.length > 0) {
      lines.push(formatEnvEntry(key, val));
      writtenKeys.push(key);
    }
  }

  const devVarsPath = join(absDir, ".dev.vars");
  writeFileSync(devVarsPath, `${lines.join("\n")}\n`, "utf8");
  if (process.platform !== "win32") {
    chmodSync(devVarsPath, 0o600);
  }

  // Ensure local .gitignore ignores .dev.vars if a .gitignore exists in targetDir
  const gitignorePath = join(absDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gi = readFileSync(gitignorePath, "utf8");
    if (!gi.split(/\r?\n/).some((l) => l.trim() === ".dev.vars")) {
      writeFileSync(
        gitignorePath,
        `${gi.trimEnd()}\n.dev.vars\n.dev.vars.*\n`,
        "utf8",
      );
    }
  }

  return { devVarsPath, writtenKeys };
}

export interface VercelEnvPayloadItem {
  key: string;
  value: string;
  target: ("production" | "preview" | "development")[];
  type: "encrypted" | "plain";
}

/**
 * Exports structured Vercel environment variable descriptors (or `.env.local` format)
 * with automatic secret classification (`encrypted` vs `plain`) and redacted inspection.
 */
export function exportForVercelEnv(
  options: {
    keys?: readonly string[];
    envPath?: string;
    targets?: ("production" | "preview" | "development")[];
  } = {},
): {
  count: number;
  summary: Record<string, string>;
  toDotEnvLocal(): string;
  items(): VercelEnvPayloadItem[];
} {
  const loaded = loadMonorepoEnv({
    envPath: options.envPath,
    injectProcessEnv: false,
  });
  const selectedKeys =
    options.keys ??
    Object.keys(loaded.parsed).filter(
      (k) =>
        !/^(CARGO_|RUST|UV_|TWINE_|DOTNET_|CC$|CXX$|CMAKE_|VCPKG_|CUDA_|VULKAN_|GOPATH|GOPROXY|CGO_|LUA_)/.test(
          k,
        ),
    );
  const targets = options.targets ?? ["production", "preview", "development"];

  const rawItems: VercelEnvPayloadItem[] = [];
  const summary: Record<string, string> = {};

  for (const key of selectedKeys) {
    const val = process.env[key] || loaded.parsed[key];
    if (!val) continue;
    const secret = isSecretKey(key, val);
    rawItems.push({
      key,
      value: val,
      target: targets,
      type: secret ? "encrypted" : "plain",
    });
    summary[key] = maskValue(key, val);
  }

  return {
    count: rawItems.length,
    summary,
    toDotEnvLocal(): string {
      return `${rawItems.map((i) => formatEnvEntry(i.key, i.value)).join("\n")}\n`;
    },
    items(): VercelEnvPayloadItem[] {
      return rawItems.map((i) => ({ ...i }));
    },
  };
}

/**
 * Updates or appends a single key in `.env` while preserving comments, section structure, and ordering.
 */
export function upsertEnvFileKey(
  envPath: string,
  key: string,
  value: string,
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable identifier: ${key}`);
  }

  const formatted = formatEnvEntry(key, value);
  if (!existsSync(envPath)) {
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, `${formatted}\n`, "utf8");
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  const keyRegex = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;

  const updated = lines.map((line) => {
    if (!replaced && keyRegex.test(line)) {
      replaced = true;
      return formatted;
    }
    return line;
  });

  if (!replaced) {
    if (updated.length > 0 && updated[updated.length - 1] !== "") {
      updated.push("");
    }
    updated.push(formatted);
    updated.push("");
  }

  writeFileSync(envPath, updated.join("\n"), "utf8");
}

/** Keys that describe a shell or process, never a credential or service setting. */
const MERGE_IGNORED_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TERM",
  "LANG",
  "LC_ALL",
  "EDITOR",
  "VISUAL",
  "PS1",
  "HISTSIZE",
  "HISTFILESIZE",
  "HISTCONTROL",
  "IFS",
  "XDG_RUNTIME_DIR",
  "PORT",
  "HOST",
  "BUN_INSTALL",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "APHRODY_HOST_ID",
]);

export interface EnvMergePlan {
  /** Keys absent locally; written as-is. */
  added: Record<string, string>;
  /** Keys present locally with a different value; written as `<KEY>__<SOURCE>`, local value kept. */
  conflicts: Record<string, string>;
  /** Keys already present with the same value. */
  same: string[];
}

/**
 * Plans merging `incoming` (from host `source`) into `local` without ever losing a value:
 * new keys are added, identical keys skipped, differing keys stored under `<KEY>__<SOURCE>`.
 */
export function planEnvMerge(
  local: Readonly<Record<string, string>>,
  incoming: Readonly<Record<string, string>>,
  source: string,
): EnvMergePlan {
  const tag = source.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const plan: EnvMergePlan = { added: {}, conflicts: {}, same: [] };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === "" || MERGE_IGNORED_KEYS.has(key) || key.includes("__"))
      continue;
    const current = local[key];
    if (current === undefined || current === "") {
      plan.added[key] = value;
    } else if (current === value || local[`${key}__${tag}`] === value) {
      plan.same.push(key);
    } else {
      plan.conflicts[`${key}__${tag}`] = value;
    }
  }
  return plan;
}

export { expand, expandSync, readExpanded, siteGet } from "./discover.ts";
