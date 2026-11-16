import { createInterface } from "node:readline";
import { getLibraryDocs, searchLibraries } from "../context7/client.ts";
import {
  DEFAULT_KNOWLEDGE_DB_PATH,
  openKnowledgeDatabase,
} from "../db/sqlite.ts";
import {
  getMaskedApiReadiness,
  redactSecretsFromText,
} from "../env/safe-env.ts";
import { runFactCheck } from "../factcheck/verifier.ts";
import { getBlake3EngineInfo } from "../ffi/blake3.ts";
import { generateMonorepoDocs } from "../generators/docs-gen.ts";
import { generateWorkspaceSkills } from "../generators/skills-gen.ts";
import { runDeepResearch } from "../research/deep-research.ts";
import { auditAllAgySessions } from "../reviewer/agy-session-auditor.ts";

export const KNOWLEDGE_MCP_PROTOCOL_VERSION = "2025-03-26";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface KnowledgeMcpOptions {
  dbPath?: string;
  envPath?: string;
  srcRoot?: string;
  brainRootDir?: string;
  fetchImpl?: typeof fetch;
}

export const KNOWLEDGE_MCP_TOOLS = [
  {
    name: "ctx7_query_docs",
    description:
      "Resolve upstream library documentation via Context7 v2 with local SQLite WAL Blake3 cache (24h TTL). Returns official API snippets and citation URLs.",
    inputSchema: {
      type: "object",
      properties: {
        libraryName: {
          type: "string",
          description:
            "Package or framework name (e.g., 'bun', 'tokio', 'wgpu')",
        },
        query: {
          type: "string",
          description: "Specific API, symbol, or topic to query",
        },
        libraryId: {
          type: "string",
          description:
            "Optional exact Context7 library ID (e.g., '/oven-sh/bun')",
        },
      },
      required: ["libraryName", "query"],
    },
  },
  {
    name: "deep_research",
    description:
      "Execute 5-channel parallel Deep Research (Context7 v2, Exa Neural Search, GitHub Live API, Kernel.org/Freedesktop GitLab, and local C:\\aphrody grounding) and optionally save a cited Markdown dossier.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Technical research query",
        },
        saveReport: {
          type: "boolean",
          description:
            "Save dossier to C:\\aphrody\\docs\\research\\<slug>.md (default: true)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fact_check",
    description:
      "Deterministically fact-check a text claim or local file path (verifies file:/// and C:\\aphrody paths, ~/.local/bin binaries, lockfile versions, GitHub repos, Context7 symbols, secret hygiene, System32 safety, and zero-emoji compliance).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "Claim text or absolute file path (e.g., 'C:/aphrody/README.md')",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "generate_docs_and_skills",
    description:
      "Regenerate C:\\aphrody\\docs\\MONOREPO_ATLAS.md, C:\\aphrody\\third_party\\bun\\docs\\sovereign\\index.mdx, and/or the 5 sovereign workspace SKILL.md definitions.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "docs", "skills"],
          description: "Generation scope (default: 'all')",
        },
      },
    },
  },
  {
    name: "review_agy_sessions",
    description:
      "Incrementally audit Antigravity CLI (agy) brain transcripts and Markdown artifacts (< 30ms warm via SQLite WAL) for tool usage, failed commands, broken file:/// links, secret hygiene, and System32 safety.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Optional specific conversation UUID to audit",
        },
        limit: {
          type: "number",
          description: "Optional max number of recent sessions to return",
        },
      },
    },
  },
  {
    name: "knowledge_status",
    description:
      "Return @aphrody/knowledge-engine health, SQLite WAL table counts, rust_stack_ffi.dll Blake3 ABI status, and masked API credential readiness.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
] as const;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text: redactSecretsFromText(text) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function getKnowledgeEngineStatus(options: KnowledgeMcpOptions = {}) {
  const dbPath = options.dbPath ?? DEFAULT_KNOWLEDGE_DB_PATH;
  const db = openKnowledgeDatabase(dbPath);
  const countRow = (table: string): number => {
    const r = db
      .prepare<{ cnt: number }, []>(`SELECT COUNT(*) AS cnt FROM ${table}`)
      .get();
    return r?.cnt ?? 0;
  };

  return {
    package: "@aphrody/knowledge-engine",
    version: "1.0.0",
    bunVersion: Bun.version,
    mcpProtocolVersion: KNOWLEDGE_MCP_PROTOCOL_VERSION,
    dbPath,
    blake3Engine: getBlake3EngineInfo(),
    apiReadiness: getMaskedApiReadiness(options.envPath),
    tables: {
      context7CacheEntries: countRow("context7_cache"),
      researchDossiers: countRow("research_dossiers"),
      factCheckRuns: countRow("factcheck_runs"),
      agyIndexedSessions: countRow("agy_session_reviews"),
      liveTurnEvents: countRow("live_turn_events"),
    },
  };
}

