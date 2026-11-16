// Protocol surfaces of the relay, all JSON-RPC 2.0 over the same tools (tools.ts):
//   - native relay: `<tool>` methods (e.g. gemini_ask) and `tools/list`;
//   - MCP Streamable HTTP, two epochs: 2025-11-25 (initialize) and 2026-07-28 (server/discover, stateless,
//     per-request _meta, resultType, ttlMs/cacheScope) — spec modelcontextprotocol@2026-07-28;
//   - A2A 1.0: a2a.ts (same tools, via call).
import { validate } from "../llm/schema.ts";
import type { JsonSchema } from "../llm/types.ts";
import { hubCall, hubTools, isBuiltin } from "./mcp-hub.ts";
import { TOOLS, toolByName } from "./tools.ts";

export const VERSION = "0.1.0";
export const MCP_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];
export type Req = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
};
export type Res = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export const ok = (id: Req["id"], result: unknown): Res => ({
  jsonrpc: "2.0",
  id: id ?? null,
  result,
});
export const fail = (
  id: Req["id"],
  code: number,
  message: string,
  data?: unknown,
): Res => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data ? { data } : {}) },
});
/** JSON-RPC code of an exception: integer only (a network error carries e.code = "ECONNREFUSED", forbidden by
 * JSON-RPC 2.0 §5.1), otherwise the default code. */
export const rpcCode = (e: any, d: number) =>
  Number.isInteger(e?.code) ? (e.code as number) : d;
export const text = (v: unknown): string =>
  typeof v === "string"
    ? v
    : v !== null &&
        typeof v === "object" &&
        typeof (v as any).text === "string" &&
        Object.keys(v).length <= 4
      ? (v as any).text
      : (JSON.stringify(v ?? null, null, 1) ?? String(v));

export async function call(name: string, args: unknown) {
  if (typeof name !== "string")
    throw Object.assign(new Error("method missing"), { code: -32600 });
  if (
    args !== undefined &&
    (args === null || typeof args !== "object" || Array.isArray(args))
  )
    throw Object.assign(new Error("arguments must be an object"), {
      code: -32602,
    });
  const t = toolByName.get(name);
  if (!t && name.includes("__")) return hubCall(name, args ?? {});
  if (!t)
    throw Object.assign(new Error(`unknown tool: ${name}`), {
      code: -32601,
      unknownTool: true,
    });
  const input = args ?? {};
  const bad = validate(t.inputSchema as JsonSchema, input);
  if (bad.length)
    throw Object.assign(new Error(`arguments invalides : ${bad.join("; ")}`), {
      code: -32602,
    });
  return t.run(input);
}

/** Native relay: { method: "gemini_ask", params: { prompt } }; "tools/list" for the inventory. */
export async function nativeRpc(r: Req): Promise<Res | null> {
  try {
    if (r.method === "tools/list")
      return ok(r.id, [
        ...TOOLS.map(({ run, ...t }) => t),
        ...(r.params?.hub === false ? [] : await hubTools()),
      ]);
    const v = await call(r.method, r.params);
    return r.id === undefined ? null : ok(r.id, v);
  } catch (e: any) {
    return r.id === undefined
      ? null
      : fail(r.id, rpcCode(e, -32000), e.message);
  }
}

const serverInfo = { name: "aphrody-relay", version: VERSION };
// Own tools, then tools of the aggregated user MCP servers (<server>__<tool>), deterministic order.
const mcpTools = async (core = false) => [
  ...TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.readOnly, openWorldHint: !t.readOnly },
  })),
  ...(Bun.env.RELAY_HUB === "0"
    ? []
    : (await hubTools(core)).map(({ server, ...t }) => ({
        ...t,
        description: `[${server}] ${t.description ?? ""}`,
      }))),
];

