// gemini-web engine against a local HTML fixture that mimics the page (mode picker, editor, send and stop buttons,
// model-response message-content) in the relay's real headless Chrome over CDP. Offline; skipped without Chrome.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(90_000);
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, closeBrowser } from "../../src/relay/cdp.ts";
import { inline } from "../../src/orch/inline.ts";
import {
  frame,
  geminiWebAsk,
  LOGIN_COMMAND,
  pickAnswer,
  selftest,
  SELECTORS,
  splitMessage,
} from "../../src/review/gemini-web.ts";
import { DEFAULT_SCHEMA } from "../../src/review/schema.ts";

const review = {
  score: 14,
  verdict: "changes",
  findings: [
    {
      file: "a.ts",
      line: 2,
      severity: "low",
      title: "naming",
      breaks: "readability",
      fix: "rename",
      source: "-",
    },
  ],
  to_confirm: [],
  summary: "ok",
};
const fenced = (o: unknown = review) =>
  "Here is the review.\n```json\n" + JSON.stringify(o, null, 2) + "\n```";

// ---- fixture ---------------------------------------------------------------------------------------------------

const state = {
  signedIn: true,
  carbon: true,
  sendLabel: "Send message",
  replies: [] as string[],
  received: [] as string[],
};
const page = () => `<!doctype html><meta charset="utf-8"><title>fixture</title>
<body>
${state.signedIn ? "" : '<a href="#">Sign in</a>'}
<button id="mp" aria-label="Open mode picker, currently 3.5 Flash-Lite">3.5 Flash-Lite</button>
<div id="menu" class="cdk-overlay-container" hidden>
  <gem-menu-item role="menuitemradio">Everyday help 4 Hydrogen</gem-menu-item>
  <gem-menu-item role="menuitemradio">Code &amp; analysis 4 Argon</gem-menu-item>
  ${state.carbon ? '<gem-menu-item role="menuitemradio">Most complex work 4 Carbon New</gem-menu-item>' : ""}
  <gem-menu-item role="menuitem" id="think">High thinking</gem-menu-item>
</div>
<div id="chat"></div>
<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
<button id="send" aria-label="${state.sendLabel}" disabled>Send</button>
<button id="stop" aria-label="Stop response" hidden>Stop</button>
<script>
const $ = (s) => document.querySelector(s);
const ed = $(".ql-editor"), send = $("#send"), menu = $("#menu");
ed.addEventListener("input", () => (send.disabled = !ed.innerText.trim()));
$("#mp").onclick = () => (menu.hidden = !menu.hidden);
document.addEventListener("keydown", (e) => e.key === "Escape" && (menu.hidden = true));
for (const it of document.querySelectorAll('[role="menuitemradio"]'))
  it.onclick = () => {
    $("#mp").setAttribute("aria-label", "Open mode picker, currently " + it.innerText.replace(/^.*?(\\d)/, "$1"));
    menu.hidden = true;
  };
$("#think").onclick = () => { window.thought = true; menu.hidden = true; };
send.onclick = async () => {
  const text = ed.innerText;
  ed.innerText = ""; send.disabled = true;
  const r = document.createElement("model-response");
  const c = document.createElement("message-content");
  r.append(c); $("#chat").append(r);
  $("#stop").hidden = false;
  const reply = await (await fetch("/__reply", { method: "POST", body: text })).text();
  await new Promise((ok) => setTimeout(ok, 700));
  const m = reply.match(/\`\`\`json\\n([\\s\\S]*?)\`\`\`/);
  if (m) { const p = document.createElement("p"); p.textContent = "Here is the review."; const pre = document.createElement("pre"); pre.textContent = m[1]; c.append(p, pre); }
  else c.innerText = reply;
  history.replaceState(null, "", "/app/chat123");
  $("#stop").hidden = true;
};
</script>`;

