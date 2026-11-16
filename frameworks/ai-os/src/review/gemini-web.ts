// gemini-web review engine: gemini.google.com driven headless over CDP in the relay's dedicated Chrome
// (relay/cdp.ts, profile under relayHome()/chrome, `--headless=new`; headful only for the first Google sign-in and for
// debugging). No claude-in-chrome, no credentials typed: the owner signs in once with
// the sign-in toast (env-kit auth daemon, one click) or `<binary> auth login gemini-web`; without a session the engine
// raises the toast and waits `loginWaitMs`, then reports health `login`.
//
// Every run starts a fresh chat, picks the model mode and thinking level from the config, inserts the prompt with
// Input.insertText (never a synthetic paste; over the byte budget it is split into several messages), sends, waits for
// the Stop button to appear and disappear, and reads the last `model-response message-content`. The answer must be one
// fenced JSON block following the review schema; one repair message is sent in the same chat before failing.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { launchBrowser, Tab } from "../relay/cdp.ts";
import { DEFAULT_SCHEMA, parseReview, type Schema } from "./schema.ts";

/** The only place page selectors live. `ref`: where the selector was surveyed. */
export type Selector = {
  css: string;
  ref: string;
  /** Present on the idle page (checked by the self-test without sending). */
  idle: boolean;
};
export const SELECTORS = {
  editor: {
    css: "rich-textarea .ql-editor",
    ref: "docs/gemini-web/RECON.md, Interface pilotée par le relais: Saisie",
    idle: true,
  },
  send: {
    css: 'button[aria-label="Send message"], button[aria-label="Envoyer un message"], button.send-button',
    ref: "docs/gemini-web/RECON.md: Envoi (enabled once the editor has text)",
    idle: false,
  },
  stop: {
    css: 'button[aria-label*="Stop" i], button[aria-label*="Arrêter" i]',
    ref: "docs/gemini-web/RECON.md: Réponse (present while generating)",
    idle: false,
  },
  response: {
    css: "model-response",
    ref: "docs/gemini-web/RECON.md: Réponse",
    idle: false,
  },
  content: {
    css: "model-response message-content",
    ref: "docs/gemini-web/RECON.md: Réponse (last one is the answer)",
    idle: false,
  },
  modePicker: {
    css: 'button[aria-label^="Open mode picker"], button[aria-label^="Ouvrir le sélecteur de mode"]',
    ref: "live survey 2026-11-15, relay Chrome: aria-label 'Open mode picker, currently <mode>'",
    idle: true,
  },
  modeItem: {
    css: '[role="menuitemradio"]',
    ref: "live survey 2026-11-15: gem-menu-item[role=menuitemradio] 'Most complex work 4 Carbon New'",
    idle: false,
  },
  signIn: {
    css: "a, button",
    ref: "live survey 2026-11-15: 'Sign in' / 'Se connecter' link and button when no Google session",
    idle: true,
  },
} satisfies Record<string, Selector>;

import { cliBinary } from "../../../../system/env-kit/src/identity.ts";

/** What the owner can run by hand (the toast does it with one click); the binary name comes from tools/identity.toml. */
export const loginCommand = () => `${cliBinary()} auth login gemini-web`;
export const LOGIN_COMMAND = loginCommand();
const SIGN_IN_TEXT = "^(Sign in|Se connecter)$";

export type WebOpts = {
  /** Origin of the web app (tests point it at a local fixture). */
  base?: string;
  /** Mode regex tried first (family name of the mode picker, e.g. carbon), then `modeFallback` in order. */
  mode?: string;
  modeFallback?: string[];
  /** Thinking level regex looked up in the picker (e.g. high); absent control is reported, not fatal. */
  thinking?: string;
  /** Fail when no listed mode can be selected (default true). */
  strictMode?: boolean;
  /** Per answer: total wait, and wait for the generation to start (Stop button or response). */
  timeoutMs?: number;
  stopWaitMs?: number;
  /** Characters per message; longer prompts are split into several messages. */
  maxMessageBytes?: number;
  headful?: boolean;
  lang?: string;
  /** Seconds-to-ms wait for the owner's sign-in (toast flow) before reporting health login; 0 = do not wait. */
  loginWaitMs?: number;
  /** Raises the sign-in notification (default: the toast of env-kit/auth-toast.ts); tests inject their own. */
  raiseLogin?: () => void;
  /** PNG path: screenshot of the page at the end of the run (answer, login wall or failure), kept as proof. */
  screenshot?: string;
  /** Schema the answer must follow (repair message and validation). */
  schema?: Schema;
};
export type WebResult = {
  ok: boolean;
  text: string;
  cls?: "login" | "task" | "missing" | "timeout";
  ms: number;
  /** Chat URL and id of the run (recorded in the verdict). */
  chat?: string;
  chatId?: string;
  /** Mode actually selected, and non-fatal findings. */
  mode?: string;
  notes: string[];
};

