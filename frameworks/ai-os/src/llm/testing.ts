// Scripted model for tests: replays the given turns in order (the last one repeats) and records every request.
import type {
  ChatRequest,
  ChatResponse,
  LanguageModel,
  ToolCall,
} from "./types";

export type Turn = string | { text?: string; toolCalls?: ToolCall[] };

export type ScriptedModel = LanguageModel & { calls: ChatRequest[] };

export function scriptedModel(...turns: Turn[]): ScriptedModel {
  const calls: ChatRequest[] = [];
  return {
    id: "scripted/test",
    tools: true,
    calls,
    async chat(req): Promise<ChatResponse> {
      req.signal?.throwIfAborted();
      calls.push(structuredClone({ ...req, signal: undefined }));
      const t = turns[Math.min(calls.length - 1, turns.length - 1)] ?? "";
      const turn = typeof t === "string" ? { text: t } : t;
      const toolCalls = turn.toolCalls ?? [];
      return {
        text: turn.text ?? "",
        toolCalls,
        finishReason: toolCalls.length ? "tool_calls" : "stop",
      };
    },
  };
}

export const call = (id: string, name: string, input: unknown): ToolCall => ({
  id,
  name,
  input,
});

// Extracted from vercel-labs/emulate (Apache-2.0): local HTTP API emulation for no-network sandboxes & tests.
export type EmulateRoute = {
  method?: string;
  match: string | RegExp | ((url: URL, req: Request) => boolean);
  handle: (
    req: Request,
    url: URL,
  ) => Response | unknown | Promise<Response | unknown>;
};

export function createEmulateFetch(
  routes: EmulateRoute[],
  fallback?: typeof fetch,
): typeof fetch {
  return (async (input: string | Request | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    for (const r of routes) {
      if (r.method && r.method.toUpperCase() !== req.method.toUpperCase())
        continue;
      const matched =
        typeof r.match === "string"
          ? url.pathname === r.match || url.href.startsWith(r.match)
          : r.match instanceof RegExp
            ? r.match.test(url.href) || r.match.test(url.pathname)
            : r.match(url, req);
      if (!matched) continue;
      const out = await r.handle(req, url);
      if (out instanceof Response) return out;
      return Response.json(out);
    }
    if (fallback) return fallback(input, init);
    return new Response(`emulate: no route for ${req.method} ${url.href}`, {
      status: 404,
    });
  }) as typeof fetch;
}
