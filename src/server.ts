import {
  getDesktopFfi,
  resolveBrowserCliPath,
  resolveDesktopCliPath,
} from "./ffi/desktop.ts";
import { buildAgentCard, handleA2AJsonRpcRequest } from "./protocols/a2a.ts";
import { handleAcpRequest } from "./protocols/acp.ts";
import {
  handleMcpHttpRequest,
  MCP_PROTOCOL_VERSION,
  MCP_TOOLS,
} from "./protocols/mcp.ts";
import {
  handleChatCompletionsRequest,
  handleEmbeddingsRequest,
  handleModelsListRequest,
  handleOllamaTagsBridgeRequest,
  handleOpenWebUiVersionRequest,
  handleResponsesRequest,
} from "./protocols/openai.ts";
import {
  buildSkillsAndHooksRegistry,
  handleHooksRequest,
  handleSkillsRequest,
} from "./protocols/skills.ts";
import {
  listProviderDescriptors,
  probeLocalProviders,
} from "./providers/federation.ts";
import { readCachedSentinelState, runSentinelSync } from "./sentinel/index.ts";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-session-id, x-vercel-ai-data-stream, x-goog-api-key, x-api-key",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export async function routeAiOsRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // Health & Sovereign Control Plane overview
  if (
    req.method === "GET" &&
    (path === "/" || path === "/health" || path === "/api/status")
  ) {
    const ffi = getDesktopFfi();
    const reg = buildSkillsAndHooksRegistry();
    const sentinel = readCachedSentinelState();
    return withCors(
      Response.json({
        name: "ai-os",
        version: "1.0.0",
        bunVersion: Bun.version,
        protocols: {
          openai: [
            "/v1/models",
            "/v1/chat/completions",
            "/v1/responses",
            "/v1/embeddings",
          ],
          openWebUiBridge: ["/api/version", "/ollama/api/tags", "/api/tags"],
          mcp: {
            endpoint: "/mcp",
            protocolVersion: MCP_PROTOCOL_VERSION,
            tools: MCP_TOOLS.length,
          },
          a2a: { agentCard: "/.well-known/agent.json", rpcEndpoint: "/" },
          acp: { endpoint: "/acp" },
          registry: [
            "/api/skills",
            "/api/hooks",
            "/api/providers",
            "/api/sentinel",
          ],
        },
        nativeBinaries: {
          desktopCli: resolveDesktopCliPath(),
          desktopFfiDll: ffi
            ? { path: ffi.dllPath, abiVersion: ffi.abiVersion }
            : null,
          browserCli: resolveBrowserCliPath(),
        },
        skillsCount: reg.totalSkills,
        hooksCount: reg.totalHooks,
        providers: listProviderDescriptors(),
        sentinelLastSync: sentinel?.generatedAt ?? null,
      }),
    );
  }

  // A2A Agent Card + JSON-RPC root
  if (
    req.method === "GET" &&
    (path === "/.well-known/agent.json" ||
      path === "/.well-known/agent-card.json")
  ) {
    return withCors(Response.json(buildAgentCard(url.origin)));
  }

  if (req.method === "POST" && (path === "/" || path === "/a2a")) {
    return withCors(await handleA2AJsonRpcRequest(req));
  }

  // OpenAI & Open WebUI / Ollama Bridge
  if (req.method === "GET" && path === "/v1/models") {
    return withCors(await handleModelsListRequest());
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return withCors(await handleChatCompletionsRequest(req));
  }
  if (req.method === "POST" && path === "/v1/responses") {
    return withCors(await handleResponsesRequest(req));
  }
  if (req.method === "POST" && path === "/v1/embeddings") {
    return withCors(await handleEmbeddingsRequest(req));
  }
  if (req.method === "GET" && path === "/api/version") {
    return withCors(handleOpenWebUiVersionRequest());
  }
  if (
    req.method === "GET" &&
    (path === "/ollama/api/tags" || path === "/api/tags")
  ) {
    return withCors(await handleOllamaTagsBridgeRequest());
  }

  // MCP Streamable HTTP 2025-03-26
  if (path === "/mcp") {
    return withCors(await handleMcpHttpRequest(req));
  }

  // ACP Agent Client Protocol
  if (path === "/acp") {
    return withCors(await handleAcpRequest(req));
  }

  // Skills & Hooks Registry
  if (req.method === "GET" && path === "/api/skills") {
    return withCors(handleSkillsRequest(url));
  }
  if (req.method === "GET" && path === "/api/hooks") {
    return withCors(handleHooksRequest(url));
  }

  // Providers & Sentinel inspection endpoints
  if (req.method === "GET" && path === "/api/providers") {
    const probe = url.searchParams.get("probe") === "1";
    const data = probe
      ? await probeLocalProviders()
      : listProviderDescriptors();
    return withCors(Response.json({ providers: data }));
  }

  if (path === "/api/sentinel") {
    const refresh =
      req.method === "POST" || url.searchParams.get("refresh") === "1";
    const state =
      refresh || !readCachedSentinelState()
        ? await runSentinelSync()
        : readCachedSentinelState()!;
    return withCors(Response.json(state));
  }

  return withCors(
    Response.json(
      {
        error: {
          message: `Route not found: ${req.method} ${path}`,
          type: "not_found_error",
        },
      },
      { status: 404 },
    ),
  );
}

export interface StartAiOsServerOptions {
  port?: number;
  hostname?: string;
}

export function startAiOsServer(options: StartAiOsServerOptions = {}) {
  const port = options.port ?? Number(process.env.AI_OS_PORT ?? 4318);
  const hostname = options.hostname ?? process.env.AI_OS_HOST ?? "127.0.0.1";
  return Bun.serve({
    port,
    hostname,
    idleTimeout: 120,
    fetch: routeAiOsRequest,
  });
}