let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const r = queue.then(f, f);
  queue = r.catch(() => {});
  return r;
};

const sel = (k: keyof typeof SELECTORS) => SELECTORS[k].css;
const J = JSON.stringify;
const SLEEP = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));";

/** Navigates and waits until the NEW document is loaded (the old one stays inspectable while the navigation starts). */
async function goto(tab: Tab, url: string) {
  await tab.eval("window.__gwOld = true").catch(() => {});
  await tab.navigate(url);
  for (let i = 0; i < 150; i++) {
    const done = await tab
      .eval<boolean>("document.readyState === 'complete' && !window.__gwOld")
      .catch(() => false);
    if (done) return;
    await Bun.sleep(200);
  }
}

/** Splits at line boundaries into parts of at most `max` characters (a longer single line is cut). */
export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const l = line;
    if (cur && cur.length + l.length + 1 > max) {
      parts.push(cur);
      cur = "";
    }
    if (l.length > max) {
      for (let i = 0; i < l.length; i += max) parts.push(l.slice(i, i + max));
      continue;
    }
    cur += (cur ? "\n" : "") + l;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Messages of a split prompt: parts are acknowledged, the last one is answered. */
export const frame = (part: string, i: number, n: number) =>
  n === 1
    ? part
    : i < n - 1
      ? `[part ${i + 1}/${n} of one long message. Do not answer yet: reply with the single word RECEIVED.]\n${part}`
      : `[part ${n}/${n}, the last. The message is complete: answer it now, following the output format stated at its start.]\n${part}`;

const readyScript = () => `(async () => {
  ${SLEEP}
  const q = (s) => document.querySelector(s);
  const re = new RegExp(${J(SIGN_IN_TEXT)});
  const signedOut = () => [...document.querySelectorAll(${J(sel("signIn"))})].some((b) => re.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  for (let i = 0; i < 160; i++) {
    if (location.host.startsWith("accounts.")) return "login";
    if (q(${J(sel("editor"))})) break;
    await sleep(150);
  }
  if (!q(${J(sel("editor"))})) return signedOut() ? "login" : "editor";
  // The sign-in controls render a moment after the editor.
  for (let i = 0; i < 12; i++) { if (signedOut()) return "login"; await sleep(250); }
  return "ok";
})()`;

const modeScript = (wants: string[]) => `(async () => {
  ${SLEEP}
  const q = (s) => document.querySelector(s);
  const cur = () => (q(${J(sel("modePicker"))})?.getAttribute("aria-label") ?? "").split(/currently|actuellement/i).pop();
  const close = async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.body.click(); await sleep(300); };
  if (!q(${J(sel("modePicker"))})) return { error: "modePicker" };
  const seen = [];
  for (const w of ${J(wants)}) {
    const re = new RegExp(w, "i");
    if (re.test(cur())) return { picked: w, label: cur().trim() };
    q(${J(sel("modePicker"))}).click();
    await sleep(800);
    const items = [...document.querySelectorAll(${J(sel("modeItem"))})];
    seen.push(...items.map((e) => e.innerText.replace(/\\s+/g, " ").trim()));
    const it = items.find((e) => re.test(e.innerText));
    if (it) {
      it.click();
      await sleep(1000);
      if (re.test(cur())) return { picked: w, label: cur().trim() };
    }
    await close();
  }
  return { error: "mode", seen: [...new Set(seen)] };
})()`;

const thinkingScript = (level: string) => `(async () => {
  ${SLEEP}
  const q = (s) => document.querySelector(s);
  const re = new RegExp(${J(level)}, "i");
  q(${J(sel("modePicker"))})?.click();
  await sleep(800);
  const it = [...document.querySelectorAll('.cdk-overlay-container [role^="menuitem"], .cdk-overlay-container [role="option"], .cdk-overlay-container [role="radio"], .cdk-overlay-container button, [role="menu"] [role^="menuitem"]')]
    .find((e) => re.test(e.innerText) && !e.matches(${J(sel("modeItem"))}));
  if (it) { it.click(); await sleep(600); return true; }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.body.click();
  return false;
})()`;

