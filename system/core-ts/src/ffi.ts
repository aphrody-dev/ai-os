// bun:ffi bridge to system/core/capi (`aphrody_core_capi` shared library, core_* symbols).
// Contract: include/aphrody_core.h. Every returned string is JSON owned by the library and
// released with core_free right after it is copied into a JS string.
import {
  CString,
  FFIType,
  JSCallback,
  dlopen,
  ptr,
  suffix,
  type Pointer,
} from "bun:ffi";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CORE_ABI_VERSION = 1;
export const CORE_LIB_FILE = `${process.platform === "win32" ? "" : "lib"}aphrody_core_capi.${suffix}`;

const symbols = {
  core_abi_version: { args: [], returns: FFIType.u32 },
  core_free: { args: [FFIType.ptr], returns: FFIType.void },
  core_languages: { args: [], returns: FFIType.ptr },
  core_parse_json: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  core_query_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  core_facts_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  core_blake3_hex: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  core_index_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i32],
    returns: FFIType.ptr,
  },
  core_index_each: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.ptr,
  },
} as const;

type CoreLib = ReturnType<typeof dlopen<typeof symbols>>;

/** Search order: $APHRODY_CORE_LIB, ~/.local/bin, $CARGO_TARGET_DIR or <root>/target (release, debug). */
export function coreLibCandidates(): string[] {
  const root = process.env.SRC_ROOT || join(import.meta.dir, "..", "..", "..");
  const target = process.env.CARGO_TARGET_DIR || join(root, "target");
  return [
    process.env.APHRODY_CORE_LIB,
    join(homedir(), ".local", "bin", CORE_LIB_FILE),
    join(target, "release", CORE_LIB_FILE),
    join(target, "debug", CORE_LIB_FILE),
  ].filter((p): p is string => Boolean(p));
}

let cached: { lib: CoreLib; path: string } | null | undefined;

/** Loads the library once; null when absent or ABI-incompatible (callers fall back). */
export function loadCore(): { lib: CoreLib; path: string } | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const path of coreLibCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const lib = dlopen(path, symbols);
      if (lib.symbols.core_abi_version() === CORE_ABI_VERSION) {
        cached = { lib, path };
        break;
      }
      lib.close();
    } catch {
      // Wrong arch or missing deps: try the next candidate.
    }
  }
  return cached;
}

export class CoreUnavailableError extends Error {
  constructor() {
    super(
      `${CORE_LIB_FILE} not found (set APHRODY_CORE_LIB or build system/core/capi)`,
    );
  }
}

function need(): CoreLib {
  const c = loadCore();
  if (!c) throw new CoreUnavailableError();
  return c.lib;
}

const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");

function take(lib: CoreLib, raw: unknown): string {
  const p = raw as Pointer | null;
  if (p === null) throw new Error("core_* returned null");
  try {
    return new CString(p).toString();
  } finally {
    lib.symbols.core_free(p);
  }
}

function json<T>(lib: CoreLib, p: unknown): T {
  const v = JSON.parse(take(lib, p));
  if (v && typeof v === "object" && "error" in v && Object.keys(v).length === 1)
    throw new Error(v.error);
  return v as T;
}

export interface Span {
  start_line: number;
  end_line: number;
  start_col: number;
  end_col: number;
  start_byte: number;
  end_byte: number;
}
export interface AstSymbol {
  name: string;
  kind: string;
  span: Span;
  signature?: string | null;
  doc?: string | null;
  parent_scope?: string | null;
}
export interface AstFileSummary {
  path: string;
  language: string;
  symbols: AstSymbol[];
  calls: { callee: string; caller_scope?: string | null; span: Span }[];
  imports: { source_module: string; imported_symbols: string[]; span: Span }[];
  parse_errors: number;
  line_count: number;
  byte_count: number;
}
export interface IndexedFile {
  path: string;
  language: string;
  layer: string;
  feature: string;
  hash: string;
  summary: AstFileSummary | null;
}
export interface IndexStats {
  files: number;
  parsed: number;
  symbols: number;
  calls: number;
  imports: number;
  lines: number;
  elapsed_ms: number;
}
export interface CoreIndex {
  root: string;
  files: IndexedFile[];
  stats: IndexStats;
}

export function languages(): string[] {
  const lib = need();
  return take(lib, lib.symbols.core_languages()).split(",");
}

export function parse(path: string, content: string): AstFileSummary {
  const lib = need();
  return json(
    lib,
    lib.symbols.core_parse_json(ptr(cstr(path)), ptr(cstr(content))),
  );
}

export function query(path: string, content: string, sexpr: string): unknown[] {
  const lib = need();
  return json(
    lib,
    lib.symbols.core_query_json(
      ptr(cstr(path)),
      ptr(cstr(content)),
      ptr(cstr(sexpr)),
    ),
  );
}

export interface FactCapture {
  /** capture name: comment, string, import.source, import.name, call (code); heading, paragraph, ... (Markdown) */
  n: string;
  /** 1-based start and end line */
  l: number;
  el: number;
  /** UTF-8 byte range */
  s: number;
  e: number;
  t: string;
  /** kind of the parent node */
  k: string;
}
export interface FileFacts {
  file: string;
  lang: string;
  error: string | null;
  has_error: boolean;
  matches: { p: number; c: FactCapture[] }[];
}

