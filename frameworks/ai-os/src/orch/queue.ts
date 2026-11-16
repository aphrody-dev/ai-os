// Agent queue of tools/agents/runner.ts (execution layer of labs-1b, doc docs/agents/AGENT-FIRST.md), v1 format
// produced and read as is: <host src>/var/agents/queue/{tmp,new,claimed,done,failed}/<id>.json,
// results results/<id>/result.json, state state/{health.json,heartbeat-<role>,cooldown-<provider>}.
// Atomic drop: write into tmp/ then rename into new/. Remote: one ssh session per operation.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { exec, type Host, shq } from "./fleet";

export type Attempt = {
  provider: string;
  exit: number;
  reason: "ok" | "agent_error" | "provider_unavailable" | "check_failed";
  started: string;
  ended: string;
  check_exit?: number;
};

export type QueueTask = {
  v: 1;
  id: string;
  prompt: string;
  role:
    | "coder"
    | "reviewer"
    | "tester"
    | "linter"
    | "designer"
    | "deployer"
    | "sre"
    | "growth";
  host: string;
  providers?: string[];
  cwd?: string;
  check?: string;
  commit?: { paths: string[]; message: string };
  approval?: "none" | "owner";
  timeout_s?: number;
  budget_usd?: number;
  max_attempts?: number;
  attempts?: Attempt[];
  created_by?: string;
  created_at?: string;
};

export type QueueResult = {
  id: string;
  status: "done" | "failed";
  host: string;
  provider?: string;
  attempts: Attempt[];
  commit?: { sha?: string; files: string[]; error?: string };
  results?: string;
};

const home = (h: Host) =>
  h.local && Bun.env.AGENTS_HOME ? Bun.env.AGENTS_HOME : `${h.src}/var/agents`;

export async function enqueue(h: Host, t: QueueTask): Promise<void> {
  const body = JSON.stringify(t, null, 2);
  const base = home(h);
  if (h.local) {
    for (const d of ["tmp", "new"])
      mkdirSync(join(base, "queue", d), { recursive: true });
    const tmp = join(base, "queue", "tmp", `${t.id}.json`);
    writeFileSync(tmp, body);
    renameSync(tmp, join(base, "queue", "new", `${t.id}.json`));
    return;
  }
  const q = `${base}/queue`;
  const r = await exec(
    h,
    [
      `mkdir -p ${shq(`${q}/tmp`)} ${shq(`${q}/new`)} && cat > ${shq(`${q}/tmp/${t.id}.json`)} && mv ${shq(`${q}/tmp/${t.id}.json`)} ${shq(`${q}/new/${t.id}.json`)}`,
    ],
    { raw: true, stdin: body, timeoutMs: 30_000 },
  );
  if (r.code) throw new Error(`enqueue ${h.id} : ${r.err.trim()}`);
}

/** Final result (done/failed) or null while the task is queued, claimed or requeued. */
export async function poll(h: Host, id: string): Promise<QueueResult | null> {
  const base = home(h);
  const f = `${base}/results/${id}/result.json`;
  // A task requeued in new/ after unavailable providers keeps an intermediate result.json: only
  // done/ ou failed/ est final.
  // Final without result.json (runner interrupted, withdrawn): synthesized failure rather than waiting until the timeout.
  const settle = (state: string, text: string): QueueResult | null => {
    if (!state) return null;
    try {
      return JSON.parse(text);
    } catch {
      return state === "failed"
        ? { id, status: "failed", host: h.id, attempts: [] }
        : null;
    }
  };
  if (h.local) {
    const state =
      ["done", "failed"].find((d) =>
        existsSync(join(base, "queue", d, `${id}.json`)),
      ) ?? "";
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {}
    return settle(state, text);
  }
  const r = await exec(
    h,
    [
      `if [ -f ${shq(`${base}/queue/done/${id}.json`)} ]; then echo done; elif [ -f ${shq(`${base}/queue/failed/${id}.json`)} ]; then echo failed; else exit 0; fi; cat ${shq(f)} 2>/dev/null`,
    ],
    { raw: true, timeoutMs: 30_000 },
  );
  const nl = r.out.indexOf("\n");
  return nl < 0
    ? settle(r.out.trim(), "")
    : settle(r.out.slice(0, nl).trim(), r.out.slice(nl + 1));
}

/** Attempts already made on a task still in the queue (requeued in new/ or claimed). */
export async function pendingAttempts(h: Host, id: string): Promise<Attempt[]> {
  const base = home(h);
  const read = (t: string) => {
    try {
      return (JSON.parse(t).attempts ?? []) as Attempt[];
    } catch {
      return [];
    }
  };
  if (h.local) {
    const f = join(base, "queue", "new", `${id}.json`);
    return existsSync(f) ? read(readFileSync(f, "utf8")) : [];
  }
  const r = await exec(
    h,
    [`cat ${shq(`${base}/queue/new/${id}.json`)} 2>/dev/null`],
    {
      raw: true,
      timeoutMs: 30_000,
    },
  );
  return read(r.out);
}

