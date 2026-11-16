// Session mailbox round trip: two sessions, send, hook delivery, threaded reply, synchronous wait, stop block.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "relay-sessions-"));
process.env.RELAY_HOME = home;
const S = await import("../../src/relay/sessions.ts");
const { SESSION_TOOLS } = await import("../../src/relay/session-tools.ts");
const tool = (n: string) => SESSION_TOOLS.find((t) => t.name === n)!;
const hook = join(import.meta.dir, "../../src/relay/session-hook.ts");
const runHook = (mode: string, payload: object) => {
  const r = Bun.spawnSync(["bun", hook, mode], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: { ...process.env, RELAY_HOME: home },
  });
  const t = r.stdout.toString();
  return t ? JSON.parse(t) : null;
};

beforeAll(() => S.resetStore());
afterAll(() => {
  S.resetStore();
  rmSync(home, { recursive: true, force: true });
});

test("SessionStart hook registers and names the session", () => {
  const o = runHook("start", { session_id: "aaaa1111", cwd: "C:/aphrody" });
  expect(o.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(o.hookSpecificOutput.additionalContext).toContain(
    'this session is "claude-code-src-aaaa11"',
  );
  runHook("start", { session_id: "bbbb2222", cwd: "C:/aphrody" });
  S.resetStore();
  expect(
    S.list()
      .map((s) => s.name)
      .sort(),
  ).toEqual(["claude-code-src-aaaa11", "claude-code-src-bbbb22"]);
});

test("send, hook delivery, threaded synchronous reply", async () => {
  const pending = join(home, "sessions", "bbbb2222.pending");
  const ask = tool("session_send").run({
    from: "claude-code-src-aaaa11",
    to: "bbbb",
    text: "ping?",
    wait_s: 10,
  });
  await Bun.sleep(100);
  expect(existsSync(pending)).toBe(true);
  // B receives it at its next tool call through the PostToolUse hook
  const d = runHook("deliver", {
    session_id: "bbbb2222",
    hook_event_name: "PostToolUse",
  });
  expect(d.hookSpecificOutput.additionalContext).toContain("ping?");
  expect(existsSync(pending)).toBe(false);
  const msgId = /\[message ([0-9a-f-]+)/.exec(
    d.hookSpecificOutput.additionalContext,
  )![1]!;
  await tool("session_send").run({
    from: "bbbb2222",
    to: "claude-code-src-aaaa11",
    text: "pong",
    reply_to: msgId,
  });
  const r = (await ask) as any;
  expect(r.reply.text).toBe("pong");
  expect(r.reply.from).toBe("claude-code-src-bbbb22");
});

test("Stop hook blocks while mail is pending, then lets the session stop", async () => {
  await tool("session_send").run({
    from: "bbbb2222",
    to: "aaaa1111",
    text: "one more thing",
  });
  const o = runHook("stop", { session_id: "aaaa1111" });
  expect(o.decision).toBe("block");
  expect(o.reason).toContain("one more thing");
  expect(runHook("stop", { session_id: "aaaa1111" })).toBeNull();
});

test("unknown and ambiguous recipients are errors", () => {
  expect(() => S.send("aaaa1111", "zzzz", "x")).toThrow(/unknown session/);
  expect(() => S.send("aaaa1111", "claude-code-src", "x")).toThrow(/ambiguous/);
});
