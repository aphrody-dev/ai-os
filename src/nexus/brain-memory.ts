import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  redactSecretsFromText,
  stripEmojis,
  writeFileSafeUserspace,
} from "./security.ts";

export const DEFAULT_NEXUS_DB_PATH =
  process.platform === "win32"
    ? "C:\\src\\var\\nexus.sqlite"
    : "/src/var/nexus.sqlite";

export const DEFAULT_BRAIN_VAULT_DIR =
  process.platform === "win32" ? "C:\\src\\var\\brain" : "/src/var/brain";

export interface MemoryRecord {
  id: string;
  namespace: string;
  title: string;
  content: string;
  tags: string[];
  sourcePath?: string;
  updatedAt: string;
}

export interface UnifiedSessionSummary {
  sessionId: string;
  harness: "agy-cli" | "agy-app" | "claude" | "codex" | "pi-minimal";
  title: string;
  workspace: string;
  stepCount: number;
  errorCount: number;
  updatedAt: string;
  transcriptPath: string;
}

let singletonDb: Database | null = null;
let singletonDbPath = "";

export function openNexusDb(dbPath = DEFAULT_NEXUS_DB_PATH): Database {
  const resolved = resolve(dbPath);
  if (singletonDb && singletonDbPath === resolved) {
    return singletonDb;
  }
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved, { create: true });
  db.run(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_path TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      namespace,
      title,
      content,
      tags_json
    );

    CREATE TABLE IF NOT EXISTS unified_sessions (
      session_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      title TEXT NOT NULL,
      workspace TEXT NOT NULL,
      step_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      summary_snippet TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      transcript_path TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED,
      harness,
      title,
      workspace,
      summary_snippet
    );

    CREATE TABLE IF NOT EXISTS active_collections (
      collection_id TEXT PRIMARY KEY,
      installed_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS global_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const nowIso = new Date().toISOString();
  for (const cid of [
    "os-minimal",
    "pro-max-fullstack",
    "google-labs",
    "gemini-multimodal",
    "google-cloud",
  ]) {
    db.query(
      `INSERT OR IGNORE INTO active_collections (collection_id, installed_at, enabled) VALUES (?1, ?2, 1)`,
    ).run(cid, nowIso);
  }
  db.query(
    `INSERT OR IGNORE INTO global_settings (key, value, updated_at) VALUES ('default_mode', 'full-design', ?1)`,
  ).run(nowIso);

  if (resolved === resolve(DEFAULT_NEXUS_DB_PATH)) {
    singletonDb = db;
    singletonDbPath = resolved;
  }
  return db;
}

export function buildCanonicalSoulMarkdown(): string {
  return `# Sovereign AI-OS Canonical Soul (SOUL.md)

## 1. Identity & Single AI Ownership
- **Sole AI Owner**: \`C:/src/packages/ai-os\` (\`@aphrody/ai-os\`) owns 100% of AI routing, MCP tools, Soul, Brain, Memory, Sessions, Skills, and Cross-AI Triad federation across \`C:\\src\`.
- **Google Ecosystem Surface**: \`C:/src/packages/agy\` (\`@aphrody/agy\`) + \`agy-desktop.exe\` exposes keyless Google 5-Org Depot/Gitingest sync, Gemma 4 training/inference, DeepMind Research Notebooks, Open NotebookLM, Google AI Ultra FinOps rentabilisation, and dual operating modes (\`minimal\` Pi-Sudo vs \`fullstack\` Pro-Max).

## 2. Non-Negotiable Engineering Directives
- **Sacred Host Userspace**: \`C:\\Windows\\System32\` and host OS directories are strictly untouchable. Userland binaries live in \`C:\\Users\\aphro\\.local\\bin\`.
- **Bun v1.4.4 Full-Rust + Rust 2024 Fat-LTO**: Zero unnecessary npm dependencies. Validate every change via \`bun fmt\`, \`bun check\`, and \`bun test\`.
- **Keyless & Local-First Security**: Never print, log, or commit raw secrets from \`C:\\src\\.env\`. Prefer local Gemma 4 / Ring-3 CUDA \`sm_89\` and keyless Google ADC / \`gcloud\` OAuth2 tokens.
- **Zero Emojis**: Strictly zero emojis in code, Markdown, skills, UI text, and commit messages.

## 3. Unified Context-Optimized MCP & Progressive Skills
- Single MCP endpoint: \`C:/Users/aphro/.local/bin/ai-os.exe mcp-stdio\`.
- Default tool baseline: Minimal OS & Computer-Use tools (\`read\`, \`write\`, \`edit\`, \`bash\`, \`desktop_snapshot\`, \`desktop_action\`), with one-click collections for Google Cloud, Workspace (\`gws\`), Android, Gemini, Google Labs (Stitch/Jules/DESIGN.md), DeepMind Science, and Fullstack Pro-Max.
`;
}

