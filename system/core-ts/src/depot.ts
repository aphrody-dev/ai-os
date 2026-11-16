import { CString, FFIType, dlopen, ptr, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const enc = new TextEncoder();
const cstr = (s: string): Uint8Array => enc.encode(`${s}\0`);

const SYMBOLS = {
  depot_abi_version: { args: [], returns: FFIType.u32 },
  depot_free_string: { args: [FFIType.ptr], returns: FFIType.void },
  depot_ingest_json: {
    args: [FFIType.ptr, FFIType.u32, FFIType.bool],
    returns: FFIType.ptr,
  },
  depot_graph_query_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.bool, FFIType.u32],
    returns: FFIType.ptr,
  },
  depot_magika_detect_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  depot_helix_rope_edit: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  depot_migrate_run_json: {
    args: [FFIType.ptr, FFIType.bool],
    returns: FFIType.ptr,
  },
  depot_transform_source_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  depot_llvm_probe_json: { args: [FFIType.ptr], returns: FFIType.ptr },
  depot_llvm_ir_analyze_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  depot_dotnet_doctor_json: { args: [], returns: FFIType.ptr },
  depot_dotnet_bindgen_json: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
} as const;

type DepotLib = ReturnType<typeof dlopen<typeof SYMBOLS>>;

let cached: { lib: DepotLib; path: string } | null = null;
let loadAttempted = false;

/** Ordered filesystem candidates for `aphrody_core_capi` shared library. */
export function depotLibCandidates(): string[] {
  const stem = process.platform === "win32" ? "aphrody_core_capi" : "libaphrody_core_capi";
  const file = `${stem}.${suffix}`;
  const repoRoot = resolve(dirname(import.meta.dir), "..", "..");
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const envPath =
    process.env.APHRODY_FFI_LIB ??
    process.env.AY_FFI_LIB ??
    process.env.DEPOT_FFI_LIB;

  const out: string[] = [];
  if (envPath) out.push(envPath);
  out.push(join(repoRoot, "target", "release", file));
  out.push(join(repoRoot, "target", "debug", file));
  if (home) {
    out.push(join(home, ".local", "lib", file));
    out.push(join(home, ".local", "bin", file));
  }
  return out;
}

/** Attempts to dlopen `aphrody_core_capi` once and caches the result. Returns null if absent. */
export function loadDepotFfi(): { lib: DepotLib; path: string } | null {
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

/** True when `aphrody_core_capi` shared library is available and loaded. */
export function hasDepotFfi(): boolean {
  return loadDepotFfi() !== null;
}

function need(): DepotLib {
  const loaded = loadDepotFfi();
  if (!loaded) {
    throw new Error(
      `aphrody_core_capi.${suffix} not found (checked: ${depotLibCandidates().join(", ")}); build with cargo build --release -p aphrody-core-capi`,
    );
  }
  return loaded.lib;
}

function takeStr(lib: DepotLib, p: unknown): string {
  if (!p) throw new Error("aphrody_core_capi returned null string pointer");
  const ptrNum = p as Parameters<DepotLib["symbols"]["depot_free_string"]>[0];
  try {
    return new CString(
      ptrNum as ConstructorParameters<typeof CString>[0],
    ).toString();
  } finally {
    lib.symbols.depot_free_string(ptrNum);
  }
}

function takeJson<T>(lib: DepotLib, p: unknown): T {
  const parsed = JSON.parse(takeStr(lib, p));
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

export function depotAbiVersion(): number {
  return Number(need().symbols.depot_abi_version());
}

export function ingestCodebase(
  rootDir = ".",
  maxTokens = 0,
  outlineOnly = false,
): unknown {
  const lib = need();
  return takeJson(
    lib,
    lib.symbols.depot_ingest_json(ptr(cstr(rootDir)), maxTokens, outlineOnly),
  );
}

export function graphQuery(
  dir: string,
  term: string,
  dfs = false,
  maxTokens = 2000,
): unknown {
  const lib = need();
  return takeJson(
    lib,
    lib.symbols.depot_graph_query_json(
      ptr(cstr(dir)),
      ptr(cstr(term)),
      dfs,
      maxTokens,
    ),
  );
}

export function detectContent(path: string, bytes: Uint8Array): unknown {
  const lib = need();
  const buf = bytes.byteLength > 0 ? bytes : new Uint8Array(1);
  return takeJson(
    lib,
    lib.symbols.depot_magika_detect_json(
      ptr(cstr(path)),
      ptr(buf),
      bytes.byteLength,
    ),
  );
}

export function helixRopeEdit(
  source: string,
  edits: [number, number, string][],
): string {
  const lib = need();
  return takeStr(
    lib,
    lib.symbols.depot_helix_rope_edit(
      ptr(cstr(source)),
      ptr(cstr(JSON.stringify(edits))),
    ),
  );
}

export function migrateRun(rootDir = ".", dryRun = true): unknown {
  const lib = need();
  return takeJson(
    lib,
    lib.symbols.depot_migrate_run_json(ptr(cstr(rootDir)), dryRun),
  );
}

export interface TransformFinding {
  rule_id: string;
  start_byte: number;
  end_byte: number;
  original: string;
  replacement: string;
}

export interface TransformResult {
  findings: TransformFinding[];
  transformed_code: string;
  edits_count: number;
}

export function transformSource(
  langOrPath: string,
  source: string,
): TransformResult {
  const lib = need();
  return takeJson<TransformResult>(
    lib,
    lib.symbols.depot_transform_source_json(
      ptr(cstr(langOrPath)),
      ptr(cstr(source)),
    ),
  );
}

export function llvmProbe(vendorLlvmDir = "third_party/llvm-project"): unknown {
  const lib = need();
  return takeJson(
    lib,
    lib.symbols.depot_llvm_probe_json(ptr(cstr(vendorLlvmDir))),
  );
}

export function llvmAnalyzeIr(sourceLabel: string, irText: string): unknown {
  const lib = need();
  return takeJson(
    lib,
    lib.symbols.depot_llvm_ir_analyze_json(
      ptr(cstr(sourceLabel)),
      ptr(cstr(irText)),
    ),
  );
}

export function dotnetDoctor(): unknown {
  const lib = need();
  return takeJson(lib, lib.symbols.depot_dotnet_doctor_json());
}

export function dotnetBindgen(
  csPath: string,
  assemblyName = "AphrodyNative",
): unknown {
  const lib = need();
  return takeJson(
    lib,
    lib.symbols.depot_dotnet_bindgen_json(
      ptr(cstr(csPath)),
      ptr(cstr(assemblyName)),
    ),
  );
}