const prepScript = () => `(async () => {
  const ed = document.querySelector(${J(sel("editor"))});
  if (!ed) return -1;
  ed.focus();
  return document.querySelectorAll(${J(sel("response"))}).length;
})()`;

const sendScript = (
  before: number,
  timeoutMs: number,
  stopWaitMs: number,
) => `(async () => {
  ${SLEEP}
  const q = (s) => document.querySelector(s);
  let sent = false;
  for (let i = 0; i < 200 && !sent; i++) {
    const b = q(${J(sel("send"))});
    if (b && !b.disabled && b.getAttribute("aria-disabled") !== "true") { b.click(); sent = true; } else await sleep(100);
  }
  if (!sent) return { error: "send" };
  const t0 = performance.now();
  let last = "", stable = 0, sawStop = false;
  while (performance.now() - t0 < ${timeoutMs}) {
    await sleep(400);
    const sb = q(${J(sel("stop"))});
    const stop = !!sb && sb.getClientRects().length > 0 && !sb.hidden;
    sawStop = sawStop || stop;
    const n = document.querySelectorAll(${J(sel("response"))}).length;
    if (n <= ${before}) {
      if (!sawStop && performance.now() - t0 > ${stopWaitMs}) return { error: "no-start" };
      continue;
    }
    const all = document.querySelectorAll(${J(sel("content"))});
    const c = all[all.length - 1];
    const txt = (c?.innerText ?? "").trim();
    if (txt && txt === last && !stop) { if (++stable >= 3) return { text: txt, code: [...c.querySelectorAll("pre, code-block")].map((e) => e.textContent ?? ""), url: location.href, sawStop }; } else stable = 0;
    last = txt;
  }
  return { error: "timeout" };
})()`;

type Sent = {
  text?: string;
  code?: string[];
  url?: string;
  error?: string;
  sawStop?: boolean;
};

/** The block that parses as a review (code blocks first, then the whole text), otherwise the whole text. */
export function pickAnswer(r: Sent, schema: Schema): string {
  for (const c of r.code ?? []) if (parseReview(c, schema).ok) return c;
  return r.text ?? "";
}

export const REPAIR_PROMPT = (schema: Schema) =>
  `Your last answer was not valid JSON for the review schema. Return only valid JSON for this schema, in one \`\`\`json fenced block, no other text:\n${JSON.stringify(schema)}`;

const chatIdOf = (url: string) => {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop();
  } catch {
    return undefined;
  }
};

/** Quick login state of the live page: ok (signed in, editor present), login, or wait (still loading). */
export const quickScript = () => `(() => {
  const re = new RegExp(${J(SIGN_IN_TEXT)});
  const out = [...document.querySelectorAll(${J(sel("signIn"))})].some((b) => re.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  if (location.host.startsWith("accounts.")) return "login";
  if (!document.querySelector(${J(sel("editor"))})) return "wait";
  return out ? "login" : "ok";
})()`;

/** Session state of the relay's Chrome without sending anything (headless). */
export async function probeSession(
  o: { base?: string; headful?: boolean } = {},
): Promise<"ok" | "login" | "editor"> {
  const base = (o.base ?? "https://gemini.google.com").replace(/\/+$/, "");
  return serial(async () => {
    await launchBrowser(!o.headful, `${base}/app?hl=en`);
    const tab = await Tab.open(`${base}/app`, `${base}/`);
    try {
      await goto(tab, `${base}/app?hl=en`);
      return (await tab.eval<string>(readyScript())) as
        "ok" | "login" | "editor";
    } finally {
      tab.close();
    }
  });
}

/** Page.captureScreenshot of the tab into `path` (best effort). */
async function shot(tab: Tab, path?: string) {
  if (!path) return;
  try {
    const r = await tab.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, "base64"));
  } catch {}
}

/** Asks Gemini on the web in a fresh chat; see the header for the protocol. */
export function geminiWebAsk(
  prompt: string,
  o: WebOpts = {},
): Promise<WebResult> {
  return serial(() => run(prompt, o));
}

