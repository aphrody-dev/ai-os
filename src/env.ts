import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export const DEFAULT_MONOREPO_ENV_PATH =
  process.platform === "win32" ? "C:\\src\\.env" : "/src/.env";

const SECRET_KEY_PATTERN =
  /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|DATABASE_URL|ADMIN_KEY|NUGET_API_KEY)/i;

const SECRET_VALUE_PREFIX_PATTERN =
  /^(sk-|AIza|figd_|gh[pousr]_|github_pat_|npm_|pypi-|ctx7sk-|vcp_|napi_|eyJ[A-Za-z0-9_-]+\.)/;

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

export function maskSecret(key: string, value: string | undefined): string {
  if (!value || value.length === 0) return "UNSET";
  if (isSecretKey(key, value)) return `SET [len=${value.length}]`;
  return value;
}

export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;
    const eqIdx = normalized.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = normalized.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let rawVal = normalized.slice(eqIdx + 1).trim();
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
      if (commentIdx >= 0) rawVal = rawVal.slice(0, commentIdx);
      value = rawVal.trim();
    }
    result[key] = value;
  }
  return result;
}

export function resolveEnvPath(startDir: string = process.cwd()): string {
  if (existsSync(DEFAULT_MONOREPO_ENV_PATH)) {
    return DEFAULT_MONOREPO_ENV_PATH;
  }
  let current = resolve(startDir);
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) return candidate;
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return DEFAULT_MONOREPO_ENV_PATH;
}

export interface SovereignEnvHandle {
  readonly envPath: string;
  get(key: string): string | undefined;
  status(keys: readonly string[]): Record<string, string>;
}

let cachedEnv: SovereignEnvHandle | null = null;

export function getSovereignEnv(explicitPath?: string): SovereignEnvHandle {
  if (!explicitPath && cachedEnv) return cachedEnv;
  const envPath = explicitPath ? resolve(explicitPath) : resolveEnvPath();
  const parsed: Record<string, string> = existsSync(envPath)
    ? parseDotEnv(readFileSync(envPath, "utf8"))
    : {};

  for (const [key, val] of Object.entries(parsed)) {
    if (
      (process.env[key] === undefined || process.env[key] === "") &&
      val.length > 0
    ) {
      process.env[key] = val;
    }
  }

  const handle: SovereignEnvHandle = {
    envPath,
    get(key: string): string | undefined {
      const proc = process.env[key];
      if (proc && proc.length > 0) return proc;
      const fromFile = parsed[key];
      return fromFile && fromFile.length > 0 ? fromFile : undefined;
    },
    status(keys: readonly string[]): Record<string, string> {
      const out: Record<string, string> = {};
      for (const k of keys) {
        out[k] = maskSecret(k, handle.get(k));
      }
      return out;
    },
  };

  const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  Object.defineProperty(handle, inspectSymbol, {
    enumerable: false,
    value: () => ({ envPath, mode: "redacted" }),
  });

  if (!explicitPath) cachedEnv = handle;
  return handle;
}
