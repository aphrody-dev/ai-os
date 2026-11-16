// `ai-os brain <absorb|sync|restore>`: one brain for Claude Code and Antigravity (agy).
// absorb: memories, prompt history, session transcripts (~/.claude) and agy conversation summaries are indexed
//   into the ai-os Context store (~/.agent/memory.sqlite); transcripts and caches older than --days are zstd
//   compressed into ~/.agent/brain.sqlite and removed from disk (git-style: the blob store is the history).
// sync: the same directives (global CLAUDE.md + MEMORY.md index) are written into the managed block of agy's
//   ~/.gemini/GEMINI.md, Codex's ~/.codex/AGENTS.md and OpenCode's ~/.config/opencode/AGENTS.md, and both CLIs get the same no-human-in-the-loop settings.
// restore <path>: writes a compressed file back to its original path.
// design: the design corpus of src (docs/design specs, URL indexes, third_party/design-mirror) alone; absorb includes it.
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { Context } from "../core/context";
import { srcRoot } from "../orch/fleet";
import { designEntries } from "./design";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h", default: false },
    home: { type: "string" },
    days: { type: "string", default: "7" },
    "dry-run": { type: "boolean", default: false },
  },
  allowPositionals: true,
});
if (values.help) {
  console.log(
    "Usage: ai-os brain <absorb|sync|restore|design> [--home <dir>] [--days <n>] [--dry-run]",
  );
  process.exit(0);
}
const H = homedir();
const CLAUDE = join(H, ".claude");
const GEMINI = join(H, ".gemini");
const home = values.home ?? Bun.env.AGENT_HOME ?? join(H, ".agent");
const dry = values["dry-run"];
const days = /^\d+(\.\d+)?$/.test(values.days ?? "")
  ? Number(values.days)
  : Number.NaN;
if (!Number.isFinite(days) || days < 0)
  throw new Error(`--days must be a number >= 0, got ${values.days}`);
const cutoff = Date.now() - days * 86_400_000;

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function lines(text: string): any[] {
  const out: any[] = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

const textOf = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p: any) => (p?.type === "text" ? p.text : "")).join("\n")
      : "";

// One entry per Claude session: summaries + user prompts, capped (the raw transcript stays in the blob store).
function sessionDigest(rows: any[]): { title: string; text: string } {
  const sums = rows.filter((r) => r.type === "summary").map((r) => r.summary);
  const asks = rows
    .filter((r) => r.type === "user" && r.message?.role === "user")
    .map((r) => textOf(r.message.content).trim())
    .filter((t) => t && !t.startsWith("<") && t.length < 4000);
  const title = sums[0] ?? asks[0]?.slice(0, 120) ?? "session";
  return {
    title,
    text: [...sums, ...asks.map((a) => `- ${a}`)].join("\n").slice(0, 12_000),
  };
}

