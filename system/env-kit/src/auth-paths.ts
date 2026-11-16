// State files of the auth service (shared by the daemon, the toast and the web sessions): light, no vault import.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = () =>
  process.env.AY_AUTH_STATE ??
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? homedir(), "aphrody", "auth")
    : join(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
        "aphrody",
        "auth",
      ));

export const readJson = <T>(p: string, d: T): T => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return d;
  }
};
export const writeJson = (p: string, v: unknown) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
};

/** Last known state of a web session (written by the engine on a missing login and by the sign-in flow). */
export type SessionState = { ok: boolean; at: number; note?: string };
const sessionFile = (service: string) =>
  join(stateDir(), `session-${service}.json`);
export const readSession = (service: string): SessionState | undefined =>
  readJson<SessionState | undefined>(sessionFile(service), undefined);
export const writeSession = (service: string, ok: boolean, note?: string) =>
  writeJson(sessionFile(service), { ok, at: Date.now(), note });