export async function dispatchKnowledgeMcpRpc(
  req: JsonRpcRequest,
  options: KnowledgeMcpOptions = {},
): Promise<JsonRpcResponse | null> {
  const isNotification = !("id" in req) || req.id === undefined;
  const id = req.id ?? null;
  const method = req.method ?? "";

  if (isNotification) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: KNOWLEDGE_MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "sovereign-knowledge-engine",
          version: "1.0.0",
        },
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: KNOWLEDGE_MCP_TOOLS,
      },
    };
  }

  if (method === "tools/call") {
    const params = req.params ?? {};
    const toolName = String(params.name ?? "");
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};

    try {
      switch (toolName) {
        case "ctx7_query_docs": {
          const libraryName = String(args.libraryName ?? "").trim();
          const query = String(args.query ?? "").trim();
          let libraryId =
            typeof args.libraryId === "string" ? args.libraryId.trim() : "";

          if (!libraryName && !libraryId) {
            return {
              jsonrpc: "2.0",
              id,
              result: textResult("libraryName or libraryId is required", true),
            };
          }

          if (!libraryId) {
            const searched = await searchLibraries(libraryName, query, {
              dbPath: options.dbPath,
              envPath: options.envPath,
              fetchImpl: options.fetchImpl,
            });
            libraryId = searched.results[0]?.id ?? "";
            if (!libraryId) {
              return {
                jsonrpc: "2.0",
                id,
                result: textResult(
                  `No Context7 library found matching "${libraryName}".`,
                  true,
                ),
              };
            }
          }

          const docs = await getLibraryDocs(
            libraryId,
            query || libraryName,
            3500,
            {
              dbPath: options.dbPath,
              envPath: options.envPath,
              fetchImpl: options.fetchImpl,
            },
          );
          return {
            jsonrpc: "2.0",
            id,
            result: textResult(
              JSON.stringify(
                {
                  libraryId: docs.libraryId,
                  version: docs.version,
                  cached: docs.cached,
                  chunksCount: docs.chunks.length,
                  chunks: docs.chunks.slice(0, 6),
                },
                null,
                2,
              ),
            ),
          };
        }

        case "deep_research": {
          const query = String(args.query ?? "").trim();
          if (!query) {
            return {
              jsonrpc: "2.0",
              id,
              result: textResult("Missing required argument: query", true),
            };
          }
          const saveReport =
            typeof args.saveReport === "boolean" ? args.saveReport : true;
          const res = await runDeepResearch(query, {
            saveReport,
            srcRoot: options.srcRoot,
            dbPath: options.dbPath,
            envPath: options.envPath,
            fetchImpl: options.fetchImpl,
          });
          return {
            jsonrpc: "2.0",
            id,
            result: textResult(
              `${res.dossierMarkdown}\n\nSaved Path: ${res.savedPath ?? "(in-memory)"}`,
            ),
          };
        }

        case "fact_check": {
          const target = String(args.target ?? "").trim();
          if (!target) {
            return {
              jsonrpc: "2.0",
              id,
              result: textResult("Missing required argument: target", true),
            };
          }
          const verdict = await runFactCheck(target, {
            srcRoot: options.srcRoot,
            dbPath: options.dbPath,
            envPath: options.envPath,
            fetchImpl: options.fetchImpl,
          });
          return {
            jsonrpc: "2.0",
            id,
            result: textResult(JSON.stringify(verdict, null, 2)),
          };
        }

        case "generate_docs_and_skills": {
          const scope = String(args.scope ?? "all");
          const out: Record<string, unknown> = {};
          if (scope === "all" || scope === "docs") {
            out.docs = await generateMonorepoDocs({
              srcRoot: options.srcRoot,
              dbPath: options.dbPath,
              envPath: options.envPath,
              fetchImpl: options.fetchImpl,
            });
          }
          if (scope === "all" || scope === "skills") {
            out.skills = generateWorkspaceSkills({
              srcRoot: options.srcRoot,
            });
          }
          return {
            jsonrpc: "2.0",
            id,
            result: textResult(JSON.stringify(out, null, 2)),
          };
        }

        case "review_agy_sessions": {
          const sessionIdFilter =
            typeof args.sessionId === "string" && args.sessionId.trim()
              ? args.sessionId.trim()
              : undefined;
          const limit =
            typeof args.limit === "number" && args.limit > 0
              ? args.limit
              : undefined;
          const report = auditAllAgySessions({
            srcRoot: options.srcRoot,
            brainRootDir: options.brainRootDir,
            dbPath: options.dbPath,
            envPath: options.envPath,
            sessionIdFilter,
            limit,
            writeOutputs: !sessionIdFilter && !limit,
          });
          return {
            jsonrpc: "2.0",
            id,
            result: textResult(
              JSON.stringify(
                {
                  generatedAt: report.generatedAt,
                  totalSessions: report.totalSessions,
                  cacheHits: report.cacheHits,
                  reindexedCount: report.reindexedCount,
                  durationMs: Number(report.durationMs.toFixed(2)),
                  totals: report.totals,
                  markdownReportPath: report.markdownReportPath,
                  sessions: report.sessions.slice(0, limit ?? 15),
                },
                null,
                2,
              ),
            ),
          };
        }

        case "knowledge_status": {
          return {
            jsonrpc: "2.0",
            id,
            result: textResult(
              JSON.stringify(getKnowledgeEngineStatus(options), null, 2),
            ),
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`,
            },
          };
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: textResult(
          `Tool execution failed (${toolName}): ${err instanceof Error ? err.message : String(err)}`,
          true,
        ),
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

export async function runKnowledgeMcpStdio(
  options: KnowledgeMcpOptions = {},
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })}\n`,
      );
      continue;
    }

    const resp = await dispatchKnowledgeMcpRpc(req, options);
    if (resp) {
      process.stdout.write(`${JSON.stringify(resp)}\n`);
    }
  }
}
