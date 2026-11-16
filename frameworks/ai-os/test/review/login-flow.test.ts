// Sign-in flow against a fixture page: the window watches the session and closes itself once signed in; a review that
// found no session waits for that sign-in, then resumes. Real headless Chrome over CDP, no toast, nothing typed.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession } from "../../../../system/env-kit/src/auth-paths.ts";
import { browserInfo, chromePath, closeBrowser } from "../../src/relay/cdp.ts";
import { signInGeminiWeb } from "../../src/relay/web-login.ts";
import { geminiWebAsk } from "../../src/review/gemini-web.ts";
import { DEFAULT_SCHEMA } from "../../src/review/schema.ts";

setDefaultTimeout(90_000);

const state = { signedIn: false };
const review = JSON.stringify({
  score: 15,
  verdict: "changes",
  findings: [],
  to_confirm: [],
  summary: "ok",
});
const page = () => `<!doctype html><meta charset="utf-8"><body>
${state.signedIn ? "" : '<a id="si" href="#">Sign in</a>'}
<button id="mp" aria-label="Open mode picker, currently 3.5 Flash-Lite">3.5 Flash-Lite</button>
<div id="menu" class="cdk-overlay-container" hidden><gem-menu-item role="menuitemradio">Most complex work 4 Carbon</gem-menu-item></div>
<div id="chat"></div>
<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
<button id="send" aria-label="Send message" disabled>Send</button>
<script>
const $ = (s) => document.querySelector(s);
const ed = $(".ql-editor"), send = $("#send"), menu = $("#menu");
setInterval(async () => { if ((await (await fetch("/__state")).text()) === "1") $("#si")?.remove(); }, 300);
ed.addEventListener("input", () => (send.disabled = !ed.innerText.trim()));
$("#mp").onclick = () => (menu.hidden = !menu.hidden);
for (const it of document.querySelectorAll('[role="menuitemradio"]')) it.onclick = () => { $("#mp").setAttribute("aria-label", "Open mode picker, currently 4 Carbon"); menu.hidden = true; };
send.onclick = () => { ed.innerText = ""; const r = document.createElement("model-response"); const c = document.createElement("message-content"); c.innerText = ${JSON.stringify("```json\n" + review + "\n```")}; r.append(c); $("#chat").append(r); history.replaceState(null, "", "/app/chat9"); };
</script>`;

let server: ReturnType<typeof Bun.serve>;
let chrome = true;
let home = "";
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
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/__state")
        return new Response(state.signedIn ? "1" : "0");
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
  home = mkdtempSync(join(tmpdir(), "gw-login-"));
  for (const k of ["RELAY_HOME", "RELAY_CDP_PORT", "AY_AUTH_STATE"])
    saved[k] = Bun.env[k];
  Bun.env.RELAY_HOME = home;
  Bun.env.RELAY_CDP_PORT = String(cdp);
  Bun.env.AY_AUTH_STATE = join(home, "auth");
});
afterAll(async () => {
  if (!chrome) return;
  await closeBrowser();
  server.stop(true);
  for (const k of Object.keys(saved))
    saved[k] === undefined ? delete Bun.env[k] : (Bun.env[k] = saved[k]);
  await Bun.sleep(300);
  rmSync(home, { recursive: true, force: true });
});

test("the window watches the session and closes by itself once signed in", async () => {
  if (!chrome) return;
  state.signedIn = false;
  const base = `http://127.0.0.1:${server.port}`;
  setTimeout(() => (state.signedIn = true), 4000);
  const r = await signInGeminiWeb({
    origin: base,
    url: `${base}/app`,
    headless: true,
    pollMs: 400,
    timeoutMs: 60_000,
  });
  expect(r.ok).toBe(true);
  expect(readSession("gemini-web")?.ok).toBe(true);
  expect(await browserInfo()).toBeNull(); // the window is gone
});

test("sign-in not completed: the window closes at the timeout and the state says so", async () => {
  if (!chrome) return;
  state.signedIn = false;
  const base = `http://127.0.0.1:${server.port}`;
  const r = await signInGeminiWeb({
    origin: base,
    url: `${base}/app`,
    headless: true,
    pollMs: 300,
    timeoutMs: 4000,
  });
  expect(r.ok).toBe(false);
  expect(readSession("gemini-web")?.ok).toBe(false);
  expect(await browserInfo()).toBeNull();
});

test("a review without a session raises the notification, waits for the sign-in, then resumes", async () => {
  if (!chrome) return;
  state.signedIn = false;
  const base = `http://127.0.0.1:${server.port}`;
  let raised = 0;
  const { writeSession } =
    await import("../../../../system/env-kit/src/auth-paths.ts");
  const r = await geminiWebAsk("Review.", {
    base,
    loginWaitMs: 60_000,
    timeoutMs: 30_000,
    stopWaitMs: 8_000,
    schema: DEFAULT_SCHEMA,
    raiseLogin: () => {
      raised++;
      // the owner's click, sign-in and the flow's marker, simulated
      setTimeout(() => {
        state.signedIn = true;
        writeSession("gemini-web", true, "signed in");
      }, 3000);
    },
  });
  expect(raised).toBe(1);
  expect(r).toMatchObject({ ok: true, chatId: "chat9" });
});