/** Facts of one file through the shared tree-sitter layer: the built-in facts query, or `sexpr` when given. */
export function facts(path: string, content: string, sexpr?: string): FileFacts {
  const lib = need();
  return json(
    lib,
    lib.symbols.core_facts_json(
      ptr(cstr(path)),
      ptr(cstr(content)),
      ptr(cstr(sexpr ?? "")),
    ),
  );
}

const hexOut = new Uint8Array(65);
const one = new Uint8Array(1);

/** BLAKE3 hex via the native library. Throws CoreUnavailableError when it is absent. */
export function blake3Hex(input: string | Uint8Array): string {
  const lib = need();
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const rc = lib.symbols.core_blake3_hex(
    ptr(bytes.byteLength ? bytes : one),
    BigInt(bytes.byteLength),
    ptr(hexOut),
  );
  if (rc !== 0) throw new Error(`core_blake3_hex failed: ${rc}`);
  return new TextDecoder().decode(hexOut.subarray(0, 64));
}

export type HashAlgo = "blake3" | "blake2b256";

/** Content hash: BLAKE3 when the library loads, else Bun's native BLAKE2b-256. The algo is reported, never faked. */
export function contentHash(input: string | Uint8Array): {
  algo: HashAlgo;
  hex: string;
} {
  if (loadCore()) return { algo: "blake3", hex: blake3Hex(input) };
  return {
    algo: "blake2b256",
    hex: Bun.CryptoHasher.hash("blake2b256", input, "hex"),
  };
}

export interface IndexOptions {
  includes?: string[];
  /** Honour .gitignore (default true). false also walks ignored clones such as third_party/. */
  followIgnore?: boolean;
}

export function index(root: string, opts: IndexOptions = {}): CoreIndex {
  const lib = need();
  const inc = (opts.includes ?? []).join(";");
  return json(
    lib,
    lib.symbols.core_index_json(
      ptr(cstr(root)),
      ptr(cstr(inc)),
      opts.followIgnore === false ? 0 : 1,
    ),
  );
}

const pipelineSymbols = {
  core_pipeline_run_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.ptr,
  },
  core_pipeline_query_json: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32],
    returns: FFIType.ptr,
  },
} as const;

export const PIPELINE_ALL = 1;
export const PIPELINE_FORCE = 2;
export const PIPELINE_SHARED = 4;

let pipelineLib:
  ReturnType<typeof dlopen<typeof pipelineSymbols>> | null | undefined;

/** The index pipeline symbols of the same library; null on a build without feature `pipeline`. */
export function loadPipeline() {
  if (pipelineLib !== undefined) return pipelineLib;
  pipelineLib = null;
  const core = loadCore();
  if (core) {
    try {
      pipelineLib = dlopen(core.path, pipelineSymbols);
    } catch {
      // Older library without core_pipeline_*: callers fall back to indexEach.
    }
  }
  return pipelineLib;
}

export interface PipelineReport {
  root: string;
  db: string;
  seen: number;
  changed: number;
  touched: number;
  removed: number;
  cache_hits: number;
  cache_misses: number;
  queued: number;
  walk_ms: number;
  total_ms: number;
  totals: {
    files: number;
    parsed: number;
    symbols: number;
    calls: number;
    imports: number;
    lines: number;
    binaries: number;
    funcs: number;
    xrefs: number;
    pending: number;
  };
}

/** Incremental index of `root` into the SQLite file `db`, in process (no per-file JSON). */
export function pipelineRun(
  root: string,
  db: string,
  opts: IndexOptions & { force?: boolean; shared?: boolean } = {},
): PipelineReport {
  const core = need();
  const pl = loadPipeline();
  if (!pl) throw new CoreUnavailableError();
  const flags =
    (opts.followIgnore === false ? PIPELINE_ALL : 0) |
    (opts.force ? PIPELINE_FORCE : 0) |
    (opts.shared ? PIPELINE_SHARED : 0);
  return json(
    core,
    pl.symbols.core_pipeline_run_json(
      ptr(cstr(root)),
      ptr(cstr((opts.includes ?? []).join(";"))),
      ptr(cstr(db)),
      flags,
    ),
  );
}

/** Symbol search in the pipeline database: exact name or trigram substring. */
export function pipelineQuery(
  db: string,
  q: string,
  limit = 20,
  exact = false,
): {
  path: string;
  name: string;
  kind: string;
  line: number;
  scope: string | null;
  signature: string | null;
}[] {
  const core = need();
  const pl = loadPipeline();
  if (!pl) throw new CoreUnavailableError();
  return json(
    core,
    pl.symbols.core_pipeline_query_json(
      ptr(cstr(db)),
      ptr(cstr(q)),
      limit,
      exact ? 1 : 0,
    ),
  );
}

/** Streams each indexed file through a JSCallback (same thread), returns the stats. */
export function indexEach(
  root: string,
  onFile: (f: IndexedFile) => void,
  opts: IndexOptions = {},
): IndexStats {
  const lib = need();
  const cb = new JSCallback(
    (p: Pointer) => onFile(JSON.parse(new CString(p).toString())),
    {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  );
  try {
    const inc = (opts.includes ?? []).join(";");
    return json(
      lib,
      lib.symbols.core_index_each(
        ptr(cstr(root)),
        ptr(cstr(inc)),
        opts.followIgnore === false ? 0 : 1,
        cb.ptr,
      ),
    );
  } finally {
    cb.close();
  }
}