async function absorb() {
  const ctx = new Context(join(home, "memory.sqlite"), undefined);
  const blobs = new Database(join(home, "brain.sqlite"));
  blobs.run(
    "CREATE TABLE IF NOT EXISTS blobs(path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, data BLOB)",
  );
  blobs.run("PRAGMA journal_mode=WAL");
  blobs.run("PRAGMA busy_timeout=10000");
  const put = blobs.query(
    "INSERT INTO blobs(path, mtime, size, data) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, data=excluded.data",
  );
  const n = {
    memory: 0,
    history: 0,
    session: 0,
    agy: 0,
    design: 0,
    packed: 0,
    bytes: 0,
  };
  const entries: Parameters<Context["ingest"]>[0] & any[] = [];

  // Memories: every project's memory/*.md, one fact per file.
  for (const p of walk(join(CLAUDE, "projects"))) {
    if (!/[\\/]memory[\\/][^\\/]+\.md$/.test(p) || p.endsWith("MEMORY.md"))
      continue;
    entries.push({
      id: `claude-memory:${relative(CLAUDE, p)}`,
      source: "memory",
      scope: "claude",
      text: await Bun.file(p).text(),
    });
    n.memory++;
  }

  // Design corpus of src (scope "design").
  const design = await designEntries(srcRoot());
  entries.push(...design);
  n.design = design.length;

  // Prompt history, grouped per project.
  const hist = join(CLAUDE, "history.jsonl");
  if (existsSync(hist)) {
    const by = new Map<string, string[]>();
    for (const r of lines(await Bun.file(hist).text())) {
      const k = r.project ?? "global";
      by.set(k, [...(by.get(k) ?? []), r.display ?? ""]);
    }
    for (const [k, v] of by) {
      entries.push({
        id: `claude-history:${k}`,
        source: "history",
        scope: "claude",
        title: k,
        text: v.join("\n").slice(-20_000),
      });
      n.history++;
    }
  }

  // Session transcripts: digest into Context, pack old ones.
  for (const p of walk(join(CLAUDE, "projects"))) {
    if (!p.endsWith(".jsonl")) continue;
    const st = statSync(p);
    const raw = await Bun.file(p).text();
    const d = sessionDigest(lines(raw));
    entries.push({
      id: `claude-session:${relative(CLAUDE, p)}`,
      source: "session",
      scope: "claude",
      title: d.title,
      text: d.text,
    });
    n.session++;
  }

  // Antigravity conversation summaries + full-text chunks.
  for (const agyDb of ["antigravity", "antigravity-cli"].map((d) =>
    join(GEMINI, d, "conversation_summaries.db"),
  )) {
    if (!existsSync(agyDb)) continue;
    const a = new Database(agyDb, { readonly: true });
    const rows = a
      .query(
        "SELECT s.conversation_id id, s.title, s.preview, s.workspace_uris ws, group_concat(f.user_body, char(10)) body FROM conversation_summaries s LEFT JOIN conversations_fts f ON f.conversation_id = s.conversation_id GROUP BY s.conversation_id",
      )
      .all() as any[];
    for (const r of rows) {
      entries.push({
        id: `agy-session:${r.id}`,
        source: "session",
        scope: "agy",
        title: r.title || r.ws,
        text: [r.title, r.preview, r.body]
          .filter(Boolean)
          .join("\n")
          .slice(0, 12_000),
      });
      n.agy++;
    }
    a.close();
  }

  if (!dry) await ctx.ingest(entries);

  // Compress cold files: transcripts, file-history, paste-cache, backups, shell snapshots.
  const cold = [
    "projects",
    "file-history",
    "paste-cache",
    "backups",
    "shell-snapshots",
  ];
  const roots = [
    ...cold.map((d) => join(CLAUDE, d)),
    join(GEMINI, "antigravity-cli", "brain"),
    join(GEMINI, "antigravity-cli", "conversations"),
  ];
  for (const root of roots)
    for (const p of walk(root)) {
      if (/[\\/]memory[\\/]/.test(p)) continue;
      const st = statSync(p);
      if (st.mtimeMs > cutoff) continue;
      n.packed++;
      n.bytes += st.size;
      if (dry) continue;
      const raw = await Bun.file(p).bytes();
      const data = Bun.zstdCompressSync(raw, { level: 19 });
      // Delete only after the committed blob decompresses to the same bytes.
      blobs.transaction(() =>
        put.run(relative(H, p), Math.round(st.mtimeMs), st.size, data),
      )();
      const back = blobs
        .query("SELECT data FROM blobs WHERE path = ?")
        .get(relative(H, p)) as { data: Uint8Array };
      if (Buffer.compare(Bun.zstdDecompressSync(back.data), raw) !== 0)
        throw new Error(`verify failed: ${p}`);
      const now = statSync(p);
      if (now.mtimeMs !== st.mtimeMs || now.size !== st.size) continue; // changed while packing: keep it
      try {
        rmSync(p);
      } catch (e) {
        console.error(`kept (locked): ${p}: ${(e as Error).message}`);
      }
    }
  if (!dry && n.packed) blobs.run("VACUUM");
  blobs.close();
  ctx.close();
  console.log(
    `${dry ? "dry-run " : ""}absorbed memory=${n.memory} history=${n.history} sessions=${n.session} agy=${n.agy} design=${n.design}; packed ${n.packed} files (${(n.bytes / 1e6).toFixed(1)} MB) older than ${values.days} d into ${join(home, "brain.sqlite")}`,
  );
}

const BEGIN = "<!-- ai-os brain sync: begin -->";
const END = "<!-- ai-os brain sync: end -->";

async function readJson(p: string): Promise<any> {
  const f = Bun.file(p);
  return (await f.exists()) ? f.json() : {};
}