let server: ReturnType<typeof Bun.serve>;
let home = "";
let chrome = true;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  try {
    chromePath();
  } catch {
    chrome = false;
    return;
  }
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/__reply") {
        state.received.push(await req.text());
        return new Response(state.replies.shift() ?? "RECEIVED");
      }
      return new Response(page(), { headers: { "content-type": "text/html" } });
    },
  });
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const cdp = probe.port;
  probe.stop(true);
  home = mkdtempSync(join(tmpdir(), "gw-relay-"));
  for (const k of ["RELAY_HOME", "RELAY_CDP_PORT"]) saved[k] = Bun.env[k];
  Bun.env.RELAY_HOME = home;
  Bun.env.RELAY_CDP_PORT = String(cdp);
});
afterAll(async () => {
  if (!chrome) return;
  await closeBrowser();
  server.stop(true);
  for (const k of Object.keys(saved))
    saved[k] === undefined ? delete Bun.env[k] : (Bun.env[k] = saved[k]);
  await Bun.sleep(300);
  rmSync(home, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  }); // Windows: Chrome releases its profile a moment after it exits
});

const opts = () => ({
  base: `http://127.0.0.1:${server.port}`,
  mode: "carbon",
  modeFallback: ["argon"],
  thinking: "high",
  timeoutMs: 30_000,
  stopWaitMs: 8_000,
  schema: DEFAULT_SCHEMA,
});
const reset = () => {
  state.signedIn = true;
  state.carbon = true;
  state.sendLabel = "Send message";
  state.replies = [];
  state.received = [];
};

// ---- pure helpers ----------------------------------------------------------------------------------------------

test("selector table: every selector has a reference; messages split at line boundaries and framed", () => {
  for (const s of Object.values(SELECTORS)) {
    expect(s.css.length).toBeGreaterThan(0);
    expect(s.ref.length).toBeGreaterThan(0);
  }
  const text = Array.from(
    { length: 10 },
    (_, i) => `line ${i} ${"x".repeat(20)}`,
  ).join("\n");
  const parts = splitMessage(text, 100);
  expect(parts.length).toBeGreaterThan(2);
  expect(parts.every((p) => p.length <= 100)).toBe(true);
  expect(parts.join("\n")).toBe(text);
  expect(splitMessage("short", 100)).toEqual(["short"]);
  expect(frame("p", 0, 3)).toContain("RECEIVED");
  expect(frame("p", 2, 3)).toContain("answer it now");
  expect(frame("p", 0, 1)).toBe("p");
  expect(
    pickAnswer(
      { text: "prose", code: ["nope", JSON.stringify(review)] },
      DEFAULT_SCHEMA,
    ),
  ).toBe(JSON.stringify(review));
});

// ---- engine over CDP -------------------------------------------------------------------------------------------

test("fresh chat, carbon mode, thinking level, fenced JSON parsed, chat id recorded", async () => {
  if (!chrome) return;
  reset();
  state.replies = [fenced()];
  const r = await geminiWebAsk("Review this. Return the JSON.", {
    ...opts(),
    screenshot: join(home, "proof.png"),
  });
  expect(
    Buffer.from(await Bun.file(join(home, "proof.png")).arrayBuffer())
      .subarray(1, 4)
      .toString(),
  ).toBe("PNG");
  expect(r).toMatchObject({ ok: true });
  expect(r.mode).toContain("Carbon");
  expect(r.chatId).toBe("chat123");
  expect(r.chat).toContain("/app/chat123");
  expect(JSON.parse(r.text).score).toBe(14);
  expect(state.received).toEqual(["Review this. Return the JSON."]);
  expect(r.notes).toEqual([]);
});

test("invalid JSON: one repair message in the same chat, then success", async () => {
  if (!chrome) return;
  reset();
  state.replies = ["I think it is fine.", fenced()];
  const r = await geminiWebAsk("Review.", opts());
  expect(r).toMatchObject({ ok: true });
  expect(state.received).toHaveLength(2);
  expect(state.received[1]).toContain("Return only valid JSON for this schema");
  expect(r.notes.join(" ")).toContain("repair");
});

