// MCP / A2A / RPC tools over the session mailbox (sessions.ts): any agent with the relay MCP can talk to any
// other registered session, both ways. `from` is the caller's own session name or id (the Claude Code
// SessionStart hook tells each session its name).
import { s } from "../llm/schema.ts";
import {
  inbox,
  list,
  register,
  render,
  resolve,
  send,
  waitReply,
} from "./sessions.ts";
import type { Tool } from "./tools.ts";

const str = s.string;
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

export const SESSION_TOOLS: Tool[] = [
  {
    name: "session_register",
    description:
      "Register (or rename) an agent session in the relay mailbox. Claude Code sessions are registered by their SessionStart hook; other agents (Codex, agy, OpenCode, Pi) call this once with a stable id.",
    inputSchema: obj(
      {
        id: str("stable session id"),
        name: str("unique human name (optional)"),
        kind: str(
          "claude-code | codex | agy | opencode | pi | other (optional)",
        ),
        cwd: str("working directory (optional)"),
      },
      ["id"],
    ),
    readOnly: false,
    run: async (a) =>
      register(String(a.id), a.kind ?? "agent", a.cwd ?? "", a.name),
  },
  {
    name: "session_list",
    description:
      "Sessions seen by the relay mailbox in the last 24 h (name, kind, cwd, last seen).",
    inputSchema: obj({}),
    readOnly: true,
    run: async () =>
      list().map((x) => ({
        name: x.name,
        id: x.id,
        kind: x.kind,
        cwd: x.cwd,
        seen: new Date(x.seen).toISOString(),
      })),
  },
  {
    name: "session_send",
    description:
      "Send a message to another session (name, id or unique prefix). reply_to answers a received message in its thread. wait_s > 0 blocks until the recipient replies (max 600) and returns the reply: a synchronous request/response between two sessions.",
    inputSchema: obj(
      {
        from: str("your own session name or id"),
        to: str("recipient session name or id"),
        text: str("message"),
        reply_to: str("id of the message you answer (optional)"),
        wait_s: {
          type: "number",
          description:
            "seconds to wait for the reply (optional, 0 = do not wait)",
        },
      },
      ["from", "to", "text"],
    ),
    readOnly: false,
    run: async (a) => {
      const m = send(String(a.from), String(a.to), String(a.text), a.reply_to);
      const wait = Math.min(Math.max(Number(a.wait_s ?? 0), 0), 600);
      if (!wait) return { sent: m.id, thread: m.thread };
      const r = await waitReply(m.id, wait * 1000);
      return r
        ? {
            sent: m.id,
            thread: m.thread,
            reply: { id: r.id, from: resolve(r.sender).name, text: r.text },
          }
        : {
            sent: m.id,
            thread: m.thread,
            reply: null,
            note: `no reply within ${wait} s`,
          };
    },
  },
  {
    name: "session_inbox",
    description:
      "Unread messages of a session (marks them read unless peek). Returns the rendered mail and the rows.",
    inputSchema: obj(
      {
        session: str("your own session name or id"),
        peek: { type: "boolean", description: "do not mark read (optional)" },
      },
      ["session"],
    ),
    readOnly: false,
    run: async (a) => {
      const me = resolve(String(a.session));
      const rows = inbox(me.id, Boolean(a.peek));
      return { text: render(rows, me), messages: rows };
    },
  },
];
