// Agent Client Protocol v1 (agentclientprotocol schema-v1.31.0: schema/v1/schema.json, docs/protocol/v1) over stdio:
// an ACP client (editor, Hermes, OpenClaw acpx) uses Gemini (or headless Claude Code) as the agent.
//   initialize (version negotiation), session/new, session/load (replays history as session/update),
//   session/list, session/prompt (agent_message_chunk puis stopReason end_turn), session/cancel (stopReason cancelled).
// Engine per session: _meta.engine "claude", _meta.model (or RELAY_ACP_MODEL) = discovered provider/model
// (llm_models, session history carried into the prompt), otherwise Gemini.
// Sessions persisted in the relay folder (acp-sessions.json): Gemini conversation, cwd, history.
// ACP error codes: -32700 invalid JSON, -32602 parameters, -32002 missing session, -32603 internal failure
// (-32000 means "authentication required" in ACP and is not used for an engine failure).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { llmAsk } from "../llm/model.ts";
import { listModels } from "../llm/models.ts";
import { claude, gemini, opencode } from "./backends.ts";
import { relayHome } from "./cdp.ts";
import { VERSION } from "./protocols.ts";

export const ACP_PROTOCOL_VERSION = 1;

type Msg = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: any;
};
type Turn = { role: "user" | "agent"; text: string };
type Session = {
  cwd: string;
  engine: "gemini" | "claude" | "opencode" | "llm";
  model?: string;
  chat?: string;
  title?: string;
  updatedAt: string;
  history: Turn[];
};

const store = () => join(Bun.env.ACP_HOME ?? relayHome(), "acp-sessions.json");
let sessions: Map<string, Session> | undefined;
const load = () => {
  if (sessions) return sessions;
  try {
    sessions = new Map(
      Object.entries(JSON.parse(readFileSync(store(), "utf8"))),
    );
  } catch {
    sessions = new Map();
  }
  return sessions;
};
const save = () => {
  const f = store();
  const dir = join(f, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify(Object.fromEntries(load())));
};
/** Turn in progress per session: session/cancel ends it with stopReason "cancelled". */
const pending = new Map<string, () => void>();

export type Out = (m: unknown) => void;

/** Stateless model: the session's last turns precede the request. */
const withHistory = (h: Turn[], prompt: string) =>
  h.length
    ? `${h
        .slice(-20)
        .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
        .join("\n\n")}\n\nUser: ${prompt}`
    : prompt;

/** cwd and mcpServers are required by NewSessionRequest and LoadSessionRequest; cwd must be absolute. */
const badSetup = (p: any) =>
  typeof p?.cwd !== "string" || !isAbsolute(p.cwd)
    ? "cwd : chemin absolu requis"
    : !Array.isArray(p?.mcpServers)
      ? "mcpServers : tableau requis"
      : undefined;

const promptText = (blocks: any[]) =>
  blocks
    .map((b) =>
      b?.type === "text"
        ? b.text
        : b?.type === "resource"
          ? `\n[${b.resource?.uri}]\n${b.resource?.text ?? ""}`
          : b?.type === "resource_link"
            ? `[${b.uri}]`
            : "",
    )
    .join("\n");

