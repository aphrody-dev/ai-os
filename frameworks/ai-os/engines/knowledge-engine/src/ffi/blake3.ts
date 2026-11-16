import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Blake3EngineInfo {
  readonly backend: "rust_stack_ffi" | "bun_crypto_fallback";
  readonly dllPath: string | null;
  readonly abiVersion: number;
}

interface RustStackFfiHandle {
  readonly dllPath: string;
  readonly abiVersion: number;
  hashHex(bytes: Uint8Array): string | null;
}

let cachedHandle: RustStackFfiHandle | null | undefined;
const scratchOut = new Uint8Array(128);

function resolveCandidateDllPaths(): string[] {
  const candidates: Array<string | undefined> = [
    process.env.RUST_STACK_FFI_DLL,
    "%USERPROFILE%\\.local\\bin\\rust_stack_ffi.dll",
    "C:\\aphrody\\crates\\rust-stack\\target\\release\\rust_stack_ffi.dll",
    process.env.CARGO_TARGET_DIR
      ? join(process.env.CARGO_TARGET_DIR, "release", "rust_stack_ffi.dll")
      : undefined,
  ];
  return candidates.filter((p): p is string => Boolean(p && p.length > 0));
}

function initRustStackFfi(): RustStackFfiHandle | null {
  if (cachedHandle !== undefined) {
    return cachedHandle;
  }
  if (process.platform !== "win32") {
    cachedHandle = null;
    return null;
  }

  const dllPath = resolveCandidateDllPaths().find((p) => existsSync(p));
  if (!dllPath) {
    cachedHandle = null;
    return null;
  }

  try {
    // Note: In Bun 1.4.4 @types/bun, use FFIType.u64 for 64-bit usize parameters!
    const lib = dlopen(dllPath, {
      rs_abi_version: {
        args: [],
        returns: FFIType.u32,
      },
      rs_blake3_hex: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
    });

    const abiVersion = Number(lib.symbols.rs_abi_version());
    cachedHandle = {
      dllPath,
      abiVersion,
      hashHex(bytes: Uint8Array): string | null {
        const inputBuf = bytes.byteLength > 0 ? bytes : new Uint8Array(1);
        const written = Number(
          lib.symbols.rs_blake3_hex(
            ptr(inputBuf),
            BigInt(bytes.byteLength),
            ptr(scratchOut),
            BigInt(scratchOut.byteLength),
          ),
        );
        if (written !== 64) {
          return null;
        }
        return decoder.decode(scratchOut.subarray(0, 64));
      },
    };
    return cachedHandle;
  } catch {
    cachedHandle = null;
    return null;
  }
}

/**
 * Computes a deterministic 64-char hex digest via `rust_stack_ffi.dll` (`rs_blake3_hex` at ~228ns/call)
 * with graceful fallback to `Bun.CryptoHasher.hash("blake2b256", ...)` when running off-Windows.
 */
export function blake3Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const ffi = initRustStackFfi();
  if (ffi) {
    const digest = ffi.hashHex(bytes);
    if (digest) {
      return digest;
    }
  }
  return Bun.CryptoHasher.hash("blake2b256", bytes, "hex");
}

export function getBlake3EngineInfo(): Blake3EngineInfo {
  const ffi = initRustStackFfi();
  if (ffi) {
    return {
      backend: "rust_stack_ffi",
      dllPath: ffi.dllPath,
      abiVersion: ffi.abiVersion,
    };
  }
  return {
    backend: "bun_crypto_fallback",
    dllPath: null,
    abiVersion: 0,
  };
}