/** Run with the sign-in flow: a missing session raises one toast, waits for the owner's click and sign-in, then resumes. */
async function run(prompt: string, o: WebOpts): Promise<WebResult> {
  const r = await runOnce(prompt, o);
  if (r.cls !== "login" || !o.loginWaitMs || process.platform !== "win32")
    return r;
  const since = Date.now();
  const paths = await import("../../../../system/env-kit/src/auth-paths.ts");
  paths.writeSession("gemini-web", false, "login needed");
  if (o.raiseLogin) o.raiseLogin();
  else
    (await import("../../../../system/env-kit/src/auth-toast.ts")).raiseLogin(
      "gemini-web",
      "Gemini",
    );
  const end = since + o.loginWaitMs;
  while (Date.now() < end) {
    await Bun.sleep(2000);
    const s = paths.readSession("gemini-web");
    if (s?.ok && s.at >= since)
      return runOnce(prompt, { ...o, loginWaitMs: 0 });
  }
  r.notes.push(`no sign-in within ${Math.round(o.loginWaitMs / 1000)} s`);
  return r;
}

async function runOnce(prompt: string, o: WebOpts): Promise<WebResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const base = (o.base ?? "https://gemini.google.com").replace(/\/+$/, "");
  const lang = o.lang ?? "en";
  const timeoutMs = o.timeoutMs ?? 600_000;
  const stopWaitMs = o.stopWaitMs ?? 20_000;
  const schema = o.schema ?? DEFAULT_SCHEMA;
  const fail = (
    cls: WebResult["cls"],
    text: string,
    extra: Partial<WebResult> = {},
  ): WebResult => ({
    ok: false,
    text,
    cls,
    ms: Math.round(performance.now() - t0),
    notes,
    ...extra,
  });
  try {
    await launchBrowser(!o.headful, `${base}/app?hl=${lang}`);
  } catch (e: any) {
    return fail("missing", `gemini-web: ${String(e?.message ?? e)}`);
  }
  const tab = await Tab.open(`${base}/app`, `${base}/`);
  try {
    await goto(tab, `${base}/app?hl=${lang}`);
    const ready = await tab.eval<string>(readyScript());
    if (ready === "login")
      return fail(
        "login",
        `gemini-web: Google session missing in the relay's Chrome; sign in with: ${loginCommand()} (or the toast)`,
      );
    if (ready !== "ok")
      return fail(
        "task",
        "gemini-web: selector 'editor' not found (interface changed? run: ai-os review --selftest gemini-web)",
      );

    let mode: string | undefined;
    const wants = [o.mode ?? "carbon", ...(o.modeFallback ?? ["argon"])];
    const m = await tab.eval<any>(modeScript(wants));
    if (m.picked) {
      mode = m.label;
      if (m.picked !== wants[0])
        notes.push(`mode ${wants[0]} unavailable, using ${m.label}`);
    } else if (o.strictMode ?? true)
      return fail(
        "missing",
        m.error === "modePicker"
          ? "gemini-web: selector 'modePicker' not found (selftest)"
          : `gemini-web: none of the modes [${wants.join(", ")}] can be selected (page offers: ${(m.seen ?? []).join(" | ")})`,
      );
    else notes.push("mode not selectable, page default used");
    if (o.thinking && !(await tab.eval<boolean>(thinkingScript(o.thinking))))
      notes.push(
        `thinking level '${o.thinking}' control not found, page default used`,
      );

    const parts = splitMessage(prompt, o.maxMessageBytes ?? 90_000);
    if (parts.length > 1)
      notes.push(`prompt split into ${parts.length} messages`);
    const deadline = t0 + timeoutMs * Math.max(1, parts.length);
    const send = async (text: string): Promise<Sent> => {
      const before = await tab.eval<number>(prepScript());
      if (before < 0) return { error: "editor" };
      await tab.insertText(text);
      return tab.eval<Sent>(
        sendScript(
          before,
          Math.max(5_000, deadline - performance.now()),
          stopWaitMs,
        ),
      );
    };
    const problem = (r: Sent, what: string) =>
      r.error === "timeout"
        ? fail(
            "timeout",
            `gemini-web: no complete answer within ${timeoutMs} ms (${what})`,
          )
        : fail(
            "task",
            `gemini-web: ${
              r.error === "send"
                ? "selector 'send' not found or never enabled"
                : r.error === "no-start"
                  ? `generation did not start within ${stopWaitMs} ms`
                  : `selector '${r.error}' not found`
            } (${what}; selftest)`,
          );

    let last: Sent = {};
    for (let i = 0; i < parts.length; i++) {
      last = await send(frame(parts[i]!, i, parts.length));
      if (last.error) return problem(last, `message ${i + 1}/${parts.length}`);
    }
    let text = pickAnswer(last, schema);
    let url = last.url;
    let v = parseReview(text, schema);
    if (!v.ok) {
      notes.push(`invalid JSON (${v.error}); repair message sent`);
      const r2 = await send(REPAIR_PROMPT(schema));
      if (r2.error) return problem(r2, "repair message");
      text = pickAnswer(r2, schema);
      url = r2.url ?? url;
      v = parseReview(text, schema);
    }
    const chat = url;
    const chatId = url ? chatIdOf(url) : undefined;
    if (!v.ok)
      return fail(
        "task",
        `gemini-web: invalid JSON after one repair message: ${v.error}`,
        { chat, chatId, mode },
      );
    return {
      ok: true,
      text,
      ms: Math.round(performance.now() - t0),
      chat,
      chatId,
      mode,
      notes,
    };
  } finally {
    await shot(tab, o.screenshot);
    tab.close();
  }
}

