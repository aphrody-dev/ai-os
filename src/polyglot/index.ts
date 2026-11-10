import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getCudaFfi,
  getPolyglotFfi,
  type CudaSm89Telemetry,
} from "../ffi/polyglot.ts";

export interface BinaryStatus {
  name: string;
  path: string;
  exists: boolean;
  version?: string;
}

export interface PolyglotEcosystemReport {
  ok: boolean;
  generatedAt: string;
  hardware: CudaSm89Telemetry | { ok: false; detail: string };
  submodulesSummary: {
    manifestExists: boolean;
    totalConfigured: number;
    totalCloned: number;
    byCategory: Record<string, number>;
  };
  astralPythonRustStack: {
    uv: BinaryStatus;
    ruff: BinaryStatus;
    ty: BinaryStatus;
    maturin: BinaryStatus;
    cpython315: BinaryStatus;
    cpython315FreeThreaded: BinaryStatus;
    pythonVenvReady: boolean;
  };
  bareMetalBinaries: {
    cudaSm89Dll: BinaryStatus;
    cudaScanCli: BinaryStatus;
    polyglotRustFfiDll: BinaryStatus;
    llamaCli: BinaryStatus;
    llamaServer: BinaryStatus;
    llamaBench: BinaryStatus;
    llamaCpuNoGpuCli: BinaryStatus;
    llamaCpuNoGpuServer: BinaryStatus;
    whisperCli: BinaryStatus;
    ring3Daemon: BinaryStatus;
  };
  ffiSmokeCheck: {
    polyglotLoaded: boolean;
    polyglotAbiVersion: number;
    avx2DotProductOk: boolean;
    ragBatchCosineTopIdx: number;
    hereticAbliterationResidual: number;
    treeSitterPythonSymbols: number;
    bitnetTernaryGemvOk: boolean;
    system1TransducerOk: boolean;
    hostCpuSsdTuned: boolean;
  };
}

