import {
  RUST_WASM_BYTES_LEN,
  RUST_WASM_KERNEL_B64,
  ZIG_WASM_BYTES_LEN,
  ZIG_WASM_KERNEL_B64,
} from "./embedded-bytes.ts";

export { RUST_WASM_BYTES_LEN, ZIG_WASM_BYTES_LEN };

// ============================================================================
// WebGPU WGSL Compute Shaders (Browser / Dawn / wgpu / Deno / Bun WebGPU)
// ============================================================================

export const WEBGPU_WGSL_SHADERS = {
  cosineBatch: /* wgsl */ `
struct Params {
  dim: u32,
  num_docs: u32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> query: array<f32>;
@group(0) @binding(2) var<storage, read> corpus: array<f32>;
@group(0) @binding(3) var<storage, read_write> scores: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let doc_idx = gid.x;
  if (doc_idx >= params.num_docs) { return; }
  let base = doc_idx * params.dim;
  var dot: f32 = 0.0;
  var na: f32 = 0.0;
  var nb: f32 = 0.0;
  for (var i: u32 = 0u; i < params.dim; i = i + 1u) {
    let q = query[i];
    let c = corpus[base + i];
    dot = dot + q * c;
    na = na + q * q;
    nb = nb + c * c;
  }
  let denom = sqrt(na * nb);
  scores[doc_idx] = select(0.0, dot / denom, denom > 1e-12);
}
`,
  rmsNormF32: /* wgsl */ `
struct NormParams {
  len: u32,
  eps: f32,
}
@group(0) @binding(0) var<uniform> params: NormParams;
@group(0) @binding(1) var<storage, read> input_x: array<f32>;
@group(0) @binding(2) var<storage, read> weight: array<f32>;
@group(0) @binding(3) var<storage, read_write> output_y: array<f32>;

@compute @workgroup_size(1)
fn main() {
  var sum_sq: f32 = 0.0;
  for (var i: u32 = 0u; i < params.len; i = i + 1u) {
    let v = input_x[i];
    sum_sq = sum_sq + v * v;
  }
  let inv = inverseSqrt(sum_sq / f32(params.len) + params.eps);
  for (var j: u32 = 0u; j < params.len; j = j + 1u) {
    output_y[j] = input_x[j] * inv * weight[j];
  }
}
`,
  hereticAbliterate: /* wgsl */ `
struct AbliterateParams {
  out_features: u32,
  in_features: u32,
  scale: f32,
}
@group(0) @binding(0) var<uniform> params: AbliterateParams;
@group(0) @binding(1) var<storage, read_write> weights: array<f32>;
@group(0) @binding(2) var<storage, read> refusal_dir: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let row = gid.x;
  if (row >= params.out_features) { return; }
  let base = row * params.in_features;
  var proj: f32 = 0.0;
  for (var k: u32 = 0u; k < params.in_features; k = k + 1u) {
    proj = proj + weights[base + k] * refusal_dir[k];
  }
  let factor = params.scale * proj;
  for (var k: u32 = 0u; k < params.in_features; k = k + 1u) {
    weights[base + k] = weights[base + k] - factor * refusal_dir[k];
  }
}
`,
} as const;

function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

interface RustWasmExports {
  memory: WebAssembly.Memory;
  aios_abi_version(): number;
  aios_scratch_ptr(): number;
  aios_scratch_cap(): number;
  aios_fnv1a64(ptr: number, len: number): bigint;
  aios_cosine_f32(aPtr: number, bPtr: number, len: number): number;
  aios_rmsnorm_f32(
    xPtr: number,
    wPtr: number,
    outPtr: number,
    len: number,
    eps: number,
  ): number;
  aios_posix_glob_match(
    patPtr: number,
    patLen: number,
    txtPtr: number,
    txtLen: number,
  ): number;
}

interface ZigWasmExports {
  memory: WebAssembly.Memory;
  zig_scratch_ptr(): number;
  zig_cosine_f32(aPtr: number, bPtr: number, len: number): number;
  zig_fnv1a64(ptr: number, len: number): bigint;
}

let rustInstance: RustWasmExports | null = null;
let zigInstance: ZigWasmExports | null = null;

