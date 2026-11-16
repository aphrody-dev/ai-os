import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  LOCAL_ENGINE_ENDPOINTS,
  LOCALLY_UNCENSORED_CATALOG,
  probeActiveLocalEngines,
} from "./lu-provider.ts";
import {
  getCpuThreads,
  isNativeRustLoaded,
  snapshotWorkspace,
} from "./native-bridge.ts";

export interface SessionRecord {
  id: string;
  title: string;
  model: string;
  workspace: string;
  merkleHash: string;
  createdAt: string;
}

export class SessionStore {
  readonly db: Database;

  constructor(dbPath = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        workspace TEXT NOT NULL,
        merkle_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createSession(input: {
    title: string;
    model: string;
    workspace: string;
  }): SessionRecord {
    const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const snap = snapshotWorkspace(input.workspace);
    const createdAt = new Date().toISOString();
    this.db
      .query(
        "INSERT INTO sessions (id, title, model, workspace, merkle_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.title,
        input.model,
        resolve(input.workspace),
        snap.merkleHash,
        createdAt,
      );
    return {
      id,
      title: input.title,
      model: input.model,
      workspace: resolve(input.workspace),
      merkleHash: snap.merkleHash,
      createdAt,
    };
  }

  appendEvent(sessionId: string, kind: string, payload: unknown): void {
    this.db
      .query(
        "INSERT INTO events (session_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, kind, JSON.stringify(payload), new Date().toISOString());
  }

  listSessions(limit = 25): SessionRecord[] {
    const rows = this.db
      .query(
        "SELECT id, title, model, workspace, merkle_hash, created_at FROM sessions ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as Array<{
      id: string;
      title: string;
      model: string;
      workspace: string;
      merkle_hash: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      model: r.model,
      workspace: r.workspace,
      merkleHash: r.merkle_hash,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Renders a crisp differential OpenTUI-styled terminal frame without ANSI bloat or emojis.
 */
export function renderOpenTuiFrame(state: {
  workspace: string;
  activeModel: string;
  mode: "interactive" | "autonomous-nhitl";
  merkleHash: string;
  fileCount: number;
  sessions: number;
}): string {
  const width = 86;
  const top = `+${"-".repeat(width - 2)}+`;
  const pad = (line: string) => {
    const trimmed = line.slice(0, width - 4);
    return `| ${trimmed}${" ".repeat(Math.max(0, width - 4 - trimmed.length))} |`;
  };
  return [
    top,
    pad(
      "PI-OPENCODE v1.0.0 | Bun v1.4.4 Full-Rust + OpenTUI + Locally Uncensored",
    ),
    `+${"=".repeat(width - 2)}+`,
    pad(`Workspace : ${state.workspace}`),
    pad(
      `Snapshot  : merkle=${state.merkleHash} (${state.fileCount} tracked files)`,
    ),
    pad(
      `Model     : ${state.activeModel} [Open-Weights / Zero Cloud Refusal Filter]`,
    ),
    pad(`Loop Mode : ${state.mode} | Atomic Tools: [read, write, edit, bash]`),
    pad(
      `Native    : rust_ffi=${isNativeRustLoaded() ? "active" : "bun-fallback"} | threads=${getCpuThreads()} | sessions=${state.sessions}`,
    ),
    top,
  ].join("\n");
}

export function renderOpenCodeWebDashboardHtml(workspace: string): string {
  const snap = snapshotWorkspace(workspace);
  const modelRows = LOCALLY_UNCENSORED_CATALOG.map(
    (m) =>
      `<tr><td><code>${m.id}</code></td><td>${m.quantization}</td><td>${m.vramGb} GB</td><td>${m.abliterationMethod}</td><td>${m.recommendedTarget}</td></tr>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>pi-opencode | Minimalist Autonomous Coding Workbench</title>
  <meta name="description" content="Pi 4-tool agent core + OpenCode Bun/Rust UI + Locally Uncensored GPU inference + Symphony/Ralph NHITL loop." />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --panel: #13171d;
      --border: #252c37;
      --fg: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --ok: #3fb950;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--bg); color: var(--fg); padding: 24px; line-height: 1.5; }
    header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--border); padding-bottom: 14px; margin-bottom: 20px; }
    h1 { font-size: 1.15rem; font-weight: 600; letter-spacing: -0.02em; }
    .badge { font-size: 0.78rem; padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px; color: var(--ok); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
    .card h2 { font-size: 0.85rem; color: var(--muted); text-transform: uppercase; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; font-size: 0.84rem; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; }
    code { color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <h1>pi-opencode // Pi Minimalism + OpenCode Bun/Rust UI + Locally Uncensored</h1>
    <span class="badge">NHITL Full-Auto Ready | Rust FFI: ${isNativeRustLoaded() ? "Loaded" : "Fallback"}</span>
  </header>
  <section class="grid">
    <div class="card">
      <h2>Workspace Snapshot</h2>
      <p>Path: <code>${resolve(workspace)}</code></p>
      <p>Files: ${snap.fileCount} (${snap.totalBytes.toLocaleString()} bytes)</p>
      <p>Merkle: <code>${snap.merkleHash}</code></p>
    </div>
    <div class="card">
      <h2>Atomic Pi Tool Loadout</h2>
      <p>1. <code>read</code> (line-sliced zero-bloat reader)</p>
      <p>2. <code>write</code> (workspace-jailed creator)</p>
      <p>3. <code>edit</code> (surgical exact replacement + Rust diff)</p>
      <p>4. <code>bash</code> (Userspace-guarded shell runner)</p>
    </div>
    <div class="card">
      <h2>Autonomous Loop</h2>
      <p>Spec: <code>WORKFLOW.md</code> (Symphony) + <code>prd.json</code> (Ralph)</p>
      <p>Isolation: Per-task Git/JJ detached worktree</p>
      <p>Hardware: RTX 4070 12GB sm_89 (${getCpuThreads()} CPU threads)</p>
    </div>
  </section>
  <table>
    <thead>
      <tr><th>Uncensored Model ID</th><th>Quant</th><th>VRAM</th><th>Method</th><th>Target</th></tr>
    </thead>
    <tbody>${modelRows}</tbody>
  </table>
</body>
</html>`;
}

export function startOpenCodeServer(opts: {
  port?: number;
  workspace: string;
  store?: SessionStore;
}) {
  const store = opts.store ?? new SessionStore();
  const workspace = resolve(opts.workspace);

  const server = Bun.serve({
    port: opts.port ?? 4096,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/ui") {
        return new Response(renderOpenCodeWebDashboardHtml(workspace), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/health") {
        const snap = snapshotWorkspace(workspace);
        return Response.json({
          ok: true,
          runtime: `bun-${Bun.version}`,
          nativeRustFfi: isNativeRustLoaded(),
          cpuThreads: getCpuThreads(),
          workspace,
          snapshot: snap,
        });
      }

      if (url.pathname === "/api/models") {
        const engines = await probeActiveLocalEngines(250);
        return Response.json({
          catalog: LOCALLY_UNCENSORED_CATALOG,
          configuredEndpoints: LOCAL_ENGINE_ENDPOINTS,
          activeEngines: engines,
        });
      }

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        return Response.json({ sessions: store.listSessions() });
      }

      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const body = (await req.json()) as { title?: string; model?: string };
        const created = store.createSession({
          title: body.title ?? "Untitled Autonomous Session",
          model: body.model ?? LOCALLY_UNCENSORED_CATALOG[0].id,
          workspace,
        });
        return Response.json(created, { status: 201 });
      }

      return Response.json({ error: "Not Found" }, { status: 404 });
    },
  });

  return { server, store };
}