export function syncSoulFiles(options?: {
  home?: string;
  srcRoot?: string;
}): string[] {
  const home = options?.home ?? homedir();
  const srcRoot =
    options?.srcRoot ?? (process.platform === "win32" ? "C:\\src" : "/src");
  const soulMd = buildCanonicalSoulMarkdown();
  const targets = [
    join(srcRoot, ".agents", "SOUL.md"),
    join(home, ".agents", "SOUL.md"),
    join(DEFAULT_BRAIN_VAULT_DIR, "01 Canonical Soul.md"),
  ];
  for (const t of targets) {
    writeFileSafeUserspace(t, soulMd);
  }
  return targets;
}

export function rememberEntry(
  input: {
    id?: string;
    namespace?: string;
    title: string;
    content: string;
    tags?: string[];
    sourcePath?: string;
  },
  dbPath = DEFAULT_NEXUS_DB_PATH,
): MemoryRecord {
  const db = openNexusDb(dbPath);
  const id =
    input.id ??
    `mem_${Bun.CryptoHasher.hash("sha256", `${input.namespace ?? "global"}:${input.title}`, "hex").slice(0, 16)}`;
  const namespace = stripEmojis(input.namespace ?? "global");
  const title = stripEmojis(redactSecretsFromText(input.title)).slice(0, 240);
  const content = stripEmojis(redactSecretsFromText(input.content));
  const tags = (input.tags ?? []).map((t) => stripEmojis(t));
  const tagsJson = JSON.stringify(tags);
  const updatedAt = new Date().toISOString();

  db.query(
    `INSERT OR REPLACE INTO memories (id, namespace, title, content, tags_json, source_path, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    id,
    namespace,
    title,
    content,
    tagsJson,
    input.sourcePath ?? null,
    updatedAt,
  );

  db.query(`DELETE FROM memories_fts WHERE id = ?1`).run(id);
  db.query(
    `INSERT INTO memories_fts (id, namespace, title, content, tags_json) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).run(id, namespace, title, content, tagsJson);

  return {
    id,
    namespace,
    title,
    content,
    tags,
    sourcePath: input.sourcePath,
    updatedAt,
  };
}

export function recallMemories(
  query: string,
  options?: { namespace?: string; limit?: number; dbPath?: string },
): MemoryRecord[] {
  const db = openNexusDb(options?.dbPath);
  const limit = Math.max(1, Math.min(100, options?.limit ?? 15));
  const cleaned = query
    .replace(/[^A-Za-z0-9_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok}"*`)
    .join(" OR ");

  let rows: Array<{
    id: string;
    namespace: string;
    title: string;
    content: string;
    tags_json: string;
    source_path: string | null;
    updated_at: string;
  }> = [];

  if (!cleaned) {
    rows = (
      options?.namespace
        ? db
            .query(
              `SELECT * FROM memories WHERE namespace = ?1 ORDER BY updated_at DESC LIMIT ?2`,
            )
            .all(options.namespace, limit)
        : db
            .query(`SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?1`)
            .all(limit)
    ) as typeof rows;
  } else {
    rows = (
      options?.namespace
        ? db
            .query(
              `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id
               WHERE memories_fts MATCH ?1 AND m.namespace = ?2
               ORDER BY rank LIMIT ?3`,
            )
            .all(cleaned, options.namespace, limit)
        : db
            .query(
              `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id
               WHERE memories_fts MATCH ?1
               ORDER BY rank LIMIT ?2`,
            )
            .all(cleaned, limit)
    ) as typeof rows;
  }

  return rows.map((r) => ({
    id: r.id,
    namespace: r.namespace,
    title: r.title,
    content: r.content,
    tags: JSON.parse(r.tags_json || "[]") as string[],
    sourcePath: r.source_path ?? undefined,
    updatedAt: r.updated_at,
  }));
}

function importMarkdownDirectory(
  dirPath: string,
  namespace: string,
  dbPath: string,
  maxFiles = 80,
): number {
  if (!existsSync(dirPath)) return 0;
  let count = 0;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (count >= maxFiles) break;
      const full = join(dirPath, entry.name);
      if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
        const st = statSync(full);
        if (st.size > 256_000) continue;
        const body = readFileSync(full, "utf8");
        rememberEntry(
          {
            namespace,
            title: entry.name.replace(/\.(md|txt)$/i, ""),
            content: body.slice(0, 16_000),
            tags: [namespace, "imported"],
            sourcePath: full.replace(/\\/g, "/"),
          },
          dbPath,
        );
        count++;
      }
    }
  } catch {
    // Ignore unreadable directories
  }
  return count;
}

