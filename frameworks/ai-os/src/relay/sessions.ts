// Bidirectional messaging between agent sessions (Claude Code, Codex, agy, OpenCode, Pi, ...) through the relay.
// Store: bun:sqlite in <relayHome>/sessions/sessions.db (WAL, shared by the relay and the Claude Code hooks).
// A recipient with unread mail has <relayHome>/sessions/<id>.pending, so hooks test one file before starting bun.
// Surfaces:
//   MCP tools session_register / session_list / session_send / session_inbox
//   A2A skill session_send: the task stays WORKING until the recipient replies, and the reply is the artifact
//   Claude Code hooks (session-hook.ts) register the session and inject its mail at each tool call, prompt and stop
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relayHome } from "./cdp.ts";

export type Session = {
  id: string;
  name: string;
  kind: string;
  cwd: string;
  seen: number;
};
export type Message = {
  id: string;
  sender: string;
  recipient: string;
  thread: string;
  reply_to: string | null;
  text: string;
  created: number;
  delivered: number | null;
};

export const sessionsDir = () => join(relayHome(), "sessions");
const pendingFile = (id: string) => join(sessionsDir(), `${id}.pending`);

let db: Database | undefined;
function open(): Database {
  if (db) return db;
  mkdirSync(sessionsDir(), { recursive: true });
  db = new Database(join(sessionsDir(), "sessions.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, cwd TEXT NOT NULL, seen INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, thread TEXT NOT NULL,
    reply_to TEXT, text TEXT NOT NULL, created INTEGER NOT NULL, delivered INTEGER)`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS messages_inbox ON messages (recipient, delivered)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS messages_reply ON messages (reply_to)");
  return db;
}

/** Test hook: point the store at another directory (RELAY_HOME) and drop the open handle. */
export function resetStore() {
  db?.close();
  db = undefined;
}

const short = (id: string) => id.replace(/[^A-Za-z0-9]/g, "").slice(0, 6);

/** Register or refresh a session. The name defaults to <kind>-<cwd basename>-<id prefix>, unique. */
export function register(
  id: string,
  kind = "agent",
  cwd = "",
  name?: string,
): Session {
  const d = open();
  const now = Date.now();
  const prev = d
    .query<Session, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(id);
  const base = (cwd.split(/[\\/]/).filter(Boolean).pop() ?? "x").toLowerCase();
  let want = name ?? prev?.name ?? `${kind}-${base}-${short(id)}`;
  const taken = d
    .query<{ id: string }, [string]>("SELECT id FROM sessions WHERE name = ?")
    .get(want);
  if (taken && taken.id !== id) want = `${want}-${short(id)}`;
  d.query(
    `INSERT INTO sessions (id, name, kind, cwd, seen) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET name = ?2, kind = ?3, cwd = CASE WHEN ?4 = '' THEN cwd ELSE ?4 END, seen = ?5`,
  ).run(id, want, kind, cwd, now);
  return d
    .query<Session, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(id)!;
}

/** Sessions seen in the last `withinMs` (default 24 h), most recent first. */
export function list(withinMs = 86_400_000): Session[] {
  return open()
    .query<Session, [number]>(
      "SELECT * FROM sessions WHERE seen >= ? ORDER BY seen DESC",
    )
    .all(Date.now() - withinMs);
}

/** Resolve a session by exact id, exact name, or a unique id/name prefix. */
export function resolve(who: string): Session {
  const d = open();
  const exact = d
    .query<Session, [string, string]>(
      "SELECT * FROM sessions WHERE id = ? OR name = ?",
    )
    .get(who, who);
  if (exact) return exact;
  const like = d
    .query<Session, [string, string]>(
      "SELECT * FROM sessions WHERE id LIKE ? OR name LIKE ?",
    )
    .all(`${who}%`, `${who}%`);
  if (like.length === 1) return like[0]!;
  if (!like.length)
    throw new Error(
      `unknown session: ${who} (session_list shows the live ones)`,
    );
  throw new Error(
    `ambiguous session ${who}: ${like.map((s) => s.name).join(", ")}`,
  );
}

/** Queue a message. A reply (reply_to) stays in the thread of the message it answers. */
export function send(
  from: string,
  to: string,
  text: string,
  replyTo?: string,
): Message {
  const d = open();
  const s = resolve(from);
  const r = resolve(to);
  const parent = replyTo
    ? d
        .query<Message, [string]>("SELECT * FROM messages WHERE id = ?")
        .get(replyTo)
    : null;
  if (replyTo && !parent)
    throw new Error(`unknown message to reply to: ${replyTo}`);
  const m: Message = {
    id: crypto.randomUUID(),
    sender: s.id,
    recipient: r.id,
    thread: parent?.thread ?? crypto.randomUUID(),
    reply_to: replyTo ?? null,
    text,
    created: Date.now(),
    delivered: null,
  };
  d.query(
    "INSERT INTO messages (id, sender, recipient, thread, reply_to, text, created, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(m.id, m.sender, m.recipient, m.thread, m.reply_to, m.text, m.created);
  writeFileSync(pendingFile(r.id), String(m.created));
  return m;
}

/** Unread mail of a session; marks it delivered unless peek. Clears the pending flag when empty. */
export function inbox(
  who: string,
  peek = false,
): (Message & { from_name: string })[] {
  const d = open();
  const me = resolve(who);
  const rows = d
    .query<Message & { from_name: string }, [string]>(
      `SELECT m.*, s.name AS from_name FROM messages m JOIN sessions s ON s.id = m.sender
       WHERE m.recipient = ? AND m.delivered IS NULL ORDER BY m.created`,
    )
    .all(me.id);
  if (!peek) {
    const now = Date.now();
    const mark = d.query("UPDATE messages SET delivered = ? WHERE id = ?");
    d.transaction(() => rows.forEach((m) => mark.run(now, m.id)))();
    if (existsSync(pendingFile(me.id)))
      rmSync(pendingFile(me.id), { force: true });
  }
  d.query("UPDATE sessions SET seen = ? WHERE id = ?").run(Date.now(), me.id);
  return rows;
}

/** Wait for the reply to `messageId` (polling the store), up to timeoutMs. */
export async function waitReply(
  messageId: string,
  timeoutMs: number,
): Promise<Message | null> {
  const d = open();
  const q = d.query<Message, [string]>(
    "SELECT * FROM messages WHERE reply_to = ? ORDER BY created LIMIT 1",
  );
  const end = Date.now() + timeoutMs;
  for (;;) {
    const m = q.get(messageId);
    if (m) {
      d.query(
        "UPDATE messages SET delivered = COALESCE(delivered, ?) WHERE id = ?",
      ).run(Date.now(), m.id);
      return m;
    }
    if (Date.now() >= end) return null;
    await Bun.sleep(500);
  }
}

/** Plain-text rendering of mail for injection into an agent's context. */
export function render(
  rows: (Message & { from_name: string })[],
  me: Session,
): string {
  if (!rows.length) return "";
  const lines = rows.map(
    (m) =>
      `- from ${m.from_name} [message ${m.id}${m.reply_to ? `, reply to ${m.reply_to}` : ""}]: ${m.text}`,
  );
  return [
    `Relay mail for session ${me.name} (${rows.length}):`,
    ...lines,
    `Answer with the relay tool session_send {from: "${me.name}", to: <sender>, text, reply_to: <message id>}.`,
  ].join("\n");
}
