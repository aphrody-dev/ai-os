// Gateway (OpenClaw gateway concept, bun-native): one Bun.serve process exposing the agent to
// - WebSocket sessions (/ws, JSON frames {type:"message", session, text})
// - OpenAI-compatible chat (/v1/chat/completions, non-streaming)
// A2A is served once, by the relay (A2A 1.0.1 SendMessage, skill agent_run; src/relay/protocols.ts).
// - channels (/channels/<id>): pluggable adapters; Chat SDK adapters (Slack, Telegram, Discord, Teams...) plug in here.
// Sessions keep per-id history (multi-turn) and every turn goes through core run() (Context-selected memory/skills).
import { timingSafeEqual } from "node:crypto";
import { run } from "../core/agent";
import { layout } from "../core/home";
import { Memory } from "../core/memory";
import type { LanguageModel, Message } from "../llm/types";
export {
  applyPatch,
  createUIMessageStreamResponse,
  diffToPatches,
  type JsonPatch,
  JsonToSseTransformStream,
  UI_MESSAGE_STREAM_HEADERS,
  type UIElement,
  type UISpec,
  validateUISpec,
} from "./ui-stream";

export type Inbound = {
  channel: string;
  session: string;
  text: string;
  user?: string;
};
export interface Channel {
  id: string;
  /** Own authentication of a public webhook (provider signature). Without it the gateway token is required. */
  verify?(req: Request): Promise<boolean>;
  /** Parse a webhook request into an inbound message (or a direct Response, e.g. a verification challenge). */
  parse(req: Request): Promise<Inbound | Response>;
  /** Deliver the reply (for push channels); return value becomes the HTTP response body when defined. */
  reply(msg: Inbound, text: string): Promise<Response | undefined>;
}

/** Generic JSON webhook channel: POST {session, text} -> {text}. Also the mock channel for tests (crabline role). */
export const webhookChannel = (id = "webhook"): Channel => ({
  id,
  async parse(req) {
    const j: any = await req.json();
    return {
      channel: id,
      session: String(j.session ?? "default"),
      text: String(j.text ?? ""),
      user: j.user,
    };
  },
  async reply(_m, text) {
    return Response.json({ text });
  },
});

export type GatewayOptions = {
  home: string;
  model: LanguageModel;
  cwd?: string;
  port?: number;
  hostname?: string;
  token?: string;
  channels?: Channel[];
  name?: string;
  allowShell?: boolean;
  /** Idle sessions are dropped after this many ms (default 1 h). */
  sessionTtlMs?: number;
  /** At most this many sessions are kept; the least recently used goes first (default 1000). */
  maxSessions?: number;
  /** Messages kept per session history (default 200), cut at a user turn boundary. */
  maxHistory?: number;
  /** Agent turns running at once across all sessions; beyond it requests get HTTP 429 (default 16). */
  maxConcurrentTurns?: number;
  /** Turns waiting behind a running one in the same session; beyond it HTTP 429 (default 4). */
  maxQueuedPerSession?: number;
};

export class Busy extends Error {}

/** Text of an OpenAI message content: a string or an array of parts (`{type:"text", text}`). */
export const extractText = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";

/** OpenAI chat messages -> agent history (system/user/assistant text; tool traffic of other runtimes dropped). */
export const toHistory = (msgs: any[]): Message[] =>
  msgs.flatMap((m): Message[] =>
    m?.role === "user" || m?.role === "assistant" || m?.role === "system"
      ? [{ role: m.role, content: extractText(m.content) }]
      : [],
  );

/** Drop the oldest messages down to `max`, starting at a user message so no tool result loses its tool call. */
export function trimHistory(history: Message[], max: number) {
  if (history.length <= max) return;
  let cut = history.length - max;
  while (cut < history.length && history[cut]!.role !== "user") cut++;
  if (cut >= history.length)
    cut = Math.max(
      0,
      history.findLastIndex((m) => m.role === "user"),
    );
  history.splice(0, cut);
}

