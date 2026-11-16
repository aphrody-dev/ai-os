import { CString, FFIType, dlopen, ptr, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { depotLibCandidates } from "./depot.ts";

const enc = new TextEncoder();
const cstr = (s: string): Uint8Array => enc.encode(`${s}\0`);

const SYMBOLS = {
  aphrody_abi_version: { args: [], returns: FFIType.u32 },
  aphrody_free: { args: [FFIType.ptr], returns: FFIType.void },
  aphrody_re_audit_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  aphrody_re_audit_bytes_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  aphrody_ghidra_decompile_json: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  aphrody_mingw_audit_json: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  aphrody_lua52_transcode_hex: {
    args: [FFIType.ptr, FFIType.u64, FFIType.u8, FFIType.u8],
    returns: FFIType.ptr,
  },
} as const;

type ReLib = ReturnType<typeof dlopen<typeof SYMBOLS>>;

let cached: { lib: ReLib; path: string } | null = null;
let loadAttempted = false;

/** Attempts to dlopen `aphrody_core_capi` RE surface once and caches the result. */
export function loadReFfi(): { lib: ReLib; path: string } | null {
  if (cached) return cached;
  if (loadAttempted) return null;
  loadAttempted = true;

  for (const candidate of depotLibCandidates()) {
    if (!existsSync(candidate)) continue;
    try {
      const lib = dlopen(candidate, SYMBOLS);
      cached = { lib, path: candidate };
      return cached;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

/** True when `aphrody_core_capi` RE surface is available and loaded. */
export function hasReFfi(): boolean {
  return loadReFfi() !== null;
}

function need(): ReLib {
  const loaded = loadReFfi();
  if (!loaded) {
    throw new Error(
      `aphrody_core_capi.${suffix} RE surface not found (checked: ${depotLibCandidates().join(", ")}); build with cargo build --release -p aphrody-core-capi`,
    );
  }
  return loaded.lib;
}

function takeJson<T>(lib: ReLib, p: unknown): T {
  if (!p) throw new Error("aphrody_core_capi returned null string pointer");
  const ptrNum = p as Parameters<ReLib["symbols"]["aphrody_free"]>[0];
  let raw: string;
  try {
    raw = new CString(
      ptrNum as ConstructorParameters<typeof CString>[0],
    ).toString();
  } finally {
    lib.symbols.aphrody_free(ptrNum);
  }
  const parsed = JSON.parse(raw);
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    Object.keys(parsed).length === 1
  ) {
    throw new Error(String((parsed as { error: unknown }).error));
  }
  return parsed as T;
}

export function reAudit(path: string): unknown {
  const lib = need();
  return takeJson(lib, lib.symbols.aphrody_re_audit_json(ptr(cstr(path))));
}

export function reAuditBytes(label: string, bytes: Uint8Array): unknown {
  const lib = need();
  const buf = bytes.byteLength > 0 ? bytes : new Uint8Array(1);
  return takeJson(
    lib,
    lib.symbols.aphrody_re_audit_bytes_json(
      ptr(cstr(label)),
      ptr(buf),
      bytes.byteLength,
    ),
  );
}

export function ghidraDecompile(path: string, maxFunctions = 64): unknown {
  const lib = need();
  return takeJson(
    lib,
    lib.symbols.aphrody_ghidra_decompile_json(ptr(cstr(path)), maxFunctions),
  );
}

export function mingwAudit(path: string, maxFunctions = 64): unknown {
  const lib = need();
  return takeJson(
    lib,
    lib.symbols.aphrody_mingw_audit_json(ptr(cstr(path)), maxFunctions),
  );
}

export function lua52TranscodeHex(
  bytes: Uint8Array,
  targetInt = 4,
  targetSizet = 4,
): { ok: boolean; hex?: string; byte_length?: number; error?: string } {
  const lib = need();
  const buf = bytes.byteLength > 0 ? bytes : new Uint8Array(1);
  return takeJson(
    lib,
    lib.symbols.aphrody_lua52_transcode_hex(
      ptr(buf),
      bytes.byteLength,
      targetInt,
      targetSizet,
    ),
  );
}
