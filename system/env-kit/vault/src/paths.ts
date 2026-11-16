// SPDX-License-Identifier: Apache-2.0
/**
 * Vault locations. One root per host, never tracked by git:
 *
 * - Windows (the PC): `<src>/var/secrets` (`/*` allowlist of the root .gitignore keeps `var/` out).
 * - Linux: `$XDG_DATA_HOME/aphrody/vault` (inbox of age envelopes, applied state). The local layer
 *   stays where systemd looks for it: `/etc/credstore.encrypted` (root) or
 *   `~/.config/credstore.encrypted` (`systemd-creds --user`), so units read it with
 *   `LoadCredentialEncrypted=`.
 *
 * `APHRODY_VAULT_DIR` overrides the root, `ENV_KIT_SECRET_DIR` the local secret directory (tests).
 */

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type LocalBackend = "dpapi" | "systemd-creds" | "systemd-creds-user";

export const WIN = process.platform === "win32";

/** Repository root: SRC_ROOT, else four levels above this file (system/env-kit/vault/src). */
export function srcRoot(): string {
  return process.env.SRC_ROOT ?? resolve(import.meta.dir, "..", "..", "..", "..");
}

/** True when `p` (or its nearest existing ancestor) is writable: false under ProtectSystem=strict,
 *  a read-only bind mount or missing permissions. Cheap and cached per path (cold path). */
const writableCache = new Map<string, boolean>();
export function writable(p: string): boolean {
  const hit = writableCache.get(p);
  if (hit !== undefined) return hit;
  let probe = p;
  let ok = false;
  for (;;) {
    try {
      accessSync(probe, constants.W_OK);
      ok = true;
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") break; // EROFS, EACCES, EPERM: not writable
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  writableCache.set(p, ok);
  return ok;
}

/** Linux: $XDG_DATA_HOME/aphrody/vault, else (sandboxed service, e.g. ProtectSystem=strict with only
 *  ~/.local/state writable) $XDG_STATE_HOME/aphrody/vault. */
export function vaultRoot(): string {
  if (process.env.APHRODY_VAULT_DIR) return process.env.APHRODY_VAULT_DIR;
  if (WIN) return join(srcRoot(), "var", "secrets");
  const data = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "aphrody",
    "vault",
  );
  if (writable(data)) return data;
  const state = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "aphrody",
    "vault",
  );
  return writable(state) ? state : data;
}

/** Pre-vault location of the env-kit DPAPI store: still read (newest file wins), never written. */
export function legacyDpapiDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(base, "aphrody", "secrets");
}

export const isRoot = (): boolean => process.getuid?.() === 0;

export interface LocalStoreInfo {
  backend: LocalBackend;
  dir: string;
  /** Read-only fallbacks, searched after `dir`. */
  legacy: string[];
}

export function localStore(): LocalStoreInfo {
  const override = process.env.ENV_KIT_SECRET_DIR;
  if (WIN) {
    return {
      backend: "dpapi",
      dir: override ?? join(vaultRoot(), "local"),
      legacy: override ? [] : [legacyDpapiDir()],
    };
  }
  if (process.platform === "linux") {
    if (isRoot()) {
      // Root: /etc/credstore.encrypted (searched by LoadCredentialEncrypted=). A sandboxed root service
      // (ProtectSystem=strict: /etc read-only) writes under the vault root instead, still with the host
      // key of systemd-creds (no --user, so no user manager or D-Bus needed), and still reads /etc.
      const etc = "/etc/credstore.encrypted";
      if (override)
        return { backend: "systemd-creds", dir: override, legacy: [] };
      return writable(etc)
        ? { backend: "systemd-creds", dir: etc, legacy: [] }
        : {
            backend: "systemd-creds",
            dir: join(vaultRoot(), "local"),
            legacy: [etc],
          };
    }
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return {
      backend: "systemd-creds-user",
      dir: override ?? join(base, "credstore.encrypted"),
      legacy: [],
    };
  }
  throw new Error(`vault: unsupported platform ${process.platform}`);
}

/** Repository files describing the vault (public data only: names, scopes, recipients). */
export const infraDir = (): string => join(srcRoot(), "device", "vault");
