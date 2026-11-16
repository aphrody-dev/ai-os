// Chrome DevTools Protocol, dependency-free: launches a dedicated Chrome (relay-specific profile, Chrome 136+ refuses
// remote debugging on the default profile) and drives a tab over WebSocket (Target / Page / Runtime / Input).
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const relayHome = () =>
  Bun.env.RELAY_HOME ??
  (process.platform === "win32"
    ? join(Bun.env.LOCALAPPDATA ?? homedir(), "aphrody", "relay")
    : join(
        Bun.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
        "aphrody",
        "relay",
      ));

/** Chrome executable: RELAY_CHROME, otherwise registered application path (Windows), otherwise PATH (Linux). */
export function chromePath(): string {
  if (Bun.env.RELAY_CHROME) return Bun.env.RELAY_CHROME;
  if (process.platform === "win32") {
    const q = Bun.spawnSync([
      "reg",
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
      "/ve",
    ]);
    const m = /REG_SZ\s+(.+\.exe)/i.exec(q.stdout.toString());
    if (m) return m[1]!.trim();
  }
  for (const c of [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "chrome",
  ]) {
    const p = Bun.which(c);
    if (p) return p;
  }
  throw new Error("Chrome not found: set RELAY_CHROME");
}

export const cdpPort = () => Number(Bun.env.RELAY_CDP_PORT ?? 9333);

/** Launches the relay's Chrome (no effect if it already answers). `headless` false for the initial Google sign-in. */
export async function launchBrowser(
  headless: boolean,
  url = "https://gemini.google.com/app",
): Promise<void> {
  if (await version().catch(() => null)) return;
  const profile = join(relayHome(), "chrome");
  mkdirSync(profile, { recursive: true });
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${cdpPort()}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    url,
  ];
  Bun.spawn([chromePath(), ...args], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  }).unref();
  for (let i = 0; i < 50; i++) {
    if (await version().catch(() => null)) return;
    await Bun.sleep(200);
  }
  throw new Error(`Relay Chrome unreachable on 127.0.0.1:${cdpPort()}`);
}

/** Closes the relay's Chrome through CDP (Browser.close); no effect if none answers. */
export async function closeBrowser(): Promise<void> {
  const v = await version().catch(() => null);
  if (!v) return;
  await new Promise<void>((ok) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    ws.onclose = () => ok();
    ws.onerror = () => ok();
    setTimeout(ok, 3000);
  });
  for (let i = 0; i < 25 && (await version().catch(() => null)); i++)
    await Bun.sleep(200);
}

/** Open page tabs of the relay's Chrome (url and id), without attaching to them. */
export async function listTabs(): Promise<{ id: string; url: string }[]> {
  const r = await fetch(`${base()}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  return (
    (await r.json()) as { id: string; type: string; url: string }[]
  ).filter((t) => t.type === "page");
}

const base = () => `http://127.0.0.1:${cdpPort()}`;
async function version() {
  const r = await fetch(`${base()}/json/version`, {
    signal: AbortSignal.timeout(800),
  });
  return (await r.json()) as { Browser: string; webSocketDebuggerUrl: string };
}

export class Tab {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<
    number,
    { ok: (v: any) => void; ko: (e: Error) => void }
  >();
  private constructor(readonly id: string) {}

  /** Onglet existant dont l'URL commence par `prefix`, sinon nouvel onglet. */
  static async open(url: string, prefix = url): Promise<Tab> {
    const list = (await (await fetch(`${base()}/json/list`)).json()) as {
      id: string;
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }[];
    let t = list.find((x) => x.type === "page" && x.url.startsWith(prefix));
    if (!t)
      t = (await (
        await fetch(`${base()}/json/new?${encodeURIComponent(url)}`, {
          method: "PUT",
        })
      ).json()) as typeof t;
    const tab = new Tab(t!.id);
    await tab.connect(t!.webSocketDebuggerUrl);
    return tab;
  }

  private connect(url: string) {
    return new Promise<void>((ok, ko) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => ok();
      this.ws.onerror = () => ko(new Error("CDP: connection refused"));
      this.ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        const p = m.id && this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.ko(new Error(m.error.message)) : p.ok(m.result);
      };
    });
  }

  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = ++this.seq;
    return new Promise((ok, ko) => {
      this.pending.set(id, { ok, ko });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression (promises awaited) in the page; value serialized as JSON. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
      );
    return r.result.value as T;
  }

  async navigate(url: string) {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
  }

  /** Real typing (Input.insertText: equivalent to a keystroke for rich editors). */
  insertText(text: string) {
    return this.send("Input.insertText", { text });
  }

  close() {
    this.ws.close();
  }
}

export const browserInfo = async () =>
  version()
    .then((v) => v.Browser)
    .catch(() => null);
export const profileExists = () =>
  existsSync(join(relayHome(), "chrome", "Default"));