export function syncBrainMemoriesAndSessions(options?: {
  home?: string;
  dbPath?: string;
  vaultDir?: string;
}): {
  importedMemories: number;
  indexedSessions: number;
  brainIndexPath: string;
  soulPaths: string[];
} {
  const home = options?.home ?? homedir();
  const dbPath = options?.dbPath ?? DEFAULT_NEXUS_DB_PATH;
  const vaultDir = options?.vaultDir ?? DEFAULT_BRAIN_VAULT_DIR;
  const db = openNexusDb(dbPath);

  const soulPaths = syncSoulFiles({ home });

  let importedMemories = 0;
  importedMemories += importMarkdownDirectory(
    join(home, ".serena", "memories"),
    "serena",
    dbPath,
  );
  importedMemories += importMarkdownDirectory(
    join(home, "agent-workspace", "default"),
    "agent-workspace",
    dbPath,
  );
  importedMemories += importMarkdownDirectory(vaultDir, "brain-vault", dbPath);

  // Import Claude project memories (~/.claude/projects/*/memory)
  const claudeProjectsRoot = join(home, ".claude", "projects");
  if (existsSync(claudeProjectsRoot)) {
    try {
      for (const proj of readdirSync(claudeProjectsRoot, {
        withFileTypes: true,
      })) {
        if (!proj.isDirectory()) continue;
        importedMemories += importMarkdownDirectory(
          join(claudeProjectsRoot, proj.name, "memory"),
          `claude:${proj.name}`,
          dbPath,
          25,
        );
      }
    } catch {
      // Ignore
    }
  }

  let indexedSessions = 0;

  // Index Antigravity CLI brains (~/.gemini/antigravity-cli/brain/*)
  const agyBrainRoots: Array<{
    harness: "agy-cli" | "agy-app";
    dir: string;
  }> = [
    {
      harness: "agy-cli",
      dir: join(home, ".gemini", "antigravity-cli", "brain"),
    },
    {
      harness: "agy-app",
      dir: join(home, ".gemini", "antigravity", "brain"),
    },
  ];

  for (const root of agyBrainRoots) {
    if (!existsSync(root.dir)) continue;
    try {
      for (const conv of readdirSync(root.dir, { withFileTypes: true }).slice(
        0,
        120,
      )) {
        if (!conv.isDirectory()) continue;
        const convDir = join(root.dir, conv.name);
        const transcriptPath = join(
          convDir,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        );
        const st = statSync(convDir);
        let stepCount = 0;
        let errorCount = 0;
        let firstPrompt = conv.name;
        if (existsSync(transcriptPath)) {
          try {
            const raw = readFileSync(transcriptPath, "utf8");
            const lines = raw.split(/\r?\n/).filter(Boolean);
            stepCount = lines.length;
            for (const line of lines.slice(0, 60)) {
              if (line.includes('"status":"ERROR"')) errorCount++;
              if (firstPrompt === conv.name && line.includes('"USER_INPUT"')) {
                const parsed = JSON.parse(line) as { content?: string };
                if (parsed.content) {
                  firstPrompt = stripEmojis(
                    redactSecretsFromText(
                      parsed.content.replace(/\s+/g, " ").trim(),
                    ),
                  ).slice(0, 140);
                }
              }
            }
          } catch {
            // Ignore partial transcript
          }
        }
        const normPath = (
          existsSync(transcriptPath) ? transcriptPath : convDir
        ).replace(/\\/g, "/");
        db.query(
          `INSERT OR REPLACE INTO unified_sessions
           (session_id, harness, title, workspace, step_count, error_count, summary_snippet, updated_at, transcript_path)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).run(
          `${root.harness}:${conv.name}`,
          root.harness,
          firstPrompt,
          "C:/src",
          stepCount,
          errorCount,
          firstPrompt,
          st.mtime.toISOString(),
          normPath,
        );
        db.query(`DELETE FROM sessions_fts WHERE session_id = ?1`).run(
          `${root.harness}:${conv.name}`,
        );
        db.query(
          `INSERT INTO sessions_fts (session_id, harness, title, workspace, summary_snippet)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).run(
          `${root.harness}:${conv.name}`,
          root.harness,
          firstPrompt,
          "C:/src",
          firstPrompt,
        );
        indexedSessions++;
      }
    } catch {
      // Ignore
    }
  }

  // Index Claude JSONL sessions (~/.claude/projects/*/*.jsonl)
  if (existsSync(claudeProjectsRoot)) {
    try {
      for (const proj of readdirSync(claudeProjectsRoot, {
        withFileTypes: true,
      }).slice(0, 40)) {
        if (!proj.isDirectory()) continue;
        const projDir = join(claudeProjectsRoot, proj.name);
        for (const f of readdirSync(projDir, { withFileTypes: true }).slice(
          0,
          25,
        )) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const full = join(projDir, f.name);
          const st = statSync(full);
          const sessId = `claude:${basename(f.name, ".jsonl")}`;
          db.query(
            `INSERT OR REPLACE INTO unified_sessions
             (session_id, harness, title, workspace, step_count, error_count, summary_snippet, updated_at, transcript_path)
             VALUES (?1, 'claude', ?2, ?3, 1, 0, ?4, ?5, ?6)`,
          ).run(
            sessId,
            `${proj.name} / ${f.name}`,
            proj.name,
            `Claude session in ${proj.name}`,
            st.mtime.toISOString(),
            full.replace(/\\/g, "/"),
          );
          db.query(`DELETE FROM sessions_fts WHERE session_id = ?1`).run(
            sessId,
          );
          db.query(
            `INSERT INTO sessions_fts (session_id, harness, title, workspace, summary_snippet)
             VALUES (?1, 'claude', ?2, ?3, ?4)`,
          ).run(
            sessId,
            `${proj.name} / ${f.name}`,
            proj.name,
            `Claude session in ${proj.name}`,
          );
          indexedSessions++;
        }
      }
    } catch {
      // Ignore
    }
  }

  const recentSessions = searchUnifiedSessions("", { limit: 30, dbPath });
  const brainIndexPath = join(vaultDir, "00 Unified Brain Index.md");
  const indexLines = [
    "# Unified Brain, Memory, Soul & Session Index",
    "",
    `- **Generated At**: ${new Date().toISOString()}`,
    `- **Database**: \`${dbPath.replace(/\\/g, "/")}\``,
    `- **Imported Memories**: ${importedMemories}`,
    `- **Indexed Sessions**: ${indexedSessions}`,
    "",
    "## Recent Cross-Harness Sessions",
    "",
    "| Session ID | Harness | Steps | Errors | Updated At | Title |",
    "| --- | --- | --- | --- | --- | --- |",
    ...recentSessions.map(
      (s) =>
        `| \`${s.sessionId}\` | ${s.harness} | ${s.stepCount} | ${s.errorCount} | ${s.updatedAt} | ${s.title.replace(/\|/g, "/").slice(0, 80)} |`,
    ),
    "",
  ];
  writeFileSafeUserspace(brainIndexPath, indexLines.join("\n"));

  return {
    importedMemories,
    indexedSessions,
    brainIndexPath: brainIndexPath.replace(/\\/g, "/"),
    soulPaths: soulPaths.map((p) => p.replace(/\\/g, "/")),
  };
}

