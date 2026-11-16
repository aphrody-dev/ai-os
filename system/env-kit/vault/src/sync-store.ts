// SPDX-License-Identifier: Apache-2.0
/**
 * Synchronous face of the local layer (store.ts), for callers that cannot await: CLIs, config
 * loaders, `Bun.spawnSync` pipelines. Same files, same formats, same locations (paths.ts `localStore`):
 * one implementation of the on-disk format, the DPAPI primitives are those of win/ffi.ts.
 *
 * Writes are v2 (DPAPI entropy bound to the name); both versions are read. Values travel through
 * memory and stdin only: never argv.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type LocalStoreInfo, localStore } from "./paths.ts";
import {
  assertName,
  DPAPI_V2,
  entropyV2,
  isDpapiV2,
  NAME,
  v2OnlyMarker,
} from "./store.ts";

export type SecretBackend = LocalStoreInfo["backend"];
export type SecretStoreInfo = LocalStoreInfo;

/** Where the local layer lives on this host (backend, directory, read-only fallbacks). */
export const storeInfo = (): SecretStoreInfo => localStore();

// The Win32 bindings load on first use, so Linux never touches them.
const win = (): typeof import("./win/ffi.ts") => require("./win/ffi.ts");

const fileOf = (info: SecretStoreInfo, dir: string, name: string): string =>
  join(dir, info.backend === "dpapi" ? `${name}.dpapi` : name);

/** Newest existing file among the store and its fallbacks (an older tool may still write there). */
function locate(info: SecretStoreInfo, name: string): string | undefined {
  let best: string | undefined;
  let at = -1;
  for (const dir of [info.dir, ...info.legacy]) {
    const f = fileOf(info, dir, name);
    try {
      const t = statSync(f).mtimeMs;
      if (t > at) [best, at] = [f, t];
    } catch {}
  }
  return best;
}

function creds(
  info: SecretStoreInfo,
  args: string[],
  input?: Uint8Array,
): Uint8Array {
  const user = info.backend === "systemd-creds-user" ? ["--user"] : [];
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(["systemd-creds", ...user, ...args], {
      stdin: input ?? "ignore",
      maxBuffer: 16 << 20,
    });
  } catch (e) {
    throw new Error(`systemd-creds ${args[0]} failed: ${(e as Error).message}`);
  }
  if (r.exitCode !== 0) {
    // stderr of systemd-creds never contains the payload.
    throw new Error(
      `systemd-creds ${args[0]} failed: ${r.stderr?.toString("utf8").trim() ?? ""}`,
    );
  }
  return new Uint8Array(r.stdout ?? new Uint8Array());
}

export function secretSet(name: string, value: string | Uint8Array): void {
  assertName(name);
  const info = storeInfo();
  mkdirSync(info.dir, { recursive: true, mode: 0o700 });
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (!bytes.byteLength) throw new Error(`secret ${name}: empty value`);
  const file = fileOf(info, info.dir, name);
  if (info.backend === "dpapi") {
    const tmp = `${file}.${process.pid}.tmp`;
    const blob = win().dpapiProtect(bytes, entropyV2(name));
    const out = new Uint8Array(4 + blob.byteLength);
    out.set(DPAPI_V2);
    out.set(blob, 4);
    writeFileSync(tmp, out, { mode: 0o600 });
    renameSync(tmp, file);
    return;
  }
  // systemd-creds writes the output file itself (0600) and binds the credential name.
  const tmp = join(info.dir, `.${name}.${process.pid}.tmp`);
  creds(info, ["encrypt", `--name=${name}`, "-", tmp], bytes);
  renameSync(tmp, file);
}

export function secretGetBytes(name: string): Uint8Array | undefined {
  assertName(name);
  const info = storeInfo();
  const file = locate(info, name);
  if (!file) return undefined;
  if (info.backend === "dpapi") {
    const raw = new Uint8Array(readFileSync(file));
    // `vault migrate-dpapi` leaves this marker once every blob is v2: v1 is refused from then on.
    if (!isDpapiV2(raw) && existsSync(v2OnlyMarker()))
      throw new Error(`secret ${name}: DPAPI v1 refused (vault is v2-only)`);
    return isDpapiV2(raw)
      ? win().dpapiUnprotect(raw.subarray(4), entropyV2(name))
      : win().dpapiUnprotect(raw);
  }
  return creds(info, ["decrypt", `--name=${name}`, file, "-"]);
}

export function secretGet(name: string): string | undefined {
  const b = secretGetBytes(name);
  return b === undefined ? undefined : new TextDecoder().decode(b);
}

export function secretHas(name: string): boolean {
  assertName(name);
  return locate(storeInfo(), name) !== undefined;
}

export function secretList(): string[] {
  const info = storeInfo();
  const names = new Set<string>();
  for (const dir of [info.dir, ...info.legacy]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (info.backend === "dpapi" && !f.endsWith(".dpapi")) continue;
      const n = info.backend === "dpapi" ? f.replace(/\.dpapi$/, "") : f;
      if (NAME.test(n) && !n.startsWith(".")) names.add(n);
    }
  }
  return [...names].sort();
}

export function secretDelete(name: string): boolean {
  assertName(name);
  const info = storeInfo();
  let hit = false;
  for (const dir of [info.dir, ...info.legacy]) {
    const file = fileOf(info, dir, name);
    if (!existsSync(file)) continue;
    rmSync(file);
    hit = true;
  }
  return hit;
}

/** Store first, then the process environment. Never throws: a host without a store falls back to env. */
export function resolveSecret(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  try {
    const v = secretGet(name);
    if (v) return v;
  } catch {
    // Store unavailable on this host.
  }
  return env[name] || undefined;
}