// ---- self-test -------------------------------------------------------------------------------------------------

export type Check = {
  name: string;
  selector: string;
  ref: string;
  ok: boolean;
  detail: string;
};

/**
 * Checks each selector on the live page and says which one broke. Without a session it reports `login`.
 * `deep` sends one short message to check send, stop, response and content too.
 */
export async function selftest(
  o: WebOpts & { deep?: boolean } = {},
): Promise<{ ok: boolean; login: boolean; command?: string; checks: Check[] }> {
  return serial(async () => {
    const base = (o.base ?? "https://gemini.google.com").replace(/\/+$/, "");
    const checks: Check[] = [];
    const add = (k: keyof typeof SELECTORS, ok: boolean, detail: string) =>
      checks.push({
        name: k,
        selector: SELECTORS[k].css,
        ref: SELECTORS[k].ref,
        ok,
        detail,
      });
    await launchBrowser(!o.headful, `${base}/app?hl=${o.lang ?? "en"}`);
    const tab = await Tab.open(`${base}/app`, `${base}/`);
    try {
      await goto(tab, `${base}/app?hl=${o.lang ?? "en"}`);
      const ready = await tab.eval<string>(readyScript());
      if (ready === "login")
        return { ok: false, login: true, command: LOGIN_COMMAND, checks };
      add("editor", ready === "ok", ready === "ok" ? "found" : "not found");
      if (ready !== "ok") return { ok: false, login: false, checks };
      add("signIn", true, "no sign-in control: session present");
      const m = await tab.eval<any>(
        modeScript([o.mode ?? "carbon", ...(o.modeFallback ?? ["argon"])]),
      );
      add(
        "modePicker",
        m.error !== "modePicker",
        m.error === "modePicker" ? "not found" : "found",
      );
      add(
        "modeItem",
        !!m.picked,
        m.picked
          ? `selected: ${m.label}`
          : `no listed mode matched; page offers: ${(m.seen ?? []).join(" | ")}`,
      );
      if (o.deep) {
        const before = await tab.eval<number>(prepScript());
        await tab.insertText("Reply with the single word OK.");
        const r = await tab.eval<Sent>(
          sendScript(before, 120_000, o.stopWaitMs ?? 20_000),
        );
        add(
          "send",
          r.error !== "send",
          r.error === "send" ? "not found or never enabled" : "clicked",
        );
        add(
          "response",
          !r.error || r.error === "timeout" ? r.error !== "no-start" : false,
          r.error ?? "found",
        );
        add(
          "content",
          !!r.text,
          r.text ? `read ${r.text.length} characters` : "empty",
        );
        add(
          "stop",
          !!r.sawStop,
          r.sawStop
            ? "seen while generating"
            : "never seen (answer too fast, or selector changed)",
        );
      }
      return {
        ok: checks.every((c) => c.ok || c.name === "stop"),
        login: false,
        checks,
      };
    } finally {
      await shot(tab, o.screenshot);
      tab.close();
    }
  });
}