export function createGateway(o: GatewayOptions) {
  const sessions = new Map<string, Message[]>();
  const seen = new Map<string, number>(); // session -> last use (insertion order = LRU order)
  const ttl = o.sessionTtlMs ?? 3_600_000;
  const maxSessions = o.maxSessions ?? 1000;
  const maxHistory = o.maxHistory ?? 200;
  const maxActive = o.maxConcurrentTurns ?? 16;
  const maxQueued = o.maxQueuedPerSession ?? 4;
  let active = 0;
  const waiting = new Map<string, number>(); // session -> turns engaged (running + queued)
  const release = (session: string) => {
    const left = (waiting.get(session) ?? 1) - 1;
    if (left > 0) waiting.set(session, left);
    else waiting.delete(session);
  };
  const touch = (session: string) => {
    seen.delete(session);
    seen.set(session, Date.now());
  };
  const evict = (now = Date.now()) => {
    for (const [id, at] of seen) {
      if (now - at <= ttl && seen.size <= maxSessions) break;
      if (queue.has(id)) continue; // never drop a session with a turn in flight
      seen.delete(id);
      sessions.delete(id);
    }
  };
  // Keep one memory store open for the gateway's lifetime (shared with every turn).
  const memory = Memory.acquire(layout(o.home).memoryDb);
  const sweep = setInterval(evict, Math.min(ttl, 60_000));
  let stopped = false;
  sweep.unref?.();
  const channels = new Map(
    (o.channels ?? [webhookChannel()]).map((c) => [c.id, c]),
  );
  const queue = new Map<string, Promise<unknown>>(); // serialize turns per session
  /** One agent turn. `ephemeral`: not kept after the reply, history seeded by the caller, cancelled with `signal`. */
  const turn = (
    session: string,
    text: string,
    opts: {
      ephemeral?: boolean;
      history?: Message[];
      signal?: AbortSignal;
    } = {},
  ) => {
    // Turns engaged on the session: one running plus at most maxQueued waiting.
    const pending = (waiting.get(session) ?? 0) + 1;
    if (pending > maxQueued + 1)
      return Promise.reject(new Busy("session queue full"));
    waiting.set(session, pending);
    const prev = queue.get(session) ?? Promise.resolve();
    const next = prev.then(async () => {
      // The global slot is taken when the turn really starts, not while it waits in its session queue.
      if (active >= maxActive) {
        release(session);
        throw new Busy("too many turns");
      }
      active++;
      touch(session);
      evict();
      const history = opts.history ?? sessions.get(session) ?? [];
      if (!opts.ephemeral) sessions.set(session, history);
      trimHistory(history, maxHistory); // also bounds the history a stateless client sends
      try {
        const r = await run({
          task: text,
          model: o.model,
          home: o.home,
          cwd: o.cwd ?? o.home,
          history,
          allowShell: o.allowShell,
          signal: opts.signal,
        });
        trimHistory(history, maxHistory);
        return r.text;
      } finally {
        active--;
        release(session);
        if (opts.ephemeral) seen.delete(session);
        else touch(session); // idle time counts from the end of the turn
      }
    });
    const settled = next
      .catch(() => {})
      .finally(() => {
        if (queue.get(session) === settled) queue.delete(session);
      });
    queue.set(session, settled);
    return next;
  };
  // Fixed-length digests: the comparison leaks neither content nor token length.
  const sha256 = (s: string) =>
    new Bun.CryptoHasher("sha256").update(s).digest();
  const same = (a: string | null, b: string) =>
    a !== null && timingSafeEqual(sha256(a), sha256(b));
  const bad = (msg: string) =>
    Response.json(
      { error: { message: msg, type: "invalid_request_error" } },
      { status: 400 },
    );
  const busy = () => new Response("too many concurrent turns", { status: 429 });
  // Without a token the gateway trusts the loopback only, so a page of another site must not reach it
  // (CSRF / WebSocket hijacking): any Origin header must be a loopback origin.
  const localOrigin = (req: Request) => {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    const host = URL.parse(origin)?.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  };
  const authed = (req: Request) =>
    o.token
      ? same(req.headers.get("authorization"), `Bearer ${o.token}`)
      : localOrigin(req);

  const server = Bun.serve<{ session: string }>({
    // Agent turns outlast the default 10 s idle timeout.
    idleTimeout: 255,
    port: o.port ?? 0,
    hostname: o.hostname ?? "127.0.0.1",
    routes: {
      "/health": () => Response.json({ ok: true, sessions: sessions.size }),
      "/v1/chat/completions": {
        POST: async (req: Bun.BunRequest<"/v1/chat/completions">) => {
          if (!authed(req))
            return new Response("unauthorized", { status: 401 });
          let j: any;
          try {
            j = await req.json();
          } catch {
            return bad("body is not JSON");
          }
          if (!j || typeof j !== "object" || !Array.isArray(j.messages))
            return bad("messages must be an array");
          if (j.stream === true) return bad("stream is not supported");
          const last = j.messages.at(-1);
          const prompt = last?.role === "user" ? extractText(last.content) : "";
          if (prompt === "" && last?.role === "user")
            return bad("empty user message");
          if (last?.role !== "user")
            return bad("the last message must be from the user");
          // Without `user` or `x-session` the turn is ephemeral: no history shared between clients.
          const named = j.user ?? req.headers.get("x-session");
          const session = named
            ? `openai:${String(named)}`
            : `openai-ephemeral:${crypto.randomUUID()}`;
          let text: string;
          try {
            // Stateless clients send the whole conversation: it seeds the history of the ephemeral turn.
            text = await turn(
              session,
              prompt,
              named
                ? {}
                : {
                    ephemeral: true,
                    history: toHistory(j.messages.slice(0, -1)),
                    signal: req.signal,
                  },
            );
          } catch (e) {
            if (e instanceof Busy) return busy();
            if (req.signal.aborted) return new Response(null, { status: 499 });
            throw e;
          }
          return Response.json({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: j.model ?? "agent",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
          });
        },
      },
      "/channels/:id": {
        POST: async (req: Bun.BunRequest<"/channels/:id">) => {
          const ch = channels.get(req.params.id);
          if (!ch) return new Response("unknown channel", { status: 404 });
          if (!(ch.verify ? await ch.verify(req.clone()) : authed(req)))
            return new Response("unauthorized", { status: 401 });
          let msg: Inbound | Response;
          try {
            msg = await ch.parse(req);
          } catch {
            return new Response("bad request", { status: 400 });
          }
          if (msg instanceof Response) return msg;
          if (!msg.text) return new Response("empty message", { status: 400 });
          let text: string;
          try {
            text = await turn(`${ch.id}:${msg.session}`, msg.text);
          } catch (e) {
            if (e instanceof Busy) return busy();
            throw e;
          }
          return (
            (await ch.reply(msg, text)) ?? new Response(null, { status: 204 })
          );
        },
      },
    },
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") {
        if (!o.token && !localOrigin(req))
          return new Response("forbidden origin", { status: 403 });
        if (
          !authed(req) &&
          !same(new URL(req.url).searchParams.get("token"), o.token ?? "")
        )
          return new Response("unauthorized", { status: 401 });
        if (srv.upgrade(req, { data: { session: crypto.randomUUID() } }))
          return undefined;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      async message(ws, raw) {
        let f: any;
        try {
          f = JSON.parse(String(raw));
        } catch {
          return void ws.send(
            JSON.stringify({ type: "error", error: "bad json" }),
          );
        }
        if (!f || typeof f !== "object" || f.type !== "message")
          return void ws.send(
            JSON.stringify({ type: "error", error: "unknown frame" }),
          );
        const session = String(f.session ?? ws.data.session);
        ws.send(JSON.stringify({ type: "ack", session }));
        try {
          ws.send(
            JSON.stringify({
              type: "reply",
              session,
              text: await turn(`ws:${session}`, String(f.text ?? "")),
            }),
          );
        } catch (e) {
          ws.send(
            JSON.stringify({
              type: "error",
              session,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      },
    },
  });
  return {
    server,
    url: server.url,
    sessions,
    evict,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(sweep);
      Memory.release(memory);
      return server.stop(true);
    },
  };
}
