import { CString, dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const SOV_CUDA_ABI_VERSION = 1;
export const SOV_POLYGLOT_ABI_VERSION = 2;

export interface CudaSm89Telemetry {
  ok: boolean;
  deviceId: number;
  deviceName: string;
  computeCapability: string;
  smCount: number;
  cudaRuntimeVersion: number;
  cudaDriverVersion: number;
  vramTotalMb: number;
  vramFreeMb: number;
  l2CacheMb: number;
  fp32FmaGflops: number;
  fp16TensorTflops: number;
  gddr6xBandwidthGbps: number;
  zeroCopyPinnedGbps: number;
}

export interface PolyglotAstSymbol {
  kind: string;
  name: string;
  start_line: number;
  end_line: number;
  byte_len: number;
}

export interface PolyglotAstReport {
  ok: boolean;
  language: string;
  root_kind: string;
  total_nodes: number;
  has_error: boolean;
  symbols: PolyglotAstSymbol[];
  error?: string;
}

export interface SafetensorsZeroCopyReport {
  ok: boolean;
  path?: string;
  file_bytes?: number;
  tensor_count?: number;
  zero_copy_mmap?: boolean;
  tensors?: Array<{
    name: string;
    dtype: string;
    shape: number[];
    byte_len: number;
    data_ptr_aligned_64b: boolean;
  }>;
  error?: string;
}

export interface HostCpuSsdTuneReport {
  ok: boolean;
  os: string;
  logical_cores: number;
  working_set_tuned: boolean;
  min_working_set_mb: number;
  max_working_set_mb: number;
  thread_qos_high_perf: boolean;
  ssd_prefetched_files: number;
  ssd_prefetched_bytes: number;
  linux_io_uring_madvise_ready: boolean;
  error?: string;
}

export type System1DecisionKind =
  | "CALL_TOOL"
  | "BUN_API"
  | "DIRECT_ANSWER"
  | "ESCALATE_SYSTEM2"
  | "CLARIFY"
  | "BLOCKED_DEFENSE";

export interface System1TransducedDecision {
  ok: boolean;
  decision: System1DecisionKind;
  tool_or_api: string | null;
  arguments: Record<string, unknown>;
  confidence: number;
  stripped_verbose_chars: number;
  extracted_raw_json: boolean;
  error?: string;
}

const CUDA_DLL_CANDIDATES = [
  "C:/Users/aphro/.local/bin/sovereign_cuda_sm89.dll",
  "C:/src/ai-os/native/cuda/sovereign_cuda_sm89.dll",
];

const POLYGLOT_DLL_CANDIDATES = [
  "C:/Users/aphro/.local/bin/sovereign_polyglot_ffi.dll",
  "C:/src/ai-os/native/sovereign-polyglot-ffi/target/release/sovereign_polyglot_ffi.dll",
];

export function resolveCudaDllPath(): string | null {
  for (const c of CUDA_DLL_CANDIDATES) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}

export function resolvePolyglotDllPath(): string | null {
  for (const c of POLYGLOT_DLL_CANDIDATES) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}

function makeNullTerminated(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  out[bytes.length] = 0;
  return out;
}

export interface SovereignCudaBinding {
  readonly dllPath: string;
  readonly abiVersion: number;
  scanAndBench(quickMode?: boolean): CudaSm89Telemetry;
  cosineRagBatch(
    query: Float32Array,
    corpus: Float32Array,
    dim: number,
  ): Float32Array;
  hereticAbliterateInPlace(
    weights: Float32Array,
    refusalDir: Float32Array,
    outFeatures: number,
    inFeatures: number,
    scale?: number,
  ): number;
  rmsNorm(
    x: Float32Array,
    weight: Float32Array,
    rows: number,
    hiddenDim: number,
    eps?: number,
  ): Float32Array;
  close(): void;
}

export interface SovereignPolyglotBinding {
  readonly dllPath: string;
  readonly abiVersion: number;
  dotProductF32(a: Float32Array, b: Float32Array): number;
  cosineRagBatch(
    query: Float32Array,
    corpus: Float32Array,
    dim: number,
  ): Float32Array;
  hereticAbliterateInPlace(
    weights: Float32Array,
    refusalDir: Float32Array,
    outFeatures: number,
    inFeatures: number,
    scale?: number,
  ): number;
  inspectSafetensors(filePath: string): SafetensorsZeroCopyReport;
  parseAst(language: string, sourceCode: string): PolyglotAstReport;
  packTernaryRow(weights: Float32Array): { scale: number; packed: Uint8Array };
  bitnetSparseGemv(
    packedWeights: Uint8Array,
    rowScales: Float32Array,
    activeMask: Uint8Array,
    x: Float32Array,
    outFeatures: number,
    inFeatures: number,
  ): { out: Float32Array; activeRowsEvaluated: number };
  tuneHostCpuSsd(prefetchPath?: string): HostCpuSsdTuneReport;
  transduceVerboseToSystem1(rawLlmOutput: string): System1TransducedDecision;
  close(): void;
}

let cudaSingleton: SovereignCudaBinding | null = null;
let polyglotSingleton: SovereignPolyglotBinding | null = null;

export function getCudaFfi(): SovereignCudaBinding | null {
  if (cudaSingleton) return cudaSingleton;
  const dllPath = resolveCudaDllPath();
  if (!dllPath) return null;

  const lib = dlopen(dllPath, {
    sov_cuda_abi_version: {
      args: [],
      returns: FFIType.u32,
    },
    sov_cuda_scan_and_bench: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    sov_cuda_cosine_rag: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    sov_cuda_heretic_abliterate: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.f32],
      returns: FFIType.i32,
    },
    sov_cuda_rmsnorm: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.i32,
        FFIType.f32,
      ],
      returns: FFIType.i32,
    },
  });

  const abiVersion = lib.symbols.sov_cuda_abi_version();

  cudaSingleton = {
    dllPath,
    abiVersion,
    scanAndBench(quickMode = true): CudaSm89Telemetry {
      // struct SovereignCudaTelemetry = 216 bytes (6x4B=24B + 3x8B=24B + 4x8B=32B + 128B char = 208B, padded to 208B; allocate 256B safe)
      const buf = new Uint8Array(256);
      const rc = lib.symbols.sov_cuda_scan_and_bench(
        ptr(buf),
        quickMode ? 1 : 0,
      );
      const view = new DataView(buf.buffer);
      const ok = rc === 0 && view.getInt32(0, true) === 1;
      const deviceId = view.getInt32(4, true);
      const smCount = view.getInt32(8, true);
      const major = view.getInt32(12, true);
      const minor = view.getInt32(16, true);
      const runtimeVer = view.getInt32(20, true);
      const driverVer = view.getInt32(24, true);
      // 4 bytes struct alignment padding before uint64_t at offset 32
      const vramTotalBytes = Number(view.getBigUint64(32, true));
      const vramFreeBytes = Number(view.getBigUint64(40, true));
      const l2CacheBytes = Number(view.getBigUint64(48, true));
      const fp32FmaGflops = view.getFloat64(56, true);
      const fp16TensorTflops = view.getFloat64(64, true);
      const gddr6xBandwidthGbps = view.getFloat64(72, true);
      const zeroCopyPinnedGbps = view.getFloat64(80, true);

      const nameSlice = buf.subarray(88, 88 + 128);
      const nulIdx = nameSlice.indexOf(0);
      const deviceName = new TextDecoder().decode(
        nulIdx >= 0 ? nameSlice.subarray(0, nulIdx) : nameSlice,
      );

      return {
        ok,
        deviceId,
        deviceName,
        computeCapability: `sm_${major}${minor}`,
        smCount,
        cudaRuntimeVersion: runtimeVer,
        cudaDriverVersion: driverVer,
        vramTotalMb: Math.round((vramTotalBytes / (1024 * 1024)) * 100) / 100,
        vramFreeMb: Math.round((vramFreeBytes / (1024 * 1024)) * 100) / 100,
        l2CacheMb: Math.round((l2CacheBytes / (1024 * 1024)) * 100) / 100,
        fp32FmaGflops: Math.round(fp32FmaGflops * 100) / 100,
        fp16TensorTflops: Math.round(fp16TensorTflops * 100) / 100,
        gddr6xBandwidthGbps: Math.round(gddr6xBandwidthGbps * 100) / 100,
        zeroCopyPinnedGbps: Math.round(zeroCopyPinnedGbps * 100) / 100,
      };
    },
    cosineRagBatch(
      query: Float32Array,
      corpus: Float32Array,
      dim: number,
    ): Float32Array {
      const numDocs = Math.floor(corpus.length / dim);
      const scores = new Float32Array(numDocs);
      if (numDocs === 0 || dim <= 0) return scores;
      lib.symbols.sov_cuda_cosine_rag(
        ptr(query),
        ptr(corpus),
        ptr(scores),
        numDocs,
        dim,
      );
      return scores;
    },
    hereticAbliterateInPlace(
      weights: Float32Array,
      refusalDir: Float32Array,
      outFeatures: number,
      inFeatures: number,
      scale = 1.0,
    ): number {
      return lib.symbols.sov_cuda_heretic_abliterate(
        ptr(weights),
        ptr(refusalDir),
        outFeatures,
        inFeatures,
        scale,
      );
    },
    rmsNorm(
      x: Float32Array,
      weight: Float32Array,
      rows: number,
      hiddenDim: number,
      eps = 1e-5,
    ): Float32Array {
      const out = new Float32Array(rows * hiddenDim);
      lib.symbols.sov_cuda_rmsnorm(
        ptr(x),
        ptr(weight),
        ptr(out),
        rows,
        hiddenDim,
        eps,
      );
      return out;
    },
    close(): void {
      lib.close();
      cudaSingleton = null;
    },
  };

  return cudaSingleton;
}

