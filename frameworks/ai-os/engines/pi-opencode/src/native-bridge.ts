import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface WorkspaceDigest {
  fileCount: number;
  totalBytes: number;
  merkleHash: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

const CANDIDATE_DLL_PATHS = [
  resolve(import.meta.dir, "..", "native", "pi_opencode_native.dll"),
  resolve(import.meta.dir, "..", "native", "libpi_opencode_native.so"),
  resolve(
    process.env.LOCALAPPDATA ?? "",
    "Aphrody",
    "cache",
    "cargo-target",
    "release",
    "pi_opencode_native.dll",
  ),
  resolve(
    import.meta.dir,
    "..",
    "rust-core",
    "target",
    "release",
    "pi_opencode_native.dll",
  ),
];

type NativeSymbols = {
  pi_oc_cpu_threads: () => number;
  pi_oc_is_safe_path: (pathPtr: number) => number;
  pi_oc_snapshot_json: (
    rootPtr: number,
    outPtr: number,
    outCap: number,
  ) => number | bigint;
  pi_oc_diff_stats: (beforePtr: number, afterPtr: number) => bigint;
};

let cachedNative: NativeSymbols | null | undefined;

function loadNative(): NativeSymbols | null {
  if (cachedNative !== undefined) return cachedNative;
  for (const candidate of CANDIDATE_DLL_PATHS) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const lib = dlopen(candidate, {
        pi_oc_cpu_threads: {
          args: [],
          returns: FFIType.u32,
        },
        pi_oc_is_safe_path: {
          args: [FFIType.ptr],
          returns: FFIType.u32,
        },
        pi_oc_snapshot_json: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
          returns: FFIType.u64,
        },
        pi_oc_diff_stats: {
          args: [FFIType.ptr, FFIType.ptr],
          returns: FFIType.u64,
        },
      });
      cachedNative = lib.symbols as unknown as NativeSymbols;
      return cachedNative;
    } catch {
      // Fallback to next candidate or pure Bun implementation
    }
  }
  cachedNative = null;
  return null;
}

function cstr(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const buf = new Uint8Array(encoded.length + 1);
  buf.set(encoded, 0);
  buf[encoded.length] = 0;
  return buf;
}

export function isNativeRustLoaded(): boolean {
  return loadNative() !== null;
}

export function getCpuThreads(): number {
  const native = loadNative();
  if (native) return native.pi_oc_cpu_threads();
  return navigator.hardwareConcurrency || 1;
}

const FORBIDDEN_PREFIXES = [
  "c:\\windows",
  "c:/windows",
  "c:\\program files",
  "c:/program files",
  "c:\\program files (x86)",
  "c:/program files (x86)",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/etc",
  "/boot",
  "/proc",
  "/sys",
];

export function isSafeWorkspacePath(candidatePath: string): boolean {
  const resolved = resolve(candidatePath);
  const native = loadNative();
  if (native) {
    const buf = cstr(resolved);
    return native.pi_oc_is_safe_path(ptr(buf)) === 1;
  }
  const lower = resolved.toLowerCase();
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (
      lower === prefix ||
      lower.startsWith(`${prefix}\\`) ||
      lower.startsWith(`${prefix}/`)
    ) {
      return false;
    }
  }
  return true;
}

export function snapshotWorkspace(rootDir: string): WorkspaceDigest {
  const absRoot = resolve(rootDir);
  const native = loadNative();
  if (native) {
    const rootBuf = cstr(absRoot);
    const outBuf = new Uint8Array(1024);
    const len = Number(
      native.pi_oc_snapshot_json(ptr(rootBuf), ptr(outBuf), outBuf.length),
    );
    if (len > 0) {
      const jsonText = new TextDecoder().decode(outBuf.subarray(0, len));
      return JSON.parse(jsonText) as WorkspaceDigest;
    }
  }

  // Pure Bun fallback
  const ignored = new Set([".git", ".jj", "node_modules", "target", "dist"]);
  const entries: Array<{ rel: string; size: number; hash: bigint }> = [];
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!ignored.has(item.name)) walk(join(dir, item.name));
      } else if (item.isFile()) {
        const full = join(dir, item.name);
        const st = statSync(full);
        const rel = relative(absRoot, full).replaceAll("\\", "/");
        const content =
          st.size <= 4 * 1024 * 1024 ? readFileSync(full) : Buffer.from(rel);
        entries.push({ rel, size: st.size, hash: BigInt(Bun.hash(content)) });
      }
    }
  };
  if (existsSync(absRoot)) walk(absRoot);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  let totalBytes = 0;
  const parts: string[] = [];
  for (const e of entries) {
    totalBytes += e.size;
    parts.push(`${e.rel}:${e.hash.toString(16)}`);
  }
  const merkle = BigInt(Bun.hash(parts.join("|")))
    .toString(16)
    .padStart(16, "0");
  return {
    fileCount: entries.length,
    totalBytes,
    merkleHash: merkle,
  };
}

export function diffLineStats(before: string, after: string): DiffStats {
  const native = loadNative();
  if (native) {
    const bBuf = cstr(before);
    const aBuf = cstr(after);
    const packed = native.pi_oc_diff_stats(ptr(bBuf), ptr(aBuf));
    const added = Number((packed >> 32n) & 0xffffffffn);
    const removed = Number(packed & 0xffffffffn);
    return { added, removed };
  }
  const bLines = before.split(/\r?\n/);
  const aLines = after.split(/\r?\n/);
  return {
    added: Math.max(0, aLines.length - bLines.length),
    removed: Math.max(0, bLines.length - aLines.length),
  };
}
