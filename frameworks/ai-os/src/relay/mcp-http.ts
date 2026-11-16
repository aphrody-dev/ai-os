// Shared MCP "Streamable HTTP" client (spec 2025-11-25): relay (mcp-hub, aggregated http servers) and Stitch client
// (src/google/stitch). Remplace @modelcontextprotocol/sdk (Client + StreamableHTTPClientTransport) : POST JSON-RPC,
// JSON response or SSE stream, Mcp-Session-Id header kept after initialize, session DELETE on close.
// Headers are never logged.

export const MCP_PROTOCOL = "2025-11-25";

/** Non-OK HTTP response (same role as the MCP SDK's StreamableHTTPError: `code` = HTTP status). */
export class McpHttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly headers: Headers,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

/** JSON-RPC error returned by the server (code and data kept). */
export class McpRpcError extends Error {
  readonly rpc = true;
  constructor(
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

export type McpFetch = (
  url: string,
  init: RequestInit & Record<string, unknown>,
) => Promise<Response>;

export type McpHttpOptions = {
  url: string;
  /** Fixed headers (auth included). */
  headers?: Record<string, string>;
  /** Headers computed on every request (short-lived OAuth token). */
  dynamicHeaders?: () => Promise<Record<string, string>>;
  clientInfo?: { name: string; version: string };
  /** fetch used (the relay passes outboundFetch: cache, singleflight). */
  fetch?: McpFetch;
};

/** First JSON-RPC message of a JSON or SSE response (`data:` lines, several lines concatenated). */
export function parseMcpBody(body: string, id?: number): any {
  const t = body.trimStart();
  if (!t) return {};
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  for (const ev of body.split(/\r?\n\r?\n/)) {
    const data = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    const m = JSON.parse(data);
    if (id === undefined || m.id === id) return m;
  }
  return {};
}

/** JSON-RPC message carrying `id`, otherwise error (a cut stream or missing response does not pass as a success). */
function reply(body: string, id: number, shared = false): any {
  // A body replayed by outboundFetch (cache hit, coalesced flight) answers an earlier request: `id` is ignored in its
  // cache key, so it carries that request's id; the one-request body is taken as is.
  const m = parseMcpBody(body, shared ? undefined : id);
  if (m.error)
    throw new McpRpcError(m.error.code, m.error.message, m.error.data);
  if (shared ? !("result" in m) : m.id !== id)
    throw new McpRpcError(-32603, `JSON-RPC response ${id} missing`);
  return m.result;
}

export class McpHttpClient {
  private seq = 0;
  private session: string | undefined;
  private initialized: Promise<unknown> | null = null;
  constructor(private o: McpHttpOptions) {}

  private async headers(): Promise<Record<string, string>> {
    // Protocol headers after the caller's: they cannot be overwritten.
    return {
      ...(this.o.headers ?? {}),
      ...((await this.o.dynamicHeaders?.()) ?? {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL,
      ...(this.session ? { "mcp-session-id": this.session } : {}),
    };
  }

  private async post(
    body: unknown,
    opts: { timeout?: number; init?: Record<string, unknown> },
  ) {
    const f = this.o.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
    const r = await f(this.o.url, {
      ...(opts.init ?? {}),
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
      ...(opts.timeout ? { signal: AbortSignal.timeout(opts.timeout) } : {}),
    });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new McpHttpError(
        r.status,
        `Error POSTing to endpoint (HTTP ${r.status}): ${text || r.statusText}`,
        r.headers,
      );
    }
    return r;
  }

  /** initialize + notifications/initialized, once only (concurrent calls shared); result of initialize. */
  connect(): Promise<unknown> {
    this.initialized ??= (async () => {
      const id = ++this.seq;
      const r = await this.post(
        {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL,
            capabilities: {},
            clientInfo: this.o.clientInfo ?? {
              name: "aphrody-relay",
              version: "0.1.0",
            },
          },
        },
        {},
      );
      const result = reply(await r.text(), id);
      await this.post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {},
      );
      return result;
    })().catch((e) => {
      this.initialized = null;
      throw e;
    });
    return this.initialized;
  }

  /** JSON-RPC request; `init` is passed as is to fetch (e.g. { deterministic: true } for outboundFetch). */
  async request<T = any>(
    method: string,
    params: unknown,
    opts: { timeout?: number; init?: Record<string, unknown> } = {},
  ): Promise<T> {
    const send = async () => {
      const id = ++this.seq;
      const r = await this.post({ jsonrpc: "2.0", id, method, params }, opts);
      return reply(await r.text(), id, r.headers.has("x-aphrody-cache")) as T;
    };
    try {
      return await send();
    } catch (e) {
      // Session expired (spec: HTTP 404 with Mcp-Session-Id): new session, a single new attempt.
      if (!(e instanceof McpHttpError) || e.code !== 404 || !this.session)
        throw e;
      this.session = undefined;
      this.initialized = null;
      await this.connect();
      return send();
    }
  }

  callTool<T = any>(
    name: string,
    args: Record<string, unknown>,
    opts?: { timeout?: number; init?: Record<string, unknown> },
  ) {
    return this.request<T>("tools/call", { name, arguments: args }, opts);
  }

  /** Ends the session on the server side (DELETE, best effort). */
  async close(): Promise<void> {
    const sid = this.session;
    this.session = undefined;
    this.initialized = null;
    if (!sid) return;
    const f = this.o.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
    await f(this.o.url, {
      method: "DELETE",
      headers: {
        ...(this.o.headers ?? {}),
        ...((await this.o.dynamicHeaders?.()) ?? {}),
        "mcp-session-id": sid,
      },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}