export function getPolyglotFfi(): SovereignPolyglotBinding | null {
  if (polyglotSingleton) return polyglotSingleton;
  const dllPath = resolvePolyglotDllPath();
  if (!dllPath) return null;

  const lib = dlopen(dllPath, {
    sov_polyglot_abi_version: {
      args: [],
      returns: FFIType.u32,
    },
    sov_polyglot_free_string: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    sov_polyglot_dot_f32: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.f32,
    },
    sov_polyglot_cosine_rag_batch: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    sov_polyglot_heretic_abliterate: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.f32],
      returns: FFIType.i32,
    },
    sov_polyglot_inspect_safetensors: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    sov_polyglot_parse_ast: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    sov_system1_pack_ternary: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.f32,
    },
    sov_system1_bitnet_sparse_gemv: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u64,
        FFIType.u64,
      ],
      returns: FFIType.u64,
    },
    sov_system1_tune_host_cpu_ssd: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    sov_system1_transduce_verbose: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
  });

  const readAndFreeJson = <T>(rawPtr: Pointer | bigint | null): T => {
    if (!rawPtr) return { ok: false, error: "null pointer" } as T;
    const p = rawPtr as Pointer;
    try {
      const str = new CString(p).toString();
      return JSON.parse(str) as T;
    } finally {
      lib.symbols.sov_polyglot_free_string(p);
    }
  };

  const abiVersion = lib.symbols.sov_polyglot_abi_version();

  polyglotSingleton = {
    dllPath,
    abiVersion,
    dotProductF32(a: Float32Array, b: Float32Array): number {
      const len = Math.min(a.length, b.length);
      if (len === 0) return 0;
      return lib.symbols.sov_polyglot_dot_f32(ptr(a), ptr(b), BigInt(len));
    },
    cosineRagBatch(
      query: Float32Array,
      corpus: Float32Array,
      dim: number,
    ): Float32Array {
      const numDocs = Math.floor(corpus.length / dim);
      const scores = new Float32Array(numDocs);
      if (numDocs === 0 || dim <= 0) return scores;
      lib.symbols.sov_polyglot_cosine_rag_batch(
        ptr(query),
        ptr(corpus),
        ptr(scores),
        BigInt(numDocs),
        BigInt(dim),
      );
      return scores;
    },
    hereticAbliterateInPlace(
      weights: Float32Array,
      refusalDir: Float32Array,
      outFeatures: number,
      inFeatures: number,
      scale = 1.0,
    ): number {
      return lib.symbols.sov_polyglot_heretic_abliterate(
        ptr(weights),
        ptr(refusalDir),
        BigInt(outFeatures),
        BigInt(inFeatures),
        scale,
      );
    },
    inspectSafetensors(filePath: string): SafetensorsZeroCopyReport {
      const cPath = makeNullTerminated(filePath);
      const outPtr = lib.symbols.sov_polyglot_inspect_safetensors(ptr(cPath));
      return readAndFreeJson<SafetensorsZeroCopyReport>(outPtr);
    },
    parseAst(language: string, sourceCode: string): PolyglotAstReport {
      const cLang = makeNullTerminated(language);
      const cCode = makeNullTerminated(sourceCode);
      const outPtr = lib.symbols.sov_polyglot_parse_ast(ptr(cLang), ptr(cCode));
      return readAndFreeJson<PolyglotAstReport>(outPtr);
    },
    packTernaryRow(weights: Float32Array): {
      scale: number;
      packed: Uint8Array;
    } {
      const len = weights.length;
      if (len === 0) return { scale: 0, packed: new Uint8Array(0) };
      const packedLen = Math.ceil(len / 4);
      const packed = new Uint8Array(packedLen);
      const scale = lib.symbols.sov_system1_pack_ternary(
        ptr(weights),
        BigInt(len),
        ptr(packed),
      );
      return { scale, packed };
    },
    bitnetSparseGemv(
      packedWeights: Uint8Array,
      rowScales: Float32Array,
      activeMask: Uint8Array,
      x: Float32Array,
      outFeatures: number,
      inFeatures: number,
    ): { out: Float32Array; activeRowsEvaluated: number } {
      const out = new Float32Array(outFeatures);
      if (
        outFeatures <= 0 ||
        inFeatures <= 0 ||
        packedWeights.length === 0 ||
        rowScales.length === 0 ||
        activeMask.length === 0 ||
        x.length === 0
      ) {
        return { out, activeRowsEvaluated: 0 };
      }
      const evaluated = lib.symbols.sov_system1_bitnet_sparse_gemv(
        ptr(packedWeights),
        ptr(rowScales),
        ptr(activeMask),
        ptr(x),
        ptr(out),
        BigInt(outFeatures),
        BigInt(inFeatures),
      );
      return { out, activeRowsEvaluated: Number(evaluated) };
    },
    tuneHostCpuSsd(prefetchPath?: string): HostCpuSsdTuneReport {
      const cPath = makeNullTerminated(prefetchPath ?? "");
      const outPtr = lib.symbols.sov_system1_tune_host_cpu_ssd(ptr(cPath));
      return readAndFreeJson<HostCpuSsdTuneReport>(outPtr);
    },
    transduceVerboseToSystem1(rawLlmOutput: string): System1TransducedDecision {
      const cRaw = makeNullTerminated(rawLlmOutput);
      const outPtr = lib.symbols.sov_system1_transduce_verbose(ptr(cRaw));
      return readAndFreeJson<System1TransducedDecision>(outPtr);
    },
    close(): void {
      lib.close();
      polyglotSingleton = null;
    },
  };

  return polyglotSingleton;
}