export function searchUnifiedSessions(
  query: string,
  options?: { harness?: string; limit?: number; dbPath?: string },
): UnifiedSessionSummary[] {
  const db = openNexusDb(options?.dbPath);
  const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
  const cleaned = query
    .replace(/[^A-Za-z0-9_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" OR ");

  let rows: Array<{
    session_id: string;
    harness: UnifiedSessionSummary["harness"];
    title: string;
    workspace: string;
    step_count: number;
    error_count: number;
    updated_at: string;
    transcript_path: string;
  }> = [];

  if (!cleaned) {
    rows = (
      options?.harness
        ? db
            .query(
              `SELECT * FROM unified_sessions WHERE harness = ?1 ORDER BY updated_at DESC LIMIT ?2`,
            )
            .all(options.harness, limit)
        : db
            .query(
              `SELECT * FROM unified_sessions ORDER BY updated_at DESC LIMIT ?1`,
            )
            .all(limit)
    ) as typeof rows;
  } else {
    rows = (
      options?.harness
        ? db
            .query(
              `SELECT s.* FROM sessions_fts f JOIN unified_sessions s ON s.session_id = f.session_id
               WHERE sessions_fts MATCH ?1 AND s.harness = ?2
               ORDER BY rank LIMIT ?3`,
            )
            .all(cleaned, options.harness, limit)
        : db
            .query(
              `SELECT s.* FROM sessions_fts f JOIN unified_sessions s ON s.session_id = f.session_id
               WHERE sessions_fts MATCH ?1
               ORDER BY rank LIMIT ?2`,
            )
            .all(cleaned, limit)
    ) as typeof rows;
  }

  return rows.map((r) => ({
    sessionId: r.session_id,
    harness: r.harness,
    title: r.title,
    workspace: r.workspace,
    stepCount: r.step_count,
    errorCount: r.error_count,
    updatedAt: r.updated_at,
    transcriptPath: r.transcript_path,
  }));
}