/** core: without the servers aggregated from ~/.claude.json (route /mcp/core, for Claude Code which already declares them). */
export async function mcpRpc(r: Req, core = false): Promise<Res | null> {
  const modern = r.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (modern && !MCP_VERSIONS.includes(modern))
    return fail(r.id, -32602, "UnsupportedProtocolVersionError", {
      supported: MCP_VERSIONS,
      requested: modern,
    });
  const meta = { "io.modelcontextprotocol/serverInfo": serverInfo };
  const complete = (x: Record<string, unknown>) =>
    modern
      ? {
          resultType: "complete",
          ...x,
          _meta: {
            ...meta,
            ...(x._meta as Record<string, unknown> | undefined),
          },
        }
      : x;
  try {
    switch (r.method) {
      case "server/discover":
        return ok(r.id, {
          resultType: "complete",
          supportedVersions: MCP_VERSIONS,
          capabilities: { tools: {} },
          _meta: meta,
          instructions:
            "Relais aphrody : Gemini (web/CLI), Claude Code headless, flotte VPS, gcloud.",
          ttlMs: 3_600_000,
          cacheScope: "private",
        });
      case "initialize": {
        const asked = r.params?.protocolVersion;
        return ok(r.id, {
          protocolVersion: MCP_VERSIONS.includes(asked) ? asked : "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return ok(r.id, {});
      case "tools/list":
        return ok(
          r.id,
          complete({
            tools: await mcpTools(core),
            ...(modern ? { ttlMs: 3_600_000, cacheScope: "private" } : {}),
          }),
        );
      case "tools/call": {
        const name = r.params?.name;
        // Unknown tool or missing name: protocol error -32602 (MCP spec 2025-11-25, server/tools, Error Handling).
        if (typeof name !== "string" || !name)
          return r.id === undefined
            ? null
            : fail(
                r.id,
                -32602,
                "Invalid params: name must be a non-empty string",
              );
        // /mcp/core: same scope at call time as at listing time (no tool of an aggregated ~/.claude.json server).
        if (
          core &&
          name.includes("__") &&
          !TOOLS.some((t) => t.name === name) &&
          !isBuiltin(name.slice(0, name.indexOf("__")))
        )
          return fail(r.id, -32602, `Unknown tool: ${name}`);
        const args = r.params?.arguments;
        if (
          args !== undefined &&
          (args === null || typeof args !== "object" || Array.isArray(args))
        )
          return fail(
            r.id,
            -32602,
            "Invalid params: arguments must be an object",
          );
        try {
          const v = await call(name, args);
          // Tool of an aggregated server: its MCP result is returned as is.
          if (!toolByName.has(name))
            return ok(r.id, complete(v as Record<string, unknown>));
          return ok(
            r.id,
            complete({
              content: [{ type: "text", text: text(v) }],
              // structuredContent must be a JSON object (MCP specification).
              ...(v !== null && typeof v === "object" && !Array.isArray(v)
                ? { structuredContent: v }
                : {}),
              isError: false,
            }),
          );
        } catch (e: any) {
          // Protocol errors: unknown local tool or aggregated server (-32602), or JSON-RPC error relayed from an
          // aggregated server (its code). Execution failures stay isError results.
          const proto = e?.unknownTool
            ? fail(r.id, -32602, `Unknown tool: ${name}`)
            : e?.code === -32602 && !e?.rpc
              ? fail(r.id, -32602, e.message) // arguments rejected by the tool's inputSchema
              : e?.rpc && Number.isInteger(e.code)
                ? // Aggregated server older than 2025-11-25: -32601 for an unknown tool, normalized to -32602.
                  fail(
                    r.id,
                    e.code === -32601 ? -32602 : e.code,
                    e.message,
                    e.data,
                  )
                : null;
          if (proto) return r.id === undefined ? null : proto;
          return ok(
            r.id,
            complete({
              content: [{ type: "text", text: String(e?.message ?? e) }],
              isError: true,
            }),
          );
        }
      }
      default:
        return r.id === undefined
          ? null
          : fail(r.id, -32601, `unknown MCP method: ${r.method}`);
    }
  } catch (e: any) {
    return r.id === undefined
      ? null
      : fail(r.id, rpcCode(e, -32603), e.message);
  }
}

/** JSON-RPC body (object or batch) -> response(s); `null` if notifications only. */
export async function dispatch(
  body: unknown,
  h: (r: Req) => Promise<Res | null>,
) {
  const validId = (id: unknown) =>
    id === undefined ||
    id === null ||
    typeof id === "string" ||
    (typeof id === "number" && Number.isFinite(id));
  const invalid = (b: unknown) =>
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    (b as Req).jsonrpc !== "2.0" ||
    typeof (b as Req).method !== "string" ||
    !validId((b as Req).id) ||
    ((b as Req).params !== undefined &&
      ((b as Req).params === null || typeof (b as Req).params !== "object"));
  // A notification (no id) never gets a response, whatever the handler returns (JSON-RPC 2.0 §4.1).
  const one = async (b: unknown): Promise<Res | null> => {
    if (invalid(b)) {
      const id = (b as any)?.id;
      return fail(
        validId(id) ? (id ?? null) : null,
        -32600,
        "invalid JSON-RPC 2.0 request",
      );
    }
    const r = b as Req;
    const res = await h(r);
    return r.id === undefined ? null : res;
  };
  if (Array.isArray(body)) {
    if (!body.length) return fail(null, -32600, "lot JSON-RPC vide");
    const out = (await Promise.all(body.map(one))).filter(Boolean);
    return out.length ? out : null;
  }
  return one(body);
}
