// Stop/SessionEnd hook: local capture of lessons -> ~/.claude/learning/journal.jsonl
// The parent reads stdin, launches a detached worker and exits 0 immediately. No data leaves the machine.
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const DIR = `${HOME}/.claude/learning`;
const RX_FIX =
  /\b(non|faux|pas ça|pas comme ça|arr[eê]te|je t'ai dit|j'ai dit|au lieu|n'utilise pas|ne fais pas|toujours|jamais|wrong|stop|instead|don't)\b/i;
const cut = (s: unknown, n = 160) =>
  String(typeof s === "string" ? s : JSON.stringify(s ?? ""))
    .replace(/\s+/g, " ")
    .slice(0, n);

async function parent() {
  try {
    const raw = await Bun.stdin.text();
    const p = Bun.spawn([process.execPath, import.meta.path, "--work"], {
      env: { ...process.env, LEARN_IN: raw },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    p.unref();
  } catch {}
  process.exit(0);
}

function work() {
  Bun.sleepSync(1500); // the transcript may lag behind the session
  try {
    const inp = JSON.parse(process.env.LEARN_IN || "{}");
    const tp: string = inp.transcript_path;
    if (!tp || !existsSync(tp)) return;
    const seenF = `${DIR}/.seen.json`;
    let seen: Record<string, { n: number; t: number }> = {};
    try {
      seen = JSON.parse(readFileSync(seenF, "utf8"));
    } catch {}
    const lines = readFileSync(tp, "utf8").split("\n");
    const prev = seen[inp.session_id] ?? { n: 0, t: 0 };
    const start = prev.n;
    if (lines.length <= start + 1 && inp.hook_event_name !== "SessionEnd")
      return;
    const tools = new Map<string, { name: string; cmd: string }>();
    const errors: string[] = [],
      fixes: string[] = [],
      recovered: string[] = [];
    const failed = new Map<string, string>();
    let toolCount = prev.t;
    for (let i = start; i < lines.length; i++) {
      let o: any;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const c = o?.message?.content;
      if (
        o.type === "user" &&
        typeof c === "string" &&
        !o.isMeta &&
        RX_FIX.test(c) &&
        c.length < 600
      )
        fixes.push(cut(c, 240));
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (
          b.type === "text" &&
          o.type === "user" &&
          RX_FIX.test(b.text ?? "") &&
          (b.text ?? "").length < 600
        )
          fixes.push(cut(b.text, 240));
        if (b.type === "tool_use") {
          toolCount++;
          tools.set(b.id, {
            name: b.name,
            cmd: cut(b.input?.command ?? b.input?.file_path ?? b.input, 200),
          });
        }
        if (b.type === "tool_result") {
          const t = tools.get(b.tool_use_id);
          if (!t) continue;
          const key = `${t.name}:${t.cmd.split(" ")[0]}`;
          if (b.is_error) {
            errors.push(`${t.name} ${t.cmd} => ${cut(b.content)}`);
            failed.set(key, t.cmd);
          } else if (failed.has(key)) {
            recovered.push(`${failed.get(key)} -> ${t.cmd}`);
            failed.delete(key);
          }
        }
      }
    }
    if (inp.hook_event_name === "SessionEnd") delete seen[inp.session_id];
    else seen[inp.session_id] = { n: lines.length, t: toolCount };
    writeFileSync(seenF, JSON.stringify(seen));
    const rec = {
      ts: new Date().toISOString(),
      event: inp.hook_event_name,
      session: inp.session_id,
      cwd: inp.cwd,
      tools: toolCount,
      errors: errors.slice(-8),
      fixes: fixes.slice(-6),
      recovered: recovered.slice(-6),
    };
    if (
      rec.event === "Stop" &&
      !errors.length &&
      !fixes.length &&
      !recovered.length
    )
      return;
    appendFileSync(`${DIR}/journal.jsonl`, JSON.stringify(rec) + "\n");
  } catch {}
}

if (process.argv.includes("--work")) {
  work();
  process.exit(0);
} else await parent();
