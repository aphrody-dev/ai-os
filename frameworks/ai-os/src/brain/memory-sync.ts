// `bun frameworks/ai-os/src/brain/memory-sync.ts [--home <dir>] [--dry-run]`: two-way memory sync Claude <-> ai-os store
// (the store Gemini reaches through the MCP tools memory_search / memory_add).
//  push: each Claude memory file (~/.claude/projects/C--aphrody/memory/*.md) is upserted as entry `claude-mem:<file>`,
//        scope "claude", so memory_search finds it; the Claude file is the source of truth and always wins.
//  pull: entries with scope "gemini" or "gemini:*" (written by Gemini via memory_add) are appended, never edited in place,
//        to memory/gemini-inbox.md as `- <iso> [source=gemini id=<id> scope=<scope>] <text>`; a state file records
//        exported ids, so a re-run adds nothing. MEMORY.md gets one pointer line the first time.
// Conflict rules: append-only, timestamped, source recorded; a Gemini entry never overwrites a Claude file, and
// the push never touches scope "gemini". Entries that look like secrets are skipped on pull.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Memory } from "../core/memory";

const SECRET =
  /(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_\w{40,}|sk-[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const INBOX = "gemini-inbox.md";

export async function memorySync(
  o: { home?: string; memDir?: string; dry?: boolean } = {},
) {
  const home = o.home ?? Bun.env.AGENT_HOME ?? join(homedir(), ".agent");
  const memDir =
    o.memDir ?? join(homedir(), ".claude", "projects", "C--aphrody", "memory");
  const m = new Memory(join(home, "memory.sqlite"));
  const state = join(home, "memory-sync.json");
  const done = new Set<string>(
    existsSync(state)
      ? (JSON.parse(readFileSync(state, "utf8")).exported ?? [])
      : [],
  );
  let pushed = 0;
  let pulled = 0;
  try {
    if (existsSync(memDir))
      for (const f of readdirSync(memDir).filter(
        (x) => x.endsWith(".md") && x !== INBOX,
      )) {
        const text = readFileSync(join(memDir, f), "utf8");
        const prev = m.ctx.get(`claude-mem:${f}`);
        if (prev?.text === text) continue;
        pushed++;
        if (!o.dry)
          await m.ctx.ingest({
            id: `claude-mem:${f}`,
            source: "memory",
            scope: "claude",
            title: f.replace(/\.md$/, ""),
            text,
          });
      }
    const fresh = m.ctx
      .list({ sources: ["memory"] }, 5000)
      .filter((e) => /^gemini(:|$)/.test(e.scope) && !done.has(e.id))
      .sort((a, b) => a.at - b.at);
    const lines: string[] = [];
    for (const e of fresh) {
      done.add(e.id);
      if (SECRET.test(e.text)) continue;
      lines.push(
        `- ${new Date(e.at).toISOString()} [source=gemini id=${e.id} scope=${e.scope}] ${e.text.replace(/\s*\n\s*/g, " ").trim()}`,
      );
      pulled++;
    }
    if (!o.dry && (lines.length || done.size)) {
      mkdirSync(memDir, { recursive: true });
      const inbox = join(memDir, INBOX);
      if (!existsSync(inbox))
        writeFileSync(
          inbox,
          "---\nname: gemini-inbox\ndescription: Facts written by Gemini through memory_add (append-only, timestamped, source recorded); review before promoting to a typed memory\nmetadata:\n  type: reference\n---\n\n",
        );
      if (lines.length) appendFileSync(inbox, `${lines.join("\n")}\n`);
      const idx = join(memDir, "MEMORY.md");
      const cur = existsSync(idx) ? readFileSync(idx, "utf8") : "";
      if (!cur.includes(`(${INBOX})`))
        appendFileSync(
          idx,
          `${cur.endsWith("\n") || !cur ? "" : "\n"}- [Gemini inbox](${INBOX}) — append-only facts written by Gemini via memory_add (source recorded)\n`,
        );
      mkdirSync(dirname(state), { recursive: true });
      writeFileSync(state, JSON.stringify({ exported: [...done] }));
    }
  } finally {
    m.close();
  }
  return { pushed, pulled };
}

if (import.meta.main) {
  const a = Bun.argv.slice(2);
  const r = await memorySync({
    home: a.includes("--home") ? a[a.indexOf("--home") + 1] : undefined,
    dry: a.includes("--dry-run"),
  });
  console.log(
    `memory-sync: pushed ${r.pushed} claude files, pulled ${r.pulled} gemini entries`,
  );
}
