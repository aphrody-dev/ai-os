// Unified C ABI bridge to system/core/capi (`aphrody_core_capi`, `ai_os_*` symbols).
// Contract: system/core/capi/include/aphrody_core.h.
// Falls back to native bun:sqlite / JS implementation with identical schema & semantics when
// the compiled cdylib is not present locally (e.g. on Windows workstation before CI/fr1 build).
import { Database } from "bun:sqlite";
import { CString, FFIType, dlopen, type Pointer, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { Context } from "./context";

export const AI_OS_ABI_VERSION = 1;
export const AI_OS_LIB_FILE = `${process.platform === "win32" ? "" : "lib"}aphrody_core_capi.${suffix}`;

const symbols = {
  ai_os_abi_version: { args: [], returns: FFIType.u32 },
  ai_os_free: { args: [FFIType.ptr], returns: FFIType.void },
  ai_os_uname_json: { args: [], returns: FFIType.ptr },
  ai_os_vfs_resolve_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  ai_os_llm_spec_json: { args: [], returns: FFIType.ptr },
  ai_os_rag_upsert_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  ai_os_rag_query_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  ai_os_world_step_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  ai_os_world_state_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  ai_os_sys1_decide_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
} as const;

type AiOsLib = ReturnType<typeof dlopen<typeof symbols>>;

function libCandidates(): string[] {
  const root =
    process.env.SRC_ROOT || join(import.meta.dir, "..", "..", "..", "..");
  const target = process.env.CARGO_TARGET_DIR || join(root, "target");
  return [
    process.env.APHRODY_CORE_LIB,
    join(homedir(), ".local", "bin", AI_OS_LIB_FILE),
    join(target, "release", AI_OS_LIB_FILE),
    join(target, "debug", AI_OS_LIB_FILE),
  ].filter((p): p is string => Boolean(p));
}

let cached: { lib: AiOsLib; path: string } | null | undefined;

export function loadAiOsCabi(): { lib: AiOsLib; path: string } | null {
  if (cached !== undefined) return cached;
  for (const p of libCandidates()) {
    if (!existsSync(p)) continue;
    try {
      const lib = dlopen(p, symbols);
      if (lib.symbols.ai_os_abi_version() !== AI_OS_ABI_VERSION) {
        lib.close();
        continue;
      }
      cached = { lib, path: p };
      return cached;
    } catch {
      // Fall through to next candidate or TS/bun:sqlite implementation
    }
  }
  cached = null;
  return null;
}

const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");

function readJson<T>(lib: AiOsLib, ret: Pointer | bigint | null): T {
  // bun:ffi types a `ptr` return as Pointer or bigint; the value is the same address.
  const ptrVal = ret as Pointer | null;
  if (!ptrVal) throw new Error("ai_os C ABI returned null pointer");
  try {
    const out = JSON.parse(new CString(ptrVal).toString());
    if (out && typeof out === "object" && "error" in out) {
      throw new Error(String((out as { error: unknown }).error));
    }
    return out as T;
  } finally {
    lib.symbols.ai_os_free(ptrVal);
  }
}

const AI_OS_SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS world_entities(
  entity TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_transitions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  predicted_json TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  surprise REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sys1_decisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  risk REAL NOT NULL,
  confidence REAL NOT NULL,
  surprise REAL NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  latency_us INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
`;

function openOsDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(AI_OS_SCHEMA);
  return db;
}

export interface AiOsUname {
  os: string;
  release: string;
  kernel: string;
  arch: string;
  abi_version: number;
  standards: string[];
  fhs: {
    etc: string;
    var: string;
    home: string;
    proc: string;
    tmp: string;
    dev: string[];
  };
}

export interface VfsResolved {
  vpath: string;
  host_path: string;
  device: string;
  readonly: boolean;
}

export interface WorldStepInput {
  actor: string;
  action: string;
  target: string;
  predicted: unknown;
  observed: unknown;
  ts?: number;
}

export interface WorldStepResult {
  entity: string;
  surprise: number;
  escalate_sys2: boolean;
  state: unknown;
}

export interface Sys1DecisionInput {
  action: string;
  risk: number;
  confidence: number;
  world_surprise?: number;
  latency_budget_ms?: number;
}

export interface Sys1DecisionResult {
  decision: "exec" | "escalate_sys2" | "deny";
  reason: string;
  latency_us: number;
}

export function osUname(): AiOsUname {
  const loaded = loadAiOsCabi();
  if (loaded)
    return readJson<AiOsUname>(
      loaded.lib,
      loaded.lib.symbols.ai_os_uname_json(),
    );
  return {
    os: "aphrody-ai-os",
    release: "0.4.0",
    kernel: process.platform,
    arch: process.arch,
    abi_version: AI_OS_ABI_VERSION,
    standards: [
      "posix-vfs-fhs",
      "openapi-3.2.1",
      "openai-chat-v1",
      "anthropic-messages-v1",
      "gemini-generate-v1",
      "vercel-ai-sdk-7.0",
      "cloudflare-agents-0.33",
      "mcp-2026-07-28",
      "a2a-1.0.1",
      "acp-1.31.0",
      "sqlite-fts5-rrf",
      "world-model-v1",
      "system1-policy-v1",
    ],
    fhs: {
      etc: "/etc/ai-os",
      var: "/var/lib/ai-os",
      home: "/home/agent",
      proc: "/proc/agent",
      tmp: "/tmp",
      dev: ["/dev/llm", "/dev/rag", "/dev/world", "/dev/sys1"],
    },
  };
}

export function osResolveVfs(home: string, vpath: string): VfsResolved {
  const loaded = loadAiOsCabi();
  if (loaded) {
    return readJson<VfsResolved>(
      loaded.lib,
      loaded.lib.symbols.ai_os_vfs_resolve_json(cstr(home), cstr(vpath)),
    );
  }
  const trimmed = vpath.trim().replaceAll("\\", "/");
  if (!trimmed) throw new Error("empty virtual path");
  if (/^[A-Za-z]:/.test(trimmed))
    throw new Error("host drive prefix forbidden in VFS");
  const rawParts = trimmed.split("/").filter(Boolean);
  if (rawParts.includes(".."))
    throw new Error("parent traversal '..' forbidden in VFS");
  const parts = rawParts.filter((p) => p !== ".");
  const head = parts[0] ?? "";
  let device = "fs";
  let readonly = false;
  let rel = join(...parts);
  if (head === "dev") {
    device = parts[1] ?? "null";
    rel = join("dev", device);
  } else if (head === "proc") {
    device = "proc";
    readonly = true;
  }
  return {
    vpath: `/${posix.join(...parts)}`,
    host_path: join(home, rel),
    device,
    readonly,
  };
}

export function osLlmSpec() {
  const loaded = loadAiOsCabi();
  if (loaded)
    return readJson(loaded.lib, loaded.lib.symbols.ai_os_llm_spec_json());
  return {
    discovery: "runtime",
    hardcoded_models: false,
    wire_protocols: [
      "openai-chat-completions",
      "anthropic-messages",
      "google-genai",
      "ollama",
    ],
    sdks: ["vercel-ai-v7", "rig-core", "mistralrs"],
    device: "/dev/llm",
  };
}

export async function osRagUpsert(
  dbPath: string,
  entry: {
    id: string;
    source: string;
    scope: string;
    title?: string;
    text: string;
    at?: number;
  },
) {
  const loaded = loadAiOsCabi();
  if (loaded) {
    return readJson<{ ok: boolean; id: string }>(
      loaded.lib,
      loaded.lib.symbols.ai_os_rag_upsert_json(
        cstr(dbPath),
        cstr(JSON.stringify(entry)),
      ),
    );
  }
  const ctx = new Context(dbPath);
  try {
    const { at, ...rest } = entry;
    await ctx.ingest(rest, at ?? Date.now());
    return { ok: true, id: entry.id };
  } finally {
    ctx.close();
  }
}

export async function osRagQuery(
  dbPath: string,
  req: { query: string; k?: number; sources?: string[]; scopes?: string[] },
) {
  const loaded = loadAiOsCabi();
  if (loaded) {
    return readJson<Array<Record<string, unknown>>>(
      loaded.lib,
      loaded.lib.symbols.ai_os_rag_query_json(
        cstr(dbPath),
        cstr(JSON.stringify(req)),
      ),
    );
  }
  const ctx = new Context(dbPath);
  try {
    const hits = await ctx.select(req.query, {
      k: req.k ?? 8,
      sources: req.sources,
      scopes: req.scopes,
    });
    return hits.map((h) => ({
      id: h.id,
      source: h.source,
      scope: h.scope,
      title: h.title ?? null,
      text: h.text,
      at: h.at,
      score: h.score,
    }));
  } finally {
    ctx.close();
  }
}

export function osWorldStep(
  dbPath: string,
  step: WorldStepInput,
): WorldStepResult {
  const loaded = loadAiOsCabi();
  if (loaded) {
    return readJson<WorldStepResult>(
      loaded.lib,
      loaded.lib.symbols.ai_os_world_step_json(
        cstr(dbPath),
        cstr(JSON.stringify(step)),
      ),
    );
  }
  const db = openOsDb(dbPath);
  try {
    const predStr = JSON.stringify(step.predicted ?? null);
    const obsStr = JSON.stringify(step.observed ?? null);
    const surprise = predStr === obsStr ? 0.0 : 1.0;
    const ts = step.ts ?? Date.now();
    db.query(
      "INSERT INTO world_transitions(actor, action, target, predicted_json, observed_json, surprise, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(step.actor, step.action, step.target, predStr, obsStr, surprise, ts);
    db.query(
      "INSERT INTO world_entities(entity, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(entity) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at",
    ).run(step.target, obsStr, ts);
    return {
      entity: step.target,
      surprise,
      escalate_sys2: surprise >= 0.5,
      state: step.observed,
    };
  } finally {
    db.close();
  }
}

export function osWorldState(dbPath: string, entity = "") {
  const loaded = loadAiOsCabi();
  if (loaded) {
    return readJson(
      loaded.lib,
      loaded.lib.symbols.ai_os_world_state_json(cstr(dbPath), cstr(entity)),
    );
  }
  const db = openOsDb(dbPath);
  try {
    if (entity) {
      const row = db
        .query(
          "SELECT state_json, updated_at FROM world_entities WHERE entity = ?",
        )
        .get(entity) as { state_json: string; updated_at: number } | null;
      if (!row) throw new Error(`unknown world entity: ${entity}`);
      return {
        entity,
        state: JSON.parse(row.state_json),
        updated_at: row.updated_at,
      };
    }
    const rows = db
      .query(
        "SELECT entity, state_json, updated_at FROM world_entities ORDER BY updated_at DESC",
      )
      .all() as Array<{
      entity: string;
      state_json: string;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      entity: r.entity,
      state: JSON.parse(r.state_json),
      updated_at: r.updated_at,
    }));
  } finally {
    db.close();
  }
}

export function osSys1Decide(
  dbPath: string,
  req: Sys1DecisionInput,
): Sys1DecisionResult {
  const loaded = loadAiOsCabi();
  if (loaded) {
    return readJson<Sys1DecisionResult>(
      loaded.lib,
      loaded.lib.symbols.ai_os_sys1_decide_json(
        cstr(dbPath),
        cstr(JSON.stringify(req)),
      ),
    );
  }
  const t0 = performance.now();
  const surprise = req.world_surprise ?? 0;
  let decision: "exec" | "escalate_sys2" | "deny";
  let reason: string;
  if (
    !Number.isFinite(req.risk) ||
    !Number.isFinite(req.confidence) ||
    !Number.isFinite(surprise)
  ) {
    decision = "deny";
    reason = "non-finite decision input";
  } else if (req.risk > 0.85) {
    decision = "deny";
    reason = `risk ${req.risk.toFixed(2)} > 0.85 policy ceiling`;
  } else if (req.confidence >= 0.85 && req.risk <= 0.25 && surprise < 0.5) {
    decision = "exec";
    reason = `system1 fast-path (conf=${req.confidence.toFixed(2)}, risk=${req.risk.toFixed(2)}, surprise=${surprise.toFixed(2)})`;
  } else {
    decision = "escalate_sys2";
    reason = `escalate to system2/LLM (conf=${req.confidence.toFixed(2)}, risk=${req.risk.toFixed(2)}, surprise=${surprise.toFixed(2)}, budget_ms=${req.latency_budget_ms ?? 0})`;
  }
  const latency_us = Math.round((performance.now() - t0) * 1000);
  if (dbPath) {
    const db = openOsDb(dbPath);
    try {
      db.query(
        "INSERT INTO sys1_decisions(action, risk, confidence, surprise, decision, reason, latency_us, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        req.action,
        req.risk,
        req.confidence,
        surprise,
        decision,
        reason,
        latency_us,
        Date.now(),
      );
    } finally {
      db.close();
    }
  }
  return { decision, reason, latency_us };
}
