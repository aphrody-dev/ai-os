// Shared helpers for aphrody-nhitl hooks: paths, stdin, state, redacted JSONL log.
// Bun only, no dependencies. Every hook must exit 0 fast and never throw.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";

export const HOME = (
  process.env.USERPROFILE ??
  process.env.HOME ??
  "."
).replaceAll("\\", "/");
export const CLAUDE_DIR = `${HOME}/.claude`;
export const LEARN_DIR = `${CLAUDE_DIR}/learning`;
export const STATE_DIR = `${CLAUDE_DIR}/state/nhitl`;
export const LOG = `${LEARN_DIR}/nhitl.jsonl`;

export type HookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: {
    id: string;
    type: string;
    status: string;
    description?: string;
  }[];
  source?: string;
  model?: string;
  notification_type?: string;
  message?: string;
  title?: string;
  [k: string]: unknown;
};

export async function readInput(): Promise<HookInput> {
  try {
    return JSON.parse((await Bun.stdin.text()) || "{}");
  } catch {
    return {};
  }
}

// Strip anything that looks like a credential before it reaches a log line.
export function redact(s: string, n = 160): string {
  return s
    .replace(
      /\b([A-Z0-9_]*(TOKEN|SECRET|KEY|PASS(WORD)?|AUTH|COOKIE)[A-Z0-9_]*)\s*[=:]\s*\S+/gi,
      "$1=<redacted>",
    )
    .replace(
      /(authorization|bearer|x-api-key)\s*[:=]?\s*\S+/gi,
      "$1 <redacted>",
    )
    .replace(/[A-Za-z0-9_\-+/]{32,}={0,2}/g, "<redacted>")
    .replace(/\s+/g, " ")
    .slice(0, n);
}

export function log(rec: Record<string, unknown>): void {
  try {
    mkdirSync(LEARN_DIR, { recursive: true });
    appendFileSync(
      LOG,
      JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n",
    );
  } catch {}
}

const safeId = (sid: string) =>
  sid.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "nosid";

export function readState<T>(name: string, sid: string, dflt: T): T {
  try {
    return JSON.parse(
      readFileSync(`${STATE_DIR}/${name}-${safeId(sid)}.json`, "utf8"),
    );
  } catch {
    return dflt;
  }
}

export function writeState(name: string, sid: string, v: unknown): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      `${STATE_DIR}/${name}-${safeId(sid)}.json`,
      JSON.stringify(v),
    );
  } catch {}
}

export function readGoal(sid: string): string | null {
  try {
    const g = readFileSync(
      `${STATE_DIR}/goal-${safeId(sid)}.txt`,
      "utf8",
    ).trim();
    return g || null;
  } catch {
    return null;
  }
}

// home: the Stop hook reads the goal from the home of the user that runs claude.
export function writeGoal(sid: string, goal: string, home = HOME): string {
  const dir = `${home}/.claude/state/nhitl`;
  mkdirSync(dir, { recursive: true });
  const p = `${dir}/goal-${safeId(sid)}.txt`;
  writeFileSync(p, goal);
  return p;
}

export function clearGoal(sid: string): void {
  try {
    unlinkSync(`${STATE_DIR}/goal-${safeId(sid)}.txt`);
  } catch {}
}

// Synchronous write: process.exit right after an async pipe write can drop the decision.
export function out(obj: unknown): never {
  writeSync(1, JSON.stringify(obj));
  process.exit(0);
}

// Read only the tail of a (possibly huge) transcript.
export async function tailLines(
  path: string | undefined,
  bytes = 2_000_000,
): Promise<string[]> {
  if (!path) return [];
  try {
    const f = Bun.file(path);
    const size = f.size;
    const txt = await f.slice(Math.max(0, size - bytes), size).text();
    const lines = txt.split("\n");
    if (size > bytes) lines.shift();
    return lines;
  } catch {
    return [];
  }
}

// Bun loads .env, .env.local and .env.{development,production,test} from the launch directory
// into process.env unless run with --no-env-file. A checkout's ANTHROPIC_API_KEY would then
// override the child CLI's own claude.ai login. Parse those files (KEY=value, export, quotes,
// comments) to know which entries came from them.
export function dotenvEntries(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of [
    ".env",
    ".env.development",
    ".env.production",
    ".env.test",
    ".env.local",
  ]) {
    let txt = "";
    try {
      txt = readFileSync(`${dir}/${n}`, "utf8");
    } catch {
      continue;
    }
    for (const line of txt.split(/\r?\n/)) {
      const r = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(
        line,
      );
      if (!r) continue;
      let v = r[2]!.trim();
      const q = /^(['"`])([\s\S]*)\1$/.exec(v);
      v = q ? q[2]! : v.replace(/\s+#.*$/, "");
      m.set(r[1]!, v);
    }
  }
  return m;
}

// Environment for a child process without what bun injected from .env files. A key is dropped
// when its value equals the file's value, or when the file value uses ${VAR} expansion (bun
// expands it, so the values cannot be compared). Nothing is dropped under --no-env-file.
export function envWithoutDotenv(
  env: Record<string, string | undefined>,
  dir: string,
  loaded: boolean,
): Record<string, string> {
  const dot = loaded ? dotenvEntries(dir) : new Map<string, string>();
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const d = dot.get(k);
    if (d !== undefined && (d === v || d.includes("$"))) continue;
    e[k] = v;
  }
  return e;
}
