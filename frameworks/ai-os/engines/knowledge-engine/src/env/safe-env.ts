import { existsSync, readFileSync } from "node:fs";
import {
  isSecretKey,
  loadMonorepoEnv,
  maskValue,
  type LoadedMonorepoEnv,
} from "../../../../../../system/env-kit/src/index.ts";

export const DEFAULT_ENV_FILE_PATH =
  process.platform === "win32" ? "C:\\aphrody\\.env" : "/src/.env";

const TOKEN_PREFIX_REDACTION_REGEX =
  /(?:ya29\.[A-Za-z0-9._-]{20,}|1\/\/[A-Za-z0-9._-]{20,}|\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|figd_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|ctx7sk-[A-Za-z0-9_-]{12,}|vcp_[A-Za-z0-9_-]{12,}|napi_[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{10,})\b)/g;

// Extended astral pictographic and miscellaneous symbol emoji detector (zero false-positives on ASCII/box-drawing)
const EMOJI_CODEPOINT_REGEX =
  /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

let cachedEnv: LoadedMonorepoEnv | null = null;
let cachedSecretLiterals: Array<{ key: string; value: string }> | null = null;

export function getKnowledgeEnv(options?: {
  envPath?: string;
  reload?: boolean;
}): LoadedMonorepoEnv {
  if (!cachedEnv || options?.reload || options?.envPath) {
    const loaded = loadMonorepoEnv({
      envPath: options?.envPath ?? DEFAULT_ENV_FILE_PATH,
      service: "knowledge-engine",
      injectProcessEnv: false,
    });
    if (!options?.envPath) {
      cachedEnv = loaded;
      cachedSecretLiterals = null;
    }
    return loaded;
  }
  return cachedEnv;
}

export function getSecretKeyValue(
  key: "CTX7_API_KEY" | "EXA_API_KEY" | "GITHUB_TOKEN",
  envPath?: string,
): string {
  const proc = process.env[key];
  if (proc && proc.trim().length > 0) {
    return proc.trim();
  }
  const env = getKnowledgeEnv(envPath ? { envPath } : undefined);
  return (env.get(key) ?? env.parsed[key] ?? "").trim();
}

/**
 * Returns non-trivial secret values (>= 8 chars) from `.env` in-memory ONLY for leak scanning and redaction.
 * Never print or serialize the returned `value` strings!
 */
export function getSensitiveEnvLiterals(
  envPath = DEFAULT_ENV_FILE_PATH,
): ReadonlyArray<{
  key: string;
  length: number;
  matches(text: string): boolean;
}> {
  let pairs: Array<{ key: string; value: string }>;
  if (envPath === DEFAULT_ENV_FILE_PATH && cachedSecretLiterals) {
    pairs = cachedSecretLiterals;
  } else {
    const env = getKnowledgeEnv({ envPath });
    pairs = [];
    for (const [key, val] of Object.entries(env.parsed)) {
      const trimmed = val.trim();
      if (trimmed.length >= 8 && isSecretKey(key, trimmed)) {
        pairs.push({ key, value: trimmed });
      }
    }
    if (envPath === DEFAULT_ENV_FILE_PATH) {
      cachedSecretLiterals = pairs;
    }
  }

  return pairs.map(({ key, value }) => ({
    key,
    length: value.length,
    matches(text: string): boolean {
      return text.includes(value);
    },
  }));
}

/**
 * Scrubs both known `.env` secret literals AND standard token prefixes (`ctx7sk-`, `ghp_`, `sk-`, etc.)
 * from any string before logging, persisting to SQLite, or writing Markdown reports.
 */
export function redactSecretsFromText(
  input: string,
  envPath = DEFAULT_ENV_FILE_PATH,
): string {
  if (!input) return input;
  let out = input;

  const env = getKnowledgeEnv(
    envPath === DEFAULT_ENV_FILE_PATH ? undefined : { envPath },
  );
  for (const [key, val] of Object.entries(env.parsed)) {
    const trimmed = val.trim();
    if (
      trimmed.length >= 8 &&
      isSecretKey(key, trimmed) &&
      out.includes(trimmed)
    ) {
      out = out.split(trimmed).join(`[REDACTED:${key}:len=${trimmed.length}]`);
    }
  }

  out = out.replace(
    TOKEN_PREFIX_REDACTION_REGEX,
    (match) => `[REDACTED_TOKEN:len=${match.length}]`,
  );
  return out;
}

export interface SecretScanFinding {
  kind: "env_literal" | "token_pattern";
  keyOrPattern: string;
  line: number;
}

export function scanTextForSecretLeaks(
  text: string,
  envPath = DEFAULT_ENV_FILE_PATH,
): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  if (!text) return findings;

  const literals = getSensitiveEnvLiterals(envPath);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    for (const lit of literals) {
      if (lit.matches(lineText)) {
        findings.push({
          kind: "env_literal",
          keyOrPattern: lit.key,
          line: i + 1,
        });
      }
    }
    TOKEN_PREFIX_REDACTION_REGEX.lastIndex = 0;
    let tokenMatch = TOKEN_PREFIX_REDACTION_REGEX.exec(lineText);
    while (tokenMatch !== null) {
      const prefix = tokenMatch[0].slice(0, 6);
      // Ignore obvious placeholders like sk-xxxx or ghp_YOUR_TOKEN
      if (
        !/^(?:sk-ant-xxx|sk-xxx|ghp_xxx|ctx7sk-xxx)/i.test(tokenMatch[0]) &&
        !/SUPERSECRET|PLACEHOLDER|EXAMPLE|YOUR_|REDACTED/i.test(tokenMatch[0])
      ) {
        findings.push({
          kind: "token_pattern",
          keyOrPattern: `${prefix}...`,
          line: i + 1,
        });
      }
      tokenMatch = TOKEN_PREFIX_REDACTION_REGEX.exec(lineText);
    }
  }
  return findings;
}

export interface EmojiScanFinding {
  line: number;
  column: number;
  codePointHex: string;
}

export function scanTextForEmojis(text: string): EmojiScanFinding[] {
  const findings: EmojiScanFinding[] = [];
  if (!text) return findings;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    EMOJI_CODEPOINT_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null = EMOJI_CODEPOINT_REGEX.exec(lineText);
    while (m !== null) {
      const cp = m[0].codePointAt(0) ?? 0;
      // Allow standard mathematical/technical arrows or checkmarks only if outside astral emoji ranges;
      // Note: strict invariant says zero emojis, including U+2705, U+1F680, etc.
      // Exclude box-drawing (U+2500..U+257F) which is not in 2600..27BF anyway.
      findings.push({
        line: i + 1,
        column: m.index + 1,
        codePointHex: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
      });
      m = EMOJI_CODEPOINT_REGEX.exec(lineText);
    }
  }
  return findings;
}

export function stripEmojis(text: string): string {
  return text.replace(EMOJI_CODEPOINT_REGEX, "");
}

export function getMaskedApiReadiness(
  envPath = DEFAULT_ENV_FILE_PATH,
): Record<string, string> {
  const keys = ["CTX7_API_KEY", "EXA_API_KEY", "GITHUB_TOKEN"] as const;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const val = getSecretKeyValue(k, envPath);
    out[k] = maskValue(k, val || undefined);
  }
  return out;
}

export function safeReadText(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
