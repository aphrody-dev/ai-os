// SPDX-License-Identifier: Apache-2.0
/**
 * Win32 crypto through bun:ffi. Synchronous by nature: only ever called inside the worker of
 * win/pool.ts, never on the main event loop.
 *
 * - DPAPI, user scope: `CryptProtectData` / `CryptUnprotectData` (crypt32.dll), flag
 *   `CRYPTPROTECT_UI_FORBIDDEN`, fixed application entropy (shared with the env-kit store v1).
 * - Windows Hello: an RSA-2048 key in the "Microsoft Passport Key Storage Provider" (ncrypt.dll).
 *   `NCryptEncrypt` is a public-key operation (no gesture): sealing never needs a human.
 *   `NCryptDecrypt` asks for the Hello gesture: unsealing a Hello-wrapped document does.
 */

import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

export const ENTROPY = new TextEncoder().encode(
  "aphrody/env-kit/secret-store/v1",
);

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const NCRYPT_SILENT_FLAG = 0x40;
const NCRYPT_PAD_PKCS1_FLAG = 0x2;
const NCRYPT_ALLOW_DECRYPT_FLAG = 0x1;
const NCRYPT_ALLOW_SIGNING_FLAG = 0x2;
const NTE_BAD_KEYSET = 0x80090016 | 0;
export const NGC_PROVIDER = "Microsoft Passport Key Storage Provider";

type Lib = ReturnType<typeof load>;
let lib: Lib | undefined;

function load() {
  const p = FFIType.ptr;
  const u32 = FFIType.u32;
  const dpapi = {
    args: [p, p, p, p, p, u32, p],
    returns: FFIType.i32,
  } as const;
  const crypt32 = dlopen("crypt32.dll", {
    CryptProtectData: dpapi,
    CryptUnprotectData: dpapi,
  });
  const kernel32 = dlopen("kernel32.dll", {
    LocalFree: { args: [p], returns: p },
    GetConsoleWindow: { args: [], returns: p },
  });
  const user32 = dlopen("user32.dll", {
    GetForegroundWindow: { args: [], returns: p },
  });
  const st = FFIType.i32;
  const h = FFIType.u64;
  const ncrypt = dlopen("ncrypt.dll", {
    NCryptOpenStorageProvider: { args: [p, p, u32], returns: st },
    NCryptOpenKey: { args: [h, p, p, u32, u32], returns: st },
    NCryptCreatePersistedKey: { args: [h, p, p, p, u32, u32], returns: st },
    NCryptSetProperty: { args: [h, p, p, u32, u32], returns: st },
    NCryptFinalizeKey: { args: [h, u32], returns: st },
    NCryptEncrypt: { args: [h, p, u32, p, p, u32, p, u32], returns: st },
    NCryptDecrypt: { args: [h, p, u32, p, p, u32, p, u32], returns: st },
    NCryptDeleteKey: { args: [h, u32], returns: st },
    NCryptFreeObject: { args: [h], returns: st },
  });
  return {
    crypt32: crypt32.symbols,
    kernel32: kernel32.symbols,
    user32: user32.symbols,
    ncrypt: ncrypt.symbols,
  };
}

const L = (): Lib => (lib ??= load());
const wide = (s: string): Buffer => Buffer.from(`${s}\0`, "utf16le");
const hex = (n: number): string =>
  `0x${(n >>> 0).toString(16).padStart(8, "0")}`;

// DATA_BLOB { DWORD cbData; BYTE *pbData; } = 16 bytes on x64 (pointer at offset 8).
function blob(bytes: Uint8Array): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(bytes.byteLength, 0);
  if (bytes.byteLength) b.writeBigUInt64LE(BigInt(ptr(bytes)), 8);
  return b;
}

function dpapiCall(
  protect: boolean,
  input: Uint8Array,
  extra: Uint8Array = ENTROPY,
): Uint8Array {
  const { crypt32, kernel32 } = L();
  const data = new Uint8Array(Math.max(input.byteLength, 1));
  data.set(input);
  const inBlob = blob(data.subarray(0, input.byteLength));
  const entropy = blob(extra);
  const out = Buffer.alloc(16);
  const fn = protect ? crypt32.CryptProtectData : crypt32.CryptUnprotectData;
  const ok = fn(
    ptr(inBlob),
    null,
    ptr(entropy),
    null,
    null,
    CRYPTPROTECT_UI_FORBIDDEN,
    ptr(out),
  );
  data.fill(0);
  if (!ok)
    throw new Error(
      `${protect ? "CryptProtectData" : "CryptUnprotectData"} failed`,
    );
  const len = out.readUInt32LE(0);
  const p = Number(out.readBigUInt64LE(8));
  try {
    return len
      ? new Uint8Array(toArrayBuffer(p as never, 0, len)).slice()
      : new Uint8Array();
  } finally {
    if (p) {
      new Uint8Array(toArrayBuffer(p as never, 0, len)).fill(0);
      kernel32.LocalFree(p as never);
    }
  }
}

/** `entropy`: v1 = fixed ENTROPY; v2 = "aphrody/vault/dpapi/v2|<NAME>" (store.ts entropyV2): a renamed blob no longer opens. */
export const dpapiProtect = (d: Uint8Array, entropy?: Uint8Array): Uint8Array =>
  dpapiCall(true, d, entropy);
