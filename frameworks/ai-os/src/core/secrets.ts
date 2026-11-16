// Single secret redactor. Replaces the three legacy copies:
// ai-triad/src/discovery.ts, ai-os/src/nexus/security.ts + env.ts, knowledge-engine/src/env/safe-env.ts.

const SECRET_KEY_RE =
  /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|DATABASE_URL|ADMIN_KEY|SESSION_KEY|REFRESH_TOKEN|ACCESS_TOKEN|ID_TOKEN)/i;
const TOKEN_RE =
  /\b(sk-[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|figd_[A-Za-z0-9_-]{10,}|vcp_[A-Za-z0-9_-]{10,}|ctx7sk-[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9_.-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;
const BEARER_RE = /(Bearer\s+)([A-Za-z0-9_.-]{12,})/gi;

export function isSecretKey(key: string, value = ""): boolean {
  TOKEN_RE.lastIndex = 0;
  return SECRET_KEY_RE.test(key) || TOKEN_RE.test(value);
}

export function redactSecret(value: string | undefined | null): string {
  return value ? `SET [redacted, len=${value.length}]` : "UNSET";
}

/** Redacts known env secret literals (if `env` given) and token-shaped strings. */
export function redactText(
  text: string,
  env: Record<string, string | undefined> = {},
): string {
  if (!text) return text;
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    const val = v?.trim();
    if (val && val.length >= 8 && isSecretKey(k, val) && out.includes(val)) {
      out = out.split(val).join(`[REDACTED:${k}:len=${val.length}]`);
    }
  }
  return out
    .replace(TOKEN_RE, (m) => `[REDACTED:len=${m.length}]`)
    .replace(
      BEARER_RE,
      (_f, p: string, t: string) => `${p}[REDACTED:len=${t.length}]`,
    );
}

export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, "");
    out[key] = val;
  }
  return out;
}