export async function handle(m: Msg, write: Out) {
  const reply = (result: unknown) =>
    write({ jsonrpc: "2.0", id: m.id, result });
  const error = (code: number, message: string) =>
    write({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  const p = m.params ?? {};
  const update = (sessionId: string, u: Record<string, unknown>) =>
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: u },
    });
  switch (m.method) {
    case "initialize": {
      if (!Number.isInteger(p.protocolVersion))
        return error(-32602, "protocolVersion : entier requis");
      return reply({
        protocolVersion: Math.min(p.protocolVersion, ACP_PROTOCOL_VERSION),
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: true,
          },
          sessionCapabilities: { list: {} },
        },
        authMethods: [],
        agentInfo: { name: "aphrody-relay", version: VERSION },
      });
    }
    case "session/new": {
      const bad = badSetup(p);
      if (bad) return error(-32602, bad);
      const id = crypto.randomUUID();
      const eng = p._meta?.engine;
      let modelSpec = p._meta?.model ?? Bun.env.RELAY_ACP_MODEL;
      if (eng === "openrouter" && !modelSpec) {
        const discovered = await listModels().catch(() => []);
        modelSpec =
          discovered.find((g) => g.provider === "openrouter")?.models[0]?.id ??
          "openrouter/auto";
      }
      load().set(id, {
        cwd: p.cwd,
        ...(eng === "claude"
          ? { engine: "claude" as const }
          : eng === "opencode"
            ? {
                engine: "opencode" as const,
                ...(modelSpec ? { model: String(modelSpec) } : {}),
              }
            : modelSpec || eng === "openrouter"
              ? {
                  engine: "llm" as const,
                  model: String(modelSpec),
                }
              : { engine: "gemini" as const }),
        updatedAt: new Date().toISOString(),
        history: [],
      });
      save();
      return reply({ sessionId: id });
    }
    case "session/load": {
      const bad = badSetup(p);
      if (bad) return error(-32602, bad);
      const s = load().get(p.sessionId);
      if (!s) return error(-32002, `unknown session: ${p.sessionId}`);
      for (const t of s.history)
        update(p.sessionId, {
          sessionUpdate:
            t.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: t.text },
        });
      return reply({});
    }
    case "session/list": {
      const list = [...load()]
        .filter(([, s]) => !p.cwd || s.cwd === p.cwd)
        .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
        .map(([sessionId, s]) => ({
          sessionId,
          cwd: s.cwd,
          updatedAt: s.updatedAt,
          ...(s.title ? { title: s.title } : {}),
        }));
      return reply({ sessions: list });
    }
    case "session/prompt": {
      const id = p.sessionId;
      const s = load().get(id);
      if (!s) return error(-32002, `unknown session: ${id}`);
      if (!Array.isArray(p.prompt))
        return error(-32602, "prompt : tableau de blocs requis");
      if (pending.has(id))
        return error(-32602, "a turn is already in progress for this session");
      const prompt = promptText(p.prompt);
      let cancelled = false;
      const done = new Promise<void>((r) =>
        pending.set(id, () => {
          cancelled = true;
          r();
        }),
      );
      try {
        const run =
          s.engine === "claude"
            ? claude(prompt)
            : s.engine === "opencode"
              ? opencode(withHistory(s.history, prompt), s.model)
              : s.engine === "llm"
                ? llmAsk(s.model!, withHistory(s.history, prompt))
                : gemini(prompt, { chat: s.chat });
        const a = await Promise.race([run, done.then(() => null)]);
        if (cancelled || !a) {
          run.catch(() => {});
          return reply({ stopReason: "cancelled" });
        }
        if ("chat" in a && a.chat) s.chat = a.chat;
        s.title ??= prompt.slice(0, 80);
        s.history.push(
          { role: "user", text: prompt },
          { role: "agent", text: a.text },
        );
        s.updatedAt = new Date().toISOString();
        save();
        update(id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: a.text },
        });
        return reply({ stopReason: "end_turn" });
      } catch (e: any) {
        return cancelled
          ? reply({ stopReason: "cancelled" })
          : error(-32603, String(e?.message ?? e));
      } finally {
        pending.delete(id);
      }
    }
    case "session/cancel":
      pending.get(p.sessionId)?.();
      return;
    default:
      if (m.id !== undefined)
        return error(-32601, `unsupported ACP method: ${m.method}`);
  }
}

export async function acp() {
  const write: Out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += Buffer.from(chunk).toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: Msg;
      try {
        m = JSON.parse(line);
      } catch {
        write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        continue;
      }
      handle(m, write).catch((e) => process.stderr.write(`${e}\n`));
    }
  }
}
