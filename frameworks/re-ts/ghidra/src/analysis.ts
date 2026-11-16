// High-level analysis helpers shared by the plugin, parity tests and the CLI.
import type { JObject } from "./rpc.ts";
import { jvm, taskMonitor } from "./api.ts";

export interface FunctionInfo {
  name: string;
  entry: string;
  size: number;
  signature: string;
  callingConvention: string | null;
  isThunk: boolean;
  isExternal: boolean;
  c?: string;
}

export interface ProgramSummary {
  name: string;
  language: string;
  compiler: string;
  format: string;
  imageBase: string;
  minAddress: string | null;
  maxAddress: string | null;
  functionCount: number;
  symbolCount: number;
  blocks: Array<{ name: string; start: string; end: string; size: number; read: boolean; write: boolean; execute: boolean; initialized: boolean }>;
  functions: FunctionInfo[];
}

export const str = async (o: JObject | null | undefined): Promise<string | null> => (o == null ? null : String(await o.toString()));

/** Decompile `fn` with ghidra.app.decompiler.DecompInterface; returns C text or null. */
export async function decompile(program: JObject, fn: JObject, timeoutSec = 60, ifc?: JObject): Promise<string | null> {
  const s = jvm();
  const own = !ifc;
  const d: JObject = ifc ?? (await s.newObject("ghidra.app.decompiler.DecompInterface"));
  try {
    if (own) await d.openProgram(program);
    const res = await d.decompileFunction(fn, timeoutSec, await taskMonitor());
    const df = await res.getDecompiledFunction();
    return df === null ? null : String(await df.getC());
  } finally {
    if (own) await d.dispose();
  }
}

/** Open one DecompInterface for many functions. */
export async function decompiler(program: JObject): Promise<JObject> {
  const ifc = await jvm().newObject("ghidra.app.decompiler.DecompInterface");
  try {
    await ifc.openProgram(program);
  } catch (e) {
    await ifc.dispose().catch(() => {});
    throw e;
  }
  return ifc;
}

export async function listFunctions(program: JObject, opts: { max?: number; decompile?: boolean } = {}): Promise<FunctionInfo[]> {
  const fm = await program.getFunctionManager();
  const it = await fm.getFunctions(true);
  const fns = await it.$list();
  const out: FunctionInfo[] = [];
  const limit = Math.max(0, Number.isFinite(opts.max) ? Math.trunc(opts.max!) : fns.length);
  const slice = fns.slice(0, limit);
  const ifc = opts.decompile && slice.length > 0 ? await decompiler(program) : undefined;
  try {
    for (const f of slice) {
      const info: FunctionInfo = {
        name: String(await f.getName()),
        entry: String(await (await f.getEntryPoint()).toString()),
        size: Number(await (await f.getBody()).getNumAddresses()),
        signature: String(await (await f.getSignature()).getPrototypeString()),
        callingConvention: (await f.getCallingConventionName()) ?? null,
        isThunk: await f.isThunk(),
        isExternal: await f.isExternal(),
      };
      if (ifc) info.c = (await decompile(program, f, 60, ifc)) ?? undefined;
      out.push(info);
    }
  } finally {
    if (ifc) await ifc.dispose();
  }
  return out;
}

export async function summarize(program: JObject, opts: { max?: number; decompile?: boolean } = {}): Promise<ProgramSummary> {
  const mem = await program.getMemory();
  const blocks = [];
  for (const b of await (await mem.getBlocks()).$list()) {
    blocks.push({
      name: String(await b.getName()),
      start: String(await (await b.getStart()).toString()),
      end: String(await (await b.getEnd()).toString()),
      size: Number(await b.getSize()),
      read: await b.isRead(), write: await b.isWrite(), execute: await b.isExecute(), initialized: await b.isInitialized(),
    });
  }
  const st = await program.getSymbolTable();
  const fm = await program.getFunctionManager();
  return {
    name: String(await program.getName()),
    language: String(await (await program.getLanguageID()).toString()),
    compiler: String(await (await (await program.getCompilerSpec()).getCompilerSpecID()).toString()),
    format: String(await program.getExecutableFormat()),
    imageBase: String(await (await program.getImageBase()).toString()),
    minAddress: await str(await program.getMinAddress()),
    maxAddress: await str(await program.getMaxAddress()),
    functionCount: Number(await fm.getFunctionCount()),
    symbolCount: Number(await st.getNumSymbols()),
    blocks,
    functions: await listFunctions(program, opts),
  };
}
