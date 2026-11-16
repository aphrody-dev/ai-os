// SPDX-License-Identifier: Apache-2.0
/**
 * Document envelope "AYV1" (WebCrypto, async): AES-256-GCM, 96-bit random nonce, AAD = kind|name.
 *
 *   "AYV1" | flags u8 | wrapLen u16 BE | wrap | nonce[12] | ciphertext+tag
 *
 * Key: the vault master key (32 random bytes, local layer: DPAPI or systemd-creds). With the
 * Hello flag, a per-document 32-byte DEK is wrapped by the Windows Hello RSA key (public operation,
 * no gesture) and the AES key becomes HMAC-SHA256(master, "ayv1|" || DEK): opening then needs both
 * the Windows account (DPAPI) and a Hello gesture (NCryptDecrypt).
 */

import { getSecretBytes, setSecret } from "./store.ts";
import { WIN } from "./paths.ts";
import { helloStatus, helloUnwrap, helloWrap } from "./win/pool.ts";

export const MASTER = "VAULT_MASTER_KEY";
/** Internal names: never synced, never exported. */
export const RESERVED = new Set([
  MASTER,
  "VAULT_AGE_IDENTITY",
  "aphrody-vault-age",
]);
/** Passport KSP key name "<SID>//<domain>//<subdomain>//<name>" (format used by Hello clients; not on Learn). */
let helloName: Promise<string> | undefined;
export function HELLO_KEY(): Promise<string> {
  if (process.env.VAULT_HELLO_KEY)
    return Promise.resolve(process.env.VAULT_HELLO_KEY);
  helloName ??= (async () => {
    const p = Bun.spawn(
      [
        `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\whoami.exe`,
        "/user",
        "/fo",
        "csv",
        "/nh",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const sid = /S-1-[0-9-]+/.exec(await new Response(p.stdout).text())?.[0];
    if (!sid) throw new Error("vault: user SID unavailable");
    return `${sid}//aphrody//vault//aphrody-vault`;
  })();
  return helloName;
}

const MAGIC = new TextEncoder().encode("AYV1");
const FLAG_HELLO = 1;
const enc = new TextEncoder();
const subtle = crypto.subtle;

let masterCache: Promise<Uint8Array> | undefined;

export function masterKey(create = true): Promise<Uint8Array> {
  masterCache ??= (async () => {
    const k = await getSecretBytes(MASTER);
    if (k?.byteLength === 32) return k;
    if (!create)
      throw new Error("vault: master key absent (env-kit vault init)");
    // Exclusive creation: two processes starting on an empty vault must not create two keys.
    const { mkdir, open: fopen, rm } = await import("node:fs/promises");
    const { vaultRoot } = await import("./paths.ts");
    await mkdir(vaultRoot(), { recursive: true, mode: 0o700 });
    const lock = `${vaultRoot()}/.master.lock`;
    const h = await fopen(lock, "wx").catch(() => undefined);
    if (!h) {
      await Bun.sleep(500);
      const again = await getSecretBytes(MASTER);
      if (again?.byteLength === 32) return again;
      throw new Error("vault: master key being created by another process");
    }
    try {
      const raced = await getSecretBytes(MASTER);
      if (raced?.byteLength === 32) return raced;
      const fresh = crypto.getRandomValues(new Uint8Array(32));
      await setSecret(MASTER, fresh);
      return fresh;
    } finally {
      await h.close();
      await rm(lock, { force: true });
    }
  })();
  masterCache.catch(() => (masterCache = undefined));
  return masterCache;
}

export function forgetMasterKey(): void {
  masterCache = undefined;
}

/** WebCrypto wants ArrayBuffer-backed views; every buffer here is one. */
const bs = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey(
    "raw",
    bs(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", k, bs(data)));
}

/** Keyed fingerprint (hex) for idempotence indexes: never an unkeyed hash of a secret on disk. */
export async function keyedFingerprint(
  label: string,
  value: Uint8Array,
): Promise<string> {
  // Domain separation: the fingerprint key is derived, the AES key of AYV1 is the master itself.
  const k = await hmac(
    await masterKey(),
    enc.encode("aphrody/vault/fp-key/v1"),
  );
  const d = await hmac(
    k,
    new Uint8Array([...enc.encode(`fp|${label}|`), ...value]),
  );
  return Buffer.from(d).toString("hex");
}

const aesKey = (raw: Uint8Array) =>
  subtle.importKey("raw", bs(raw), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function helloAvailable(): Promise<boolean> {
  if (!WIN || process.env.VAULT_HELLO === "0") return false;
  const s = await helloStatus(await HELLO_KEY()).catch(() => ({ key: false }));
  return s.key;
}

export async function seal(
  aad: string,
  plain: Uint8Array,
  opts: { hello?: boolean } = {},
): Promise<Uint8Array> {
  const master = await masterKey();
  let wrap: Uint8Array = new Uint8Array();
  let raw = master;
  if (opts.hello) {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    wrap = await helloWrap(await HELLO_KEY(), dek);
    raw = await hmac(master, new Uint8Array([...enc.encode("ayv1|"), ...dek]));
    dek.fill(0);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: enc.encode(aad) },
      await aesKey(raw),
      bs(plain),
    ),
  );
  const out = new Uint8Array(4 + 1 + 2 + wrap.byteLength + 12 + ct.byteLength);
  out.set(MAGIC, 0);
  out[4] = opts.hello ? FLAG_HELLO : 0;
  new DataView(out.buffer).setUint16(5, wrap.byteLength);
  out.set(wrap, 7);
  out.set(nonce, 7 + wrap.byteLength);
  out.set(ct, 19 + wrap.byteLength);
  return out;
}

export function isSealed(b: Uint8Array): boolean {
  return b.byteLength > 19 && MAGIC.every((c, i) => b[i] === c);
}

export function sealedWithHello(b: Uint8Array): boolean {
  return isSealed(b) && (b[4]! & FLAG_HELLO) !== 0;
}

export async function open(
  aad: string,
  env: Uint8Array,
  context = "Ouvrir le coffre aphrody",
): Promise<Uint8Array> {
  if (!isSealed(env)) throw new Error("vault: not an AYV1 envelope");
  const flags = env[4]!;
  const wrapLen = new DataView(env.buffer, env.byteOffset).getUint16(5);
  const wrap = env.subarray(7, 7 + wrapLen);
  const nonce = env.subarray(7 + wrapLen, 19 + wrapLen);
  const ct = env.subarray(19 + wrapLen);
  const master = await masterKey(false);
  let raw = master;
  if (flags & FLAG_HELLO) {
    const dek = await helloUnwrap(await HELLO_KEY(), wrap, context);
    raw = await hmac(master, new Uint8Array([...enc.encode("ayv1|"), ...dek]));
    dek.fill(0);
  }
  return new Uint8Array(
    await subtle.decrypt(
      { name: "AES-GCM", iv: bs(nonce), additionalData: enc.encode(aad) },
      await aesKey(raw),
      bs(ct),
    ),
  );
}

/** BLAKE3 of bytes through the native b3sum (stdin), hex. Used for fingerprints and proofs. */
export async function b3(data: Uint8Array | Blob): Promise<string> {
  const p = Bun.spawn(["b3sum", "--no-names"], {
    stdin: data as never,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([
    new Response(p.stdout).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error("b3sum failed");
  return out.trim();
}

/** BLAKE3 of files (ciphertexts, manifests), one spawn. */
export async function b3Files(files: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!files.length) return m;
  // --no-names keeps input order and avoids the escaping b3sum applies to names with backslashes.
  const p = Bun.spawn(["b3sum", "--no-names", ...files], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([
    new Response(p.stdout).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error("b3sum failed");
  const sums = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (sums.length !== files.length) throw new Error("b3sum: unexpected output");
  files.forEach((f, i) => m.set(f, sums[i]!));
  return m;
}