function quickVersion(binPath: string, args = ["--version"]): string | undefined {
  if (!existsSync(binPath)) return undefined;
  try {
    const proc = Bun.spawnSync([binPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out =
      proc.stdout.toString("utf8").trim() ||
      proc.stderr.toString("utf8").trim();
    const firstLine = out.split(/\r?\n/)[0]?.trim();
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

function resolveToolBinary(name: string, candidates: string[]): BinaryStatus {
  for (const c of candidates) {
    if (existsSync(c)) {
      const p = resolve(c).replace(/\\/g, "/");
      return { name, path: p, exists: true, version: quickVersion(c) };
    }
  }
  const whichFound = Bun.which(name);
  if (whichFound && existsSync(whichFound)) {
    const p = resolve(whichFound).replace(/\\/g, "/");
    return { name, path: p, exists: true, version: quickVersion(whichFound) };
  }
  return {
    name,
    path: (candidates[0] ?? name).replace(/\\/g, "/"),
    exists: false,
  };
}

export function inspectPolyglotEcosystem(options: {
  quickGpu?: boolean;
  aiOsRoot?: string;
} = {}): PolyglotEcosystemReport {
  const root = resolve(options.aiOsRoot ?? "C:/src/ai-os");
  const manifestPath = resolve(root, "SUBMODULES_ECOSYSTEM_MANIFEST.json");

  let submodulesSummary = {
    manifestExists: existsSync(manifestPath),
    totalConfigured: 0,
    totalCloned: 0,
    byCategory: {} as Record<string, number>,
  };

  if (submodulesSummary.manifestExists) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        totalConfigured?: number;
        totalCloned?: number;
        byCategory?: Record<string, number>;
      };
      submodulesSummary = {
        manifestExists: true,
        totalConfigured: parsed.totalConfigured ?? 0,
        totalCloned: parsed.totalCloned ?? 0,
        byCategory: parsed.byCategory ?? {},
      };
    } catch {
      // keep defaults
    }
  }

  // GPU CUDA sm_89 telemetry via direct bun:ffi
  const cudaFfi = getCudaFfi();
  const hardware = cudaFfi
    ? cudaFfi.scanAndBench(options.quickGpu ?? true)
    : { ok: false as const, detail: "sovereign_cuda_sm89.dll not loaded" };

  // Astral + CPython 3.15 + Free-Threaded 3.15t
  const home = (process.env.USERPROFILE ?? "C:/Users/aphro").replace(/\\/g, "/");
  const uvBin = resolveToolBinary("uv", [
    `${home}/AppData/Local/Microsoft/WinGet/Links/uv.exe`,
    `${home}/.local/bin/uv.exe`,
  ]);
  const ruffBin = resolveToolBinary("ruff", [`${home}/.local/bin/ruff.exe`]);
  const tyBin = resolveToolBinary("ty", [`${home}/.local/bin/ty.exe`]);
  const maturinBin = resolveToolBinary("maturin", [
    `${home}/.local/bin/maturin.exe`,
  ]);
  const cpython315 = resolveToolBinary("python3.15", [
    `${home}/.local/bin/python3.15.exe`,
    `${home}/AppData/Roaming/uv/python/cpython-3.15.2-windows-x86_64-none/python.exe`,
  ]);
  const cpython315t = resolveToolBinary("python3.15t", [
    `${home}/.local/bin/python3.15t.exe`,
    `${home}/AppData/Roaming/uv/python/cpython-3.15.2+freethreaded-windows-x86_64-none/python.exe`,
  ]);
  const venvPy = resolve(root, "python/.venv/Scripts/python.exe");

  // Bare-metal C/C++/CUDA/Rust binaries
  const cudaSm89Dll: BinaryStatus = {
    name: "sovereign_cuda_sm89.dll",
    path: `${home}/.local/bin/sovereign_cuda_sm89.dll`,
    exists: existsSync(`${home}/.local/bin/sovereign_cuda_sm89.dll`),
    version: cudaFfi ? `ABI v${cudaFfi.abiVersion} (sm_89)` : undefined,
  };
  const cudaScanCli = resolveToolBinary("sovereign-cuda-scan", [
    `${home}/.local/bin/sovereign-cuda-scan.exe`,
  ]);
  const polyFfi = getPolyglotFfi();
  const polyglotRustFfiDll: BinaryStatus = {
    name: "sovereign_polyglot_ffi.dll",
    path: `${home}/.local/bin/sovereign_polyglot_ffi.dll`,
    exists: existsSync(`${home}/.local/bin/sovereign_polyglot_ffi.dll`),
    version: polyFfi ? `ABI v${polyFfi.abiVersion} (Fat-LTO AVX2)` : undefined,
  };

  const llamaCli = resolveToolBinary("llama-cli", [
    `${home}/.local/bin/llama-cli.exe`,
    `${root}/native/build-llama/bin/llama-cli.exe`,
  ]);
  const llamaServer = resolveToolBinary("llama-server", [
    `${home}/.local/bin/llama-server.exe`,
    `${root}/native/build-llama/bin/llama-server.exe`,
  ]);
  const llamaBench = resolveToolBinary("llama-bench", [
    `${home}/.local/bin/llama-bench.exe`,
    `${root}/native/build-llama/bin/llama-bench.exe`,
  ]);
  const llamaCpuNoGpuCli = resolveToolBinary("llama-cpu-cli", [
    `${home}/.local/bin/llama-cpu-nogpu/llama-cli.exe`,
    `${root}/native/build-llama-cpu/bin/llama-cli.exe`,
  ]);
  const llamaCpuNoGpuServer = resolveToolBinary("llama-cpu-server", [
    `${home}/.local/bin/llama-cpu-nogpu/llama-server.exe`,
    `${root}/native/build-llama-cpu/bin/llama-server.exe`,
  ]);
  const whisperCli = resolveToolBinary("whisper-cli", [
    `${home}/.local/bin/whisper-cli.exe`,
    `${root}/native/build-whisper/bin/whisper-cli.exe`,
  ]);
  const ring3Daemon = resolveToolBinary("r3d", [`${home}/.local/bin/r3d.exe`]);

  // Zero-copy FFI smoke check (AVX2 dot, RAG batch cosine, Heretic abliteration, Tree-sitter AST, System-1 BitNet/SSD)
  let ffiSmokeCheck = {
    polyglotLoaded: false,
    polyglotAbiVersion: 0,
    avx2DotProductOk: false,
    ragBatchCosineTopIdx: -1,
    hereticAbliterationResidual: -1,
    treeSitterPythonSymbols: 0,
    bitnetTernaryGemvOk: false,
    system1TransducerOk: false,
    hostCpuSsdTuned: false,
  };

  if (polyFfi) {
    const a = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const dot = polyFfi.dotProductF32(a, b); // 36

    const q = new Float32Array([1, 0, 0, 0]);
    const corpus = new Float32Array([
      0, 1, 0, 0, // doc 0 -> 0.0
      0.9, 0.1, 0, 0, // doc 1 -> ~0.9938 (top)
      -1, 0, 0, 0, // doc 2 -> -1.0
    ]);
    const ragScores = polyFfi.cosineRagBatch(q, corpus, 4);
    let topIdx = 0;
    for (let i = 1; i < ragScores.length; i++) {
      if ((ragScores[i] ?? -2) > (ragScores[topIdx] ?? -2)) topIdx = i;
    }

    const w = new Float32Array([5, 3, 2, 1, -4, 2, 0, 1]); // 2x4
    const r = new Float32Array([1, 0, 0, 0]); // unit vector along dim 0
    polyFfi.hereticAbliterateInPlace(w, r, 2, 4, 1.0);
    const residual = Math.abs(w[0] ?? 999) + Math.abs(w[4] ?? 999);

    const ast = polyFfi.parseAst(
      "python",
      "class Trainer:\n    def step(self, batch):\n        return batch\n",
    );

    // BitNet 1.58-bit Ternary + PowerInfer Sparse GEMV check (32 features, 2 rows: row 0 hot, row 1 cold)
    const row0 = new Float32Array(32).fill(1.0);
    const row1 = new Float32Array(32).fill(-1.0);
    const p0 = polyFfi.packTernaryRow(row0);
    const p1 = polyFfi.packTernaryRow(row1);
    const packedMat = new Uint8Array(p0.packed.length + p1.packed.length);
    packedMat.set(p0.packed, 0);
    packedMat.set(p1.packed, p0.packed.length);
    const scales = new Float32Array([p0.scale, p1.scale]);
    const hotMask = new Uint8Array([1, 0]); // row 0 active in RAM, row 1 cold skipped
    const actX = new Float32Array(32).fill(1.0);
    const gemv = polyFfi.bitnetSparseGemv(packedMat, scales, hotMask, actX, 2, 32);

    const trans = polyFfi.transduceVerboseToSystem1(
      '<think>verbose chain of thought</think>{"tool":"bun:sqlite","arguments":{"wal":true}}',
    );
    const tune = polyFfi.tuneHostCpuSsd();

    ffiSmokeCheck = {
      polyglotLoaded: true,
      polyglotAbiVersion: polyFfi.abiVersion,
      avx2DotProductOk: Math.abs(dot - 36) < 1e-4,
      ragBatchCosineTopIdx: topIdx,
      hereticAbliterationResidual: Math.round(residual * 1e6) / 1e6,
      treeSitterPythonSymbols: ast.symbols?.length ?? 0,
      bitnetTernaryGemvOk:
        gemv.activeRowsEvaluated === 1 &&
        (gemv.out[0] ?? 0) > 30 &&
        (gemv.out[1] ?? 1) === 0,
      system1TransducerOk:
        trans.ok &&
        trans.decision === "BUN_API" &&
        trans.tool_or_api === "bun:sqlite",
      hostCpuSsdTuned: Boolean(tune.ok),
    };
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    hardware,
    submodulesSummary,
    astralPythonRustStack: {
      uv: uvBin,
      ruff: ruffBin,
      ty: tyBin,
      maturin: maturinBin,
      cpython315,
      cpython315FreeThreaded: cpython315t,
      pythonVenvReady: existsSync(venvPy),
    },
    bareMetalBinaries: {
      cudaSm89Dll,
      cudaScanCli,
      polyglotRustFfiDll,
      llamaCli,
      llamaServer,
      llamaBench,
      llamaCpuNoGpuCli,
      llamaCpuNoGpuServer,
      whisperCli,
      ring3Daemon,
    },
    ffiSmokeCheck,
  };
}

export async function runPythonPolyglotScan(
  aiOsRoot = "C:/src/ai-os",
): Promise<Record<string, unknown>> {
  const pyDir = resolve(aiOsRoot, "python");
  const venvPy = resolve(pyDir, ".venv/Scripts/python.exe");
  const cmd = existsSync(venvPy)
    ? [venvPy, "-m", "ai_os_stack"]
    : ["uv", "run", "--directory", pyDir, "python", "-m", "ai_os_stack"];

  const proc = Bun.spawn(cmd, {
    cwd: pyDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    return {
      ok: false,
      exitCode,
      error: stderr.trim() || stdout.trim(),
    };
  }
  try {
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return { ok: true, raw: stdout.trim() };
  }
}