async function sync() {
  const global = await Bun.file(join(CLAUDE, "CLAUDE.md")).text();
  const idx = join(CLAUDE, "projects", "C--aphrody", "memory", "MEMORY.md");
  const mem = existsSync(idx) ? await Bun.file(idx).text() : "";
  const block = `${BEGIN}\n# Shared directives (from ~/.claude/CLAUDE.md, synced by ai-os brain)\n\n${global.trim()}\n\n## Memory index (~/.claude/projects/C--aphrody/memory)\n\n${mem.trim()}\n${END}`;
  // One managed block per agent prompt file: agy, Codex, OpenCode, Pi. Text outside the block is the agent-specific
  // header, written only when the file is absent or empty.
  const ROOT = resolve(import.meta.dir, "../../../..");
  const head = (name: string) =>
    `# ${name}\n\nShared contract for all agents: ${join(ROOT, "AGENTS.md")} + ${join(ROOT, ".agents", "SOUL.md")}. The block below is generated by \`ai-os brain sync\` from ~/.claude; do not edit it by hand. MCP: \`relay\` server only (tools/agents/toolchain.toml).`;
  // agy state dir exists before the filter below, so a first run on a fresh host writes GEMINI.md too.
  if (!dry && Bun.which("agy"))
    mkdirSync(join(GEMINI, "antigravity-cli"), { recursive: true });
  const prompts = [
    { path: join(GEMINI, "GEMINI.md"), name: "agy (Antigravity CLI)" },
    { path: join(H, ".codex", "AGENTS.md"), name: "Codex" },
    { path: join(H, ".config", "opencode", "AGENTS.md"), name: "OpenCode" },
    { path: join(H, ".pi", "agent", "AGENTS.md"), name: "Pi" },
  ].filter((p) => existsSync(dirname(p.path)));
  const outputs: [string, string][] = [];
  for (const p of prompts) {
    const cur = existsSync(p.path) ? await Bun.file(p.path).text() : "";
    const b = cur.indexOf(BEGIN);
    const e = cur.indexOf(END, b);
    outputs.push([
      p.path,
      b >= 0 && e > b
        ? cur.slice(0, b) + block + cur.slice(e + END.length)
        : // No managed block yet: an existing hand-written file is kept and the block appended.
          `${cur.trim() ? cur.trimEnd() : head(p.name)}\n\n${block}\n`,
    ]);
  }

  // Same NHITL posture on both sides: Claude bypassPermissions, agy auto-approve.
  const cs = join(CLAUDE, "settings.json");
  const c = await readJson(cs);
  c.permissions = { ...c.permissions, defaultMode: "bypassPermissions" };
  c.skipDangerousModePermissionPrompt = true;
  // agy reads ~/.gemini/antigravity-cli/settings.json: toolPermission is its approval switch.
  const gs = join(GEMINI, "antigravity-cli", "settings.json");
  const g = await readJson(gs);
  g.toolPermission = "always-proceed";
  g.artifactReviewPolicy = "always-proceed";
  g.allowNonWorkspaceAccess = true;
  g.trustedWorkspaces = [
    ...new Set([
      ...(g.trustedWorkspaces ?? []),
      resolve(import.meta.dir, "../../../.."),
    ]),
  ].filter((w: string) => w.length > 3 && existsSync(w));

  const names = outputs.map(([p]) => p).join(", ");
  if (dry) return console.log(`dry-run: would write ${names}, ${cs}, ${gs}`);
  for (const [p, text] of outputs) await Bun.write(p, text);
  await Bun.write(cs, `${JSON.stringify(c, null, 2)}\n`);
  await Bun.write(gs, `${JSON.stringify(g, null, 2)}\n`);
  console.log(`synced ${names}, ${cs}, ${gs}`);
}

async function restore(path: string) {
  const db = new Database(join(home, "brain.sqlite"), { readonly: true });
  const rows = db
    .query(
      "SELECT path, mtime, data FROM blobs WHERE path = ? OR path LIKE ? ESCAPE '!'",
    )
    .all(path, `${path.replace(/[!%_]/g, (m) => `!${m}`)}${sep}%`) as {
    path: string;
    mtime: number;
    data: Uint8Array;
  }[];
  for (const r of rows) {
    const out = resolve(H, r.path);
    if (existsSync(out)) {
      console.error(`exists, skipped: ${r.path}`);
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Bun.zstdDecompressSync(r.data), { flag: "wx" });
    utimesSync(out, r.mtime / 1000, r.mtime / 1000);
    console.log(`restored ${r.path}`);
  }
  if (!rows.length) process.exitCode = 1;
}

async function design() {
  mkdirSync(home, { recursive: true });
  const ctx = new Context(join(home, "memory.sqlite"), undefined);
  const entries = await designEntries(srcRoot());
  const ids = new Set(entries.map((e) => e.id));
  if (!dry) {
    await ctx.ingest(entries);
    for (const e of ctx.list({ scopes: ["design"] }, 100_000))
      if (!ids.has(e.id)) ctx.remove(e.id);
  }
  ctx.close();
  console.log(
    `${dry ? "dry-run " : ""}design corpus: ${entries.length} entries (scope design) in ${join(home, "memory.sqlite")}`,
  );
}

const cmd = positionals[0];
if (cmd === "absorb") await absorb();
else if (cmd === "design") await design();
else if (cmd === "sync") await sync();
else if (cmd === "restore" && positionals[1]) await restore(positionals[1]);
else {
  console.error(
    "usage: ai-os brain <absorb|sync|design|restore <path>> [--days 7] [--dry-run] [--home ~/.agent]",
  );
  process.exitCode = 2;
}