export function getRustWasmKernel(): {
  abiVersion: number;
  wasmSizeBytes: number;
  fnv1a64Hex(input: Uint8Array | string): string;
  cosineSimilarity(a: Float32Array, b: Float32Array): number;
  rmsNorm(x: Float32Array, weight: Float32Array, eps?: number): Float32Array;
  globMatch(pattern: string, text: string): boolean;
} {
  if (!rustInstance) {
    const bytes = decodeBase64ToBytes(RUST_WASM_KERNEL_B64);
    const mod = new WebAssembly.Module(bytes as BufferSource);
    const inst = new WebAssembly.Instance(mod, {});
    rustInstance = inst.exports as unknown as RustWasmExports;
  }
  const exp = rustInstance;
  const basePtr = exp.aios_scratch_ptr();
  const encoder = new TextEncoder();

  return {
    abiVersion: exp.aios_abi_version(),
    wasmSizeBytes: RUST_WASM_BYTES_LEN,
    fnv1a64Hex(input: Uint8Array | string): string {
      const bytes = typeof input === "string" ? encoder.encode(input) : input;
      const len = Math.min(bytes.length, 65536);
      new Uint8Array(exp.memory.buffer, basePtr, len).set(
        bytes.subarray(0, len),
      );
      const h = BigInt.asUintN(64, exp.aios_fnv1a64(basePtr, len));
      return h.toString(16).padStart(16, "0");
    },
    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      const len = Math.min(a.length, b.length, 4096);
      const aOffset = basePtr;
      const bOffset = basePtr + len * 4;
      new Float32Array(exp.memory.buffer, aOffset, len).set(a.subarray(0, len));
      new Float32Array(exp.memory.buffer, bOffset, len).set(b.subarray(0, len));
      return exp.aios_cosine_f32(aOffset, bOffset, len);
    },
    rmsNorm(x: Float32Array, weight: Float32Array, eps = 1e-6): Float32Array {
      const len = Math.min(x.length, weight.length, 4096);
      const xOff = basePtr;
      const wOff = basePtr + len * 4;
      const outOff = basePtr + len * 8;
      new Float32Array(exp.memory.buffer, xOff, len).set(x.subarray(0, len));
      new Float32Array(exp.memory.buffer, wOff, len).set(
        weight.subarray(0, len),
      );
      exp.aios_rmsnorm_f32(xOff, wOff, outOff, len, eps);
      return new Float32Array(
        exp.memory.buffer.slice(outOff, outOff + len * 4),
      );
    },
    globMatch(pattern: string, text: string): boolean {
      const pBytes = encoder.encode(pattern);
      const tBytes = encoder.encode(text);
      const pOff = basePtr;
      const tOff = basePtr + pBytes.length;
      new Uint8Array(exp.memory.buffer, pOff, pBytes.length).set(pBytes);
      new Uint8Array(exp.memory.buffer, tOff, tBytes.length).set(tBytes);
      return (
        exp.aios_posix_glob_match(pOff, pBytes.length, tOff, tBytes.length) ===
        1
      );
    },
  };
}

export function getZigWasmKernel(): {
  wasmSizeBytes: number;
  fnv1a64Hex(input: Uint8Array | string): string;
  cosineSimilarity(a: Float32Array, b: Float32Array): number;
} {
  if (!zigInstance) {
    const bytes = decodeBase64ToBytes(ZIG_WASM_KERNEL_B64);
    const mod = new WebAssembly.Module(bytes as BufferSource);
    const inst = new WebAssembly.Instance(mod, {});
    zigInstance = inst.exports as unknown as ZigWasmExports;
  }
  const exp = zigInstance;
  const basePtr = exp.zig_scratch_ptr();
  const encoder = new TextEncoder();

  return {
    wasmSizeBytes: ZIG_WASM_BYTES_LEN,
    fnv1a64Hex(input: Uint8Array | string): string {
      const bytes = typeof input === "string" ? encoder.encode(input) : input;
      const len = Math.min(bytes.length, 65536);
      new Uint8Array(exp.memory.buffer, basePtr, len).set(
        bytes.subarray(0, len),
      );
      const h = BigInt.asUintN(64, exp.zig_fnv1a64(basePtr, len));
      return h.toString(16).padStart(16, "0");
    },
    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      const len = Math.min(a.length, b.length, 4096);
      const aOff = basePtr;
      const bOff = basePtr + len * 4;
      new Float32Array(exp.memory.buffer, aOff, len).set(a.subarray(0, len));
      new Float32Array(exp.memory.buffer, bOff, len).set(b.subarray(0, len));
      return exp.zig_cosine_f32(aOff, bOff, len);
    },
  };
}

export function inspectWasmAndWebGpuCapabilities(): {
  wasmSupported: boolean;
  rustWasmBytes: number;
  zigWasmBytes: number;
  rustAbiVersionHex: string;
  webgpuNavigatorPresent: boolean;
  wgslShaders: string[];
} {
  const rust = getRustWasmKernel();
  const nav = globalThis.navigator as unknown as { gpu?: unknown } | undefined;
  return {
    wasmSupported: typeof WebAssembly !== "undefined",
    rustWasmBytes: RUST_WASM_BYTES_LEN,
    zigWasmBytes: ZIG_WASM_BYTES_LEN,
    rustAbiVersionHex: `0x${rust.abiVersion.toString(16)}`,
    webgpuNavigatorPresent: Boolean(nav && nav.gpu),
    wgslShaders: Object.keys(WEBGPU_WGSL_SHADERS),
  };
}
