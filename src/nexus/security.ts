import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { getSovereignEnv, maskSecret } from "../env.ts";

export const DEFAULT_GCP_PROJECT = "aphrody";
export const DEFAULT_VERTEX_LOCATION = "global";

export interface GoogleAuthResolution {
  ok: boolean;
  projectId: string;
  adcPath: string;
  healedBrokenEnvPath: boolean;
  previousBrokenPath?: string;
  mechanism: "gcloud-cli" | "adc-refresh-token" | "env-token" | "unavailable";
  account?: string;
  tokenAvailable: boolean;
}

interface CachedTokenEntry {
  token: string;
  expiresAtMs: number;
  mechanism: GoogleAuthResolution["mechanism"];
}

const tokenCache = new Map<string, CachedTokenEntry>();

const EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/gu;

const INLINE_SECRET_REGEX =
  /\b(sk-[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|figd_[A-Za-z0-9_-]{10,}|vcp_[A-Za-z0-9_-]{10,}|ctx7sk-[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9_.-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;

export function stripEmojis(text: string): string {
  return text.replace(EMOJI_REGEX, "").replace(/  +/g, " ");
}

export function hasEmojis(text: string): boolean {
  EMOJI_REGEX.lastIndex = 0;
  return EMOJI_REGEX.test(text);
}

export function redactSecretsFromText(text: string): string {
  if (!text) return "";
  return text
    .replace(INLINE_SECRET_REGEX, (match) => `[REDACTED:len=${match.length}]`)
    .replace(
      /(Bearer\s+)([A-Za-z0-9_.-]{12,})/gi,
      (_full, prefix: string, tok: string) =>
        `${prefix}[REDACTED:len=${tok.length}]`,
    );
}

export function assertSafeUserspacePath(targetPath: string): string {
  const resolved = normalize(resolve(targetPath));
  const lower = resolved.toLowerCase();
  if (
    lower.startsWith("c:\\windows\\system32") ||
    lower.startsWith("c:\\windows\\syswow64") ||
    lower === "c:\\windows"
  ) {
    throw new Error(
      `Sacred Host Userspace violation blocked: write access to ${resolved} is strictly forbidden.`,
    );
  }
  return resolved;
}

export function resolveCanonicalAdcPath(home = homedir()): {
  adcPath: string;
  healed: boolean;
  previousBrokenPath?: string;
} {
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const canonicalWin = join(
    appData,
    "gcloud",
    "application_default_credentials.json",
  );
  const canonicalPosix = join(
    home,
    ".config",
    "gcloud",
    "application_default_credentials.json",
  );
  const fallbackAdc =
    process.platform === "win32" ? canonicalWin : canonicalPosix;

  const currentEnvPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (currentEnvPath && existsSync(currentEnvPath)) {
    return { adcPath: currentEnvPath, healed: false };
  }

  const healed = Boolean(currentEnvPath && !existsSync(currentEnvPath));
  if (existsSync(fallbackAdc)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = fallbackAdc;
  }
  return {
    adcPath: fallbackAdc,
    healed,
    previousBrokenPath: healed ? currentEnvPath : undefined,
  };
}

function resolveGcloudCmd(): string[] {
  if (process.platform === "win32") {
    const candidates = [
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Google",
        "Cloud SDK",
        "google-cloud-sdk",
        "bin",
        "gcloud.cmd",
      ),
      "C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd",
    ];
    for (const c of candidates) {
      if (existsSync(c)) return ["cmd.exe", "/d", "/s", "/c", c];
    }
    return ["cmd.exe", "/d", "/s", "/c", "gcloud"];
  }
  return ["gcloud"];
}

async function mintViaAdcRefreshToken(
  adcPath: string,
): Promise<string | undefined> {
  if (!existsSync(adcPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(adcPath, "utf8")) as {
      type?: string;
      client_id?: string;
      client_secret?: string;
      refresh_token?: string;
    };
    if (
      raw.type === "authorized_user" &&
      raw.client_id &&
      raw.client_secret &&
      raw.refresh_token
    ) {
      const body = new URLSearchParams({
        client_id: raw.client_id,
        client_secret: raw.client_secret,
        refresh_token: raw.refresh_token,
        grant_type: "refresh_token",
      });
      const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(6000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { access_token?: string };
        if (data.access_token) return data.access_token.trim();
      }
    }
  } catch {
    // Fall through
  }
  return undefined;
}

export async function mintGoogleAccessToken(options?: {
  scopes?: string[];
  forceRefresh?: boolean;
}): Promise<{
  token?: string;
  mechanism: GoogleAuthResolution["mechanism"];
  projectId: string;
  adcPath: string;
}> {
  const env = getSovereignEnv();
  const projectId =
    env.get("GOOGLE_CLOUD_PROJECT") ??
    env.get("GCLOUD_PROJECT") ??
    DEFAULT_GCP_PROJECT;
  const { adcPath } = resolveCanonicalAdcPath();

  const scopeKey = (options?.scopes ?? ["cloud-platform"]).sort().join(",");
  const now = Date.now();
  const cached = tokenCache.get(scopeKey);
  if (!options?.forceRefresh && cached && cached.expiresAtMs > now) {
    return {
      token: cached.token,
      mechanism: cached.mechanism,
      projectId,
      adcPath,
    };
  }

  const directEnvToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (directEnvToken && directEnvToken.length > 16) {
    return {
      token: directEnvToken,
      mechanism: "env-token",
      projectId,
      adcPath,
    };
  }

  // 1. Try gcloud CLI (supports service account & custom Workspace scopes)
  try {
    const baseCmd = resolveGcloudCmd();
    const args = [...baseCmd, "auth", "print-access-token"];
    if (options?.scopes && options.scopes.length > 0) {
      args.push(`--scopes=${options.scopes.join(",")}`);
    }
    const proc = Bun.spawnSync(args, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8000,
    });
    if (proc.exitCode === 0) {
      const tok = new TextDecoder().decode(proc.stdout).trim();
      if (tok.length > 20 && !tok.includes(" ")) {
        tokenCache.set(scopeKey, {
          token: tok,
          expiresAtMs: now + 45 * 60_000,
          mechanism: "gcloud-cli",
        });
        return {
          token: tok,
          mechanism: "gcloud-cli",
          projectId,
          adcPath,
        };
      }
    }
  } catch {
    // Fall back to ADC refresh token
  }

  // 2. Keyless ADC authorized_user refresh token exchange
  const adcToken = await mintViaAdcRefreshToken(adcPath);
  if (adcToken) {
    tokenCache.set(scopeKey, {
      token: adcToken,
      expiresAtMs: now + 45 * 60_000,
      mechanism: "adc-refresh-token",
    });
    return {
      token: adcToken,
      mechanism: "adc-refresh-token",
      projectId,
      adcPath,
    };
  }

  return { mechanism: "unavailable", projectId, adcPath };
}

export async function diagnoseGoogleAuth(): Promise<GoogleAuthResolution> {
  const env = getSovereignEnv();
  const projectId =
    env.get("GOOGLE_CLOUD_PROJECT") ??
    env.get("GCLOUD_PROJECT") ??
    DEFAULT_GCP_PROJECT;
  const resolved = resolveCanonicalAdcPath();
  const minted = await mintGoogleAccessToken();

  let account: string | undefined;
  try {
    const proc = Bun.spawnSync(
      [...resolveGcloudCmd(), "config", "get-value", "account", "--quiet"],
      { stdout: "pipe", stderr: "pipe", timeout: 4000 },
    );
    if (proc.exitCode === 0) {
      account = new TextDecoder().decode(proc.stdout).trim() || undefined;
    }
  } catch {
    // Optional
  }

  return {
    ok: Boolean(minted.token),
    projectId,
    adcPath: resolved.adcPath,
    healedBrokenEnvPath: resolved.healed,
    previousBrokenPath: resolved.previousBrokenPath,
    mechanism: minted.mechanism,
    account,
    tokenAvailable: Boolean(minted.token),
  };
}

export function getRedactedKeySummary(): Record<string, string> {
  const env = getSovereignEnv();
  const keys = [
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "CTX7_API_KEY",
    "EXA_API_KEY",
    "FIGMA_ACCESS_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "VERCEL_TOKEN",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k] = maskSecret(k, env.get(k));
  }
  return out;
}

export function writeFileSafeUserspace(
  targetPath: string,
  content: string,
): string {
  const safePath = assertSafeUserspacePath(targetPath);
  const clean = stripEmojis(content);
  mkdirSync(dirname(safePath), { recursive: true });
  writeFileSync(safePath, clean, "utf8");
  return safePath;
}
