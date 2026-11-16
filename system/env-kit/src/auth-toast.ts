// One Windows toast per sign-in need; one click launches `<binary> auth login <service>` through a custom URL
// protocol registered under HKCU (no admin, idempotent). The binary name comes from tools/identity.toml.
// Never types credentials: the click only opens the sign-in page.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, stateDir, writeJson } from "./auth-paths.ts";
import { cliBinary } from "./identity.ts";

export const APP_ID = "Aphrody.Auth";
const WAIT_BETWEEN_TOASTS = 10 * 60_000;

export const protocolScheme = () => `${cliBinary()}-auth`;
export const loginUri = (service = "") =>
  `${protocolScheme()}://login/${service}`;
/** Service named by a login URI (`"" ` when the URI names none); undefined when it is not ours. */
export function parseLoginUri(uri: string): string | undefined {
  const m = /^([a-z][\w-]*):\/\/login\/?([\w-]*)\/?$/i.exec(uri.trim());
  return m && m[1] === protocolScheme() ? m[2]! : undefined;
}

const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (m) => `&#${m.charCodeAt(0)};`);

/** Toast with a body click and a button, both activating the login URI. */
export function toastXml(o: {
  title: string;
  lines: string[];
  launch: string;
  button?: string;
}): string {
  return (
    `<toast activationType="protocol" launch="${esc(o.launch)}" scenario="reminder">` +
    `<visual><binding template="ToastGeneric"><text>${esc(o.title)}</text><text>${esc(o.lines.slice(0, 8).join("\n"))}</text></binding></visual>` +
    `<actions><action content="${esc(o.button ?? "Sign in")}" arguments="${esc(o.launch)}" activationType="protocol"/></actions>` +
    `</toast>`
  );
}

/** `reg add` argument lists registering the app id and the URL protocol (pure, for tests and for register()). */
export function registrationCommands(
  bin: string,
  scheme = protocolScheme(),
): string[][] {
  const cls = `HKCU\\Software\\Classes\\${scheme}`;
  return [
    [
      "add",
      `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`,
      "/v",
      "DisplayName",
      "/d",
      "Aphrody sign-in",
      "/f",
    ],
    ["add", cls, "/ve", "/d", `URL:${scheme}`, "/f"],
    ["add", cls, "/v", "URL Protocol", "/d", "", "/f"],
    [
      "add",
      `${cls}\\shell\\open\\command`,
      "/ve",
      "/d",
      `"${bin}" auth login --uri "%1"`,
      "/f",
    ],
  ];
}

export function register(bin = Bun.which(cliBinary()) ?? cliBinary()): void {
  if (process.platform !== "win32") return;
  for (const a of registrationCommands(bin))
    Bun.spawnSync(["reg", ...a], { stdout: "ignore", stderr: "ignore" });
}

const SHOW = `$ErrorActionPreference='Stop'; [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null; $x=New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml($env:AY_TOAST_XML); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;

/** Shows a toast (Windows PowerShell 5.1: WinRT projection); false elsewhere or on failure. */
export function showToast(xml: string): boolean {
  if (process.platform !== "win32") return false;
  const r = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", SHOW],
    {
      env: { ...process.env, AY_TOAST_XML: xml },
      stdout: "ignore",
      stderr: "ignore",
      timeout: 30_000,
    },
  );
  return r.exitCode === 0;
}

/** Grouped notification: toast on Windows, `auth-pending.md` everywhere. */
export function notify(
  title: string,
  lines: string[],
  launch = loginUri(),
): boolean {
  register();
  const shown = showToast(toastXml({ title, lines, launch }));
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    join(stateDir(), "auth-pending.md"),
    `# ${title}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  return shown;
}

/**
 * Sign-in needed for a service: one toast per 10 minutes at most (a waiting review and the daemon share this guard).
 * `command` is shown as text only when the toast cannot be displayed (non-Windows host).
 */
export function raiseLogin(
  service: string,
  label: string,
  now = Date.now(),
): { shown: boolean; skipped: boolean } {
  const pf = join(stateDir(), "auth-prompts.json");
  const prompts = readJson<Record<string, number>>(pf, {});
  const k = `login:${service}`;
  if (now - (prompts[k] ?? 0) < WAIT_BETWEEN_TOASTS)
    return { shown: false, skipped: true };
  const shown = notify(
    `${label}: sign-in needed`,
    [`Click to sign in.`],
    loginUri(service),
  );
  // A toast that could not be shown does not silence the next attempt.
  if (shown) {
    prompts[k] = now;
    writeJson(pf, prompts);
  }
  return { shown, skipped: false };
}