test("invalid JSON twice: fails clearly after one repair", async () => {
  if (!chrome) return;
  reset();
  state.replies = ["nope", "still nope"];
  const r = await geminiWebAsk("Review.", opts());
  expect(r.ok).toBe(false);
  expect(r.cls).toBe("task");
  expect(r.text).toContain("invalid JSON after one repair message");
  expect(state.received).toHaveLength(2);
});

test("byte budget: a long prompt goes in several messages, only the last is answered", async () => {
  if (!chrome) return;
  reset();
  const prompt = Array.from(
    { length: 12 },
    (_, i) => `row ${i} ${"y".repeat(40)}`,
  ).join("\n");
  state.replies = ["RECEIVED", "RECEIVED", fenced()];
  const r = await geminiWebAsk(prompt, { ...opts(), maxMessageBytes: 250 });
  expect(r).toMatchObject({ ok: true });
  const n = state.received.length;
  expect(n).toBeGreaterThanOrEqual(3);
  expect(state.received[0]).toContain("part 1/");
  expect(state.received.at(-1)).toContain("the last");
  expect(r.notes.join(" ")).toContain("split into");
});

test("carbon absent: argon fallback; none selectable: explicit failure", async () => {
  if (!chrome) return;
  reset();
  state.carbon = false;
  state.replies = [fenced()];
  const r = await geminiWebAsk("Review.", opts());
  expect(r).toMatchObject({ ok: true });
  expect(r.mode).toContain("Argon");
  expect(r.notes.join(" ")).toContain("carbon unavailable");
  reset();
  state.carbon = false;
  const none = await geminiWebAsk("Review.", {
    ...opts(),
    modeFallback: ["zeta"],
  });
  expect(none.ok).toBe(false);
  expect(none.cls).toBe("missing");
  expect(none.text).toContain("none of the modes");
});

test("no Google session: health login with the exact owner command, nothing typed", async () => {
  if (!chrome) return;
  reset();
  state.signedIn = false;
  const r = await geminiWebAsk("Review.", opts());
  expect(r.ok).toBe(false);
  expect(r.cls).toBe("login");
  expect(r.text).toContain(LOGIN_COMMAND);
  expect(state.received).toHaveLength(0);
});

test("engine entry point (inline): web options, chat id and mode flow back to the tribunal", async () => {
  if (!chrome) return;
  reset();
  state.replies = [fenced()];
  const h = { id: "t", local: true, src: ".", roles: [], maxAgents: 1 };
  const r = await inline(h, "gemini-web", "Review.", 60_000, {
    schema: DEFAULT_SCHEMA,
    web: opts(),
  });
  expect(r).toMatchObject({ ok: true });
  expect(r.chatId).toBe("chat123");
  expect(r.mode).toContain("Carbon");
});

test("selftest: all selectors ok on the fixture, the broken one is named, login is reported", async () => {
  if (!chrome) return;
  reset();
  state.replies = ["OK"];
  const good = await selftest({ ...opts(), deep: true });
  expect(good.login).toBe(false);
  expect(good.checks.filter((c) => !c.ok && c.name !== "stop")).toEqual([]);
  expect(good.checks.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      "editor",
      "modePicker",
      "modeItem",
      "send",
      "response",
      "content",
    ]),
  );
  reset();
  state.sendLabel = "Submit now";
  state.replies = ["OK"];
  const broken = await selftest({ ...opts(), deep: true });
  expect(broken.ok).toBe(false);
  expect(broken.checks.filter((c) => !c.ok).map((c) => c.name)).toContain(
    "send",
  );
  reset();
  state.signedIn = false;
  const out = await selftest(opts());
  expect(out.login).toBe(true);
  expect(out.command).toBe(LOGIN_COMMAND);
});