export const dpapiUnprotect = (
  b: Uint8Array,
  entropy?: Uint8Array,
): Uint8Array => dpapiCall(false, b, entropy);

// --- Windows Hello (NCrypt, Passport KSP) ------------------------------------------------------

function check(what: string, status: number): void {
  if (status !== 0)
    throw Object.assign(new Error(`${what}: ${hex(status)}`), { status });
}

function withProvider<T>(fn: (prov: bigint) => T): T {
  const { ncrypt } = L();
  const ph = new BigUint64Array(1);
  check(
    "NCryptOpenStorageProvider",
    ncrypt.NCryptOpenStorageProvider(ptr(ph), ptr(wide(NGC_PROVIDER)), 0),
  );
  try {
    return fn(ph[0]!);
  } finally {
    ncrypt.NCryptFreeObject(ph[0]!);
  }
}

function openKey<T>(
  name: string,
  flags: number,
  fn: (key: bigint) => T,
): T | undefined {
  const { ncrypt } = L();
  return withProvider((prov) => {
    const kh = new BigUint64Array(1);
    const s = ncrypt.NCryptOpenKey(prov, ptr(kh), ptr(wide(name)), 0, flags);
    if (s === NTE_BAD_KEYSET) return undefined;
    check("NCryptOpenKey", s);
    try {
      return fn(kh[0]!);
    } finally {
      ncrypt.NCryptFreeObject(kh[0]!);
    }
  });
}

function setProp(h: bigint, name: string, value: Buffer): void {
  check(
    `NCryptSetProperty(${name})`,
    L().ncrypt.NCryptSetProperty(
      h,
      ptr(wide(name)),
      ptr(value),
      value.byteLength,
      0,
    ),
  );
}

function setWindow(h: bigint): void {
  const { kernel32, user32 } = L();
  const hwnd =
    Number(user32.GetForegroundWindow() ?? 0) ||
    Number(kernel32.GetConsoleWindow() ?? 0);
  if (!hwnd) return;
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(hwnd));
  setProp(h, "HWND Handle", b);
}

/** Provider available and key present, without any UI (`NCRYPT_SILENT_FLAG`). */
export function helloStatus(name: string): {
  provider: boolean;
  key: boolean;
  error?: string;
} {
  try {
    const key = openKey(name, NCRYPT_SILENT_FLAG, () => true) ?? false;
    return { provider: true, key };
  } catch (e) {
    return { provider: false, key: false, error: (e as Error).message };
  }
}

/** Creates the Hello key (shows the Windows Hello enrolment prompt: owner only). */
export function helloEnroll(name: string, context: string): void {
  const { ncrypt } = L();
  withProvider((prov) => {
    const kh = new BigUint64Array(1);
    check(
      "NCryptCreatePersistedKey",
      ncrypt.NCryptCreatePersistedKey(
        prov,
        ptr(kh),
        ptr(wide("RSA")),
        ptr(wide(name)),
        0,
        0,
      ),
    );
    const key = kh[0]!;
    try {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(2048);
      setProp(key, "Length", len);
      const usage = Buffer.alloc(4);
      usage.writeUInt32LE(
        NCRYPT_ALLOW_DECRYPT_FLAG | NCRYPT_ALLOW_SIGNING_FLAG,
      );
      setProp(key, "Key Usage", usage);
      setProp(key, "Use Context", wide(context));
      setWindow(key);
      check("NCryptFinalizeKey", ncrypt.NCryptFinalizeKey(key, 0));
    } finally {
      ncrypt.NCryptFreeObject(key);
    }
  });
}

function rsa(
  decrypt: boolean,
  name: string,
  input: Uint8Array,
  context: string,
): Uint8Array {
  const { ncrypt } = L();
  const r = openKey(name, decrypt ? 0 : NCRYPT_SILENT_FLAG, (key) => {
    if (decrypt) {
      setProp(key, "Use Context", wide(context));
      setWindow(key);
    }
    const fn = decrypt ? ncrypt.NCryptDecrypt : ncrypt.NCryptEncrypt;
    const flags = NCRYPT_PAD_PKCS1_FLAG | (decrypt ? 0 : NCRYPT_SILENT_FLAG);
    const src = Buffer.from(input);
    const n = new Uint32Array(1);
    check(
      decrypt ? "NCryptDecrypt" : "NCryptEncrypt",
      fn(key, ptr(src), src.byteLength, null, null, 0, ptr(n), flags),
    );
    const out = Buffer.alloc(n[0]!);
    check(
      decrypt ? "NCryptDecrypt" : "NCryptEncrypt",
      fn(
        key,
        ptr(src),
        src.byteLength,
        null,
        ptr(out),
        out.byteLength,
        ptr(n),
        flags,
      ),
    );
    src.fill(0);
    const res = new Uint8Array(out.subarray(0, n[0]!));
    return res.slice();
  });
  if (!r)
    throw new Error(
      `Windows Hello key absent: run \`env-kit vault hello enroll\``,
    );
  return r;
}

export const helloWrap = (name: string, dek: Uint8Array): Uint8Array =>
  rsa(false, name, dek, "");
export const helloUnwrap = (
  name: string,
  wrapped: Uint8Array,
  context: string,
): Uint8Array => rsa(true, name, wrapped, context);
