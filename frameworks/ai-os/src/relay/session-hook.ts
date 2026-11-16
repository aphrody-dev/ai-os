// Claude Code hooks for the relay session mailbox (sessions.ts).
//   start   (SessionStart)                 register the session, tell it its name, inject pending mail
//   deliver (PostToolUse, UserPromptSubmit) inject pending mail as additionalContext
//   stop    (Stop)                          block stopping while mail is pending, so the session answers it
// The settings.json commands test <relayHome>/sessions/<session_id>.pending in shell before starting bun
// for deliver/stop, so an empty inbox costs no bun spawn.
import { inbox, register, render, resolve } from "./sessions.ts";

const mode = Bun.argv[2] ?? "deliver";
const payload = JSON.parse((await Bun.stdin.text()) || "{}") as {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
};
const id = payload.session_id;
if (!id) process.exit(0);

const out = (o: unknown) => process.stdout.write(JSON.stringify(o));

if (mode === "start") {
  const me = register(id, "claude-code", payload.cwd ?? "");
  const mail = render(inbox(me.id), me);
  out({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        `Relay mailbox: this session is "${me.name}". Other sessions and agents reach it by that name.`,
        "Relay tools: session_list, session_send {from, to, text, reply_to?, wait_s?}, session_inbox {session}. Use your own name as from/session.",
        mail,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  });
} else {
  let me;
  try {
    me = resolve(id);
  } catch {
    me = register(id, "claude-code", payload.cwd ?? "");
  }
  const mail = render(inbox(me.id), me);
  if (!mail) process.exit(0);
  if (mode === "stop") out({ decision: "block", reason: mail });
  else
    out({
      hookSpecificOutput: {
        hookEventName: payload.hook_event_name ?? "PostToolUse",
        additionalContext: mail,
      },
    });
}