/** Withdraws a task still in new/ (re-routing to another host). */
export async function withdraw(h: Host, id: string): Promise<boolean> {
  const base = home(h);
  const src = `${base}/queue/new/${id}.json`;
  const dst = `${base}/queue/failed/${id}.json`;
  if (h.local) {
    mkdirSync(join(base, "queue", "failed"), { recursive: true });
    try {
      renameSync(src, dst); // a worker may have claimed it in the meantime: nothing to withdraw
      return true;
    } catch {
      return false;
    }
  }
  const r = await exec(
    h,
    [`mkdir -p ${shq(`${base}/queue/failed`)} && mv ${shq(src)} ${shq(dst)}`],
    {
      raw: true,
      timeoutMs: 30_000,
    },
  );
  return r.code === 0;
}

export type RunnerState = {
  alive: boolean; // a worker of the role beat less than 2 min ago
  roles: string[]; // live roles
  clis: Record<string, string>; // CLI probe (state/health.json)
  cooling: string[]; // fournisseurs en refroidissement (state/cooldown-*, 15 min)
};

const FRESH_MS = 120_000;
const COOL_MS = 15 * 60_000;

/** Runner state of a host, read from state/ (one ssh session). */
export async function runnerState(h: Host): Promise<RunnerState> {
  const base = home(h);
  let files: { name: string; age: number; body?: string }[] = [];
  if (h.local) {
    const d = join(base, "state");
    if (existsSync(d))
      for (const name of readdirSync(d))
        try {
          const st = statSync(join(d, name));
          if (!st.isFile()) continue;
          files.push({
            name,
            age: Math.max(0, Date.now() - st.mtimeMs),
            body:
              name === "health.json"
                ? readFileSync(join(d, name), "utf8")
                : undefined,
          });
        } catch {} // file replaced during the read (atomic write by the runner)
  } else {
    const r = await exec(
      h,
      [
        `cd ${shq(`${base}/state`)} 2>/dev/null || exit 0; now=$(date +%s); for f in *; do [ -f "$f" ] && echo "F $(( now - $(stat -c %Y "$f") )) $f"; done; echo; cat health.json 2>/dev/null`,
      ],
      { raw: true, timeoutMs: 30_000 },
    );
    const [list, ...rest] = r.out.split("\n\n");
    files = (list ?? "")
      .split("\n")
      .map((l) => l.match(/^F (-?\d+) (.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ name: m[2]!, age: Math.max(0, Number(m[1])) * 1000 }));
    const hj = files.find((f) => f.name === "health.json");
    if (hj) hj.body = rest.join("\n\n");
  }
  const roles = files
    .filter((f) => f.name.startsWith("heartbeat-") && f.age < FRESH_MS)
    .map((f) => f.name.slice("heartbeat-".length));
  let clis: Record<string, string> = {};
  try {
    clis =
      JSON.parse(files.find((f) => f.name === "health.json")?.body ?? "{}")
        .clis ?? {};
  } catch {}
  return {
    alive: roles.length > 0,
    roles,
    clis,
    cooling: files
      .filter((f) => f.name.startsWith("cooldown-") && f.age < COOL_MS)
      .map((f) => f.name.slice("cooldown-".length)),
  };
}

/** Agent output for the accepted attempt (results/<id>/<n>-<provider>.log), truncated. */
export async function output(
  h: Host,
  r: QueueResult,
  max = 20_000,
): Promise<string> {
  const n = r.attempts.findLastIndex((a) => a.reason === "ok");
  if (n < 0) return "";
  const p = r.attempts[n]!.provider.replace(/[^\w.-]/g, "_");
  const f = `${home(h)}/results/${r.id}/${n}-${p}.log`;
  const text = h.local
    ? existsSync(f)
      ? readFileSync(f, "utf8")
      : ""
    : (
        await exec(h, [`cat ${shq(f)} 2>/dev/null`], {
          raw: true,
          timeoutMs: 30_000,
        })
      ).out;
  return extractText(text).slice(-max);
}

/** Response text in a CLI's raw log: single JSON (claude `result`, agy `response`) or JSONL stream
 * (opencode `part.text`, codex `item.text` of agent messages); plain text otherwise. stderr removed. */
export function extractText(log: string): string {
  const body = log.split("\n[stderr]\n")[0]!.trim();
  const pick = (j: any): string | undefined => {
    const v =
      j?.result ??
      j?.response ??
      j?.part?.text ??
      (j?.item?.type === "agent_message" ? j.item.text : undefined) ??
      (j?.type === "text" ? j.text : undefined);
    return typeof v === "string" ? v : undefined;
  };
  try {
    const one = pick(JSON.parse(body));
    if (one !== undefined) return one.trim();
  } catch {}
  const parts: string[] = [];
  let parsed = 0;
  for (const line of body.split("\n")) {
    try {
      const j = JSON.parse(line);
      parsed++;
      const t = pick(j);
      if (t) parts.push(t);
    } catch {}
  }
  return parsed && parts.length ? parts.join("").trim() : body;
}
