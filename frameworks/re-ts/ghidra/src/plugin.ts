// Bun plugin: `import analysis from "./x.exe?ghidra"` and the `ghidra:` namespace (`ghidra:./x.exe`).
// Works with Bun.plugin() (runtime, bunfig preload) and Bun.build() (onStart/onResolve/onLoad with defer).
// onBeforeParse (native) only exists in Bun.build: see nativeGhidraPlugin().
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { openProgram, started, stop } from "./api.ts";
import { summarize, type ProgramSummary } from "./analysis.ts";

export interface GhidraPluginOptions {
  /** "jvm" (full Ghidra through the bridge, default) or "native" (aphrody-re via the NAPI addon). */
  backend?: "jvm" | "native";
  /** path to the aphrody_ghidra_bun .node addon (needed for backend native) */
  nativeAddon?: string;
  /** decompile every function with the Ghidra decompiler (JVM backend) */
  decompile?: boolean;
  maxFunctions?: number;
  projectLocation?: string;
  /** Bun.build only: wait for all other modules before the heavy analysis (onLoad `defer`) */
  deferAnalysis?: boolean;
  /** stop the JVM when the Bun.build finishes (no onEnd in Bun's plugin API: done via process exit hook) */
  keepAlive?: boolean;
}

const QUERY = /\?ghidra(=[a-z]+)?(&.*)?$/;

export function parseSpecifier(spec: string): { file: string; backend?: "jvm" | "native" } | null {
  let rest = spec;
  const ns = spec.startsWith("ghidra:");
  if (ns) rest = spec.slice("ghidra:".length);
  const m = rest.match(QUERY);
  if (!m) return ns ? { file: rest } : null;
  const b = m[1]?.slice(1);
  if (b !== undefined && b !== "native" && b !== "jvm") throw new Error(`ghidra: unknown backend "${b}" (expected jvm or native)`);
  return { file: rest.slice(0, m.index), backend: b };
}

/** BinarySreReport (aphrody-re) -> the ProgramSummary shape of the JVM backend. */
function normalizeNative(rep: any): Record<string, any> {
  if (rep === null || typeof rep !== "object" || Array.isArray(rep)) throw new Error("ghidra: analysis result is not an object");
  const fns = (rep.decompiled_functions ?? []).map((f: any) => ({
    name: f.name, entry: typeof f.entry_va === "number" ? "0x" + f.entry_va.toString(16) : f.entry, size: f.size_bytes ?? f.size,
    signature: f.signature ?? "", callingConvention: null, isThunk: false, isExternal: false, c: f.pseudo_c ?? f.c,
  }));
  return {
    ...rep,
    name: rep.binary_path ? basename(String(rep.binary_path)) : rep.name,
    language: rep.language ?? rep.format ?? null,
    blocks: rep.sections ?? rep.blocks ?? [],
    functions: fns,
    functionCount: fns.length,
  };
}

export function renderModule(s: ProgramSummary | Record<string, any>): string {
  const json = JSON.stringify(s);
  return `const analysis = ${json};
export default analysis;
export const functions = analysis.functions ?? analysis.decompiled_functions ?? [];
export const blocks = analysis.blocks ?? analysis.sections ?? [];
export const name = analysis.name ?? analysis.binary_path;
export const language = analysis.language;
export const functionCount = analysis.functionCount ?? functions.length;
`;
}

const cache = new Map<string, Promise<string>>();

async function analyzeToModule(file: string, backend: "jvm" | "native", o: GhidraPluginOptions): Promise<string> {
  const key = `${backend}:${file}:${o.decompile}:${o.maxFunctions}:${o.projectLocation}:${o.nativeAddon}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      if (backend === "native") {
        const addon = o.nativeAddon ?? process.env.GHIDRA_BUN_NATIVE;
        if (!addon) throw new Error("backend native needs nativeAddon or GHIDRA_BUN_NATIVE");
        const mod = require(isAbsolute(addon) ? addon : resolve(process.cwd(), addon)) as { analyze(path: string, max?: number): string };
        return renderModule(normalizeNative(JSON.parse(mod.analyze(file, o.maxFunctions))));
      }
      // project name carries a hash of the absolute path: /a/foo.exe and /b/foo.exe must not share a program
      const h = await openProgram(file, {
        projectLocation: o.projectLocation ?? join(tmpdir(), "bun-ghidra-projects"),
        projectName: `${basename(file)}_${Bun.hash(resolve(file)).toString(16)}`,
      });
      try {
        return renderModule(await summarize(h.program, { max: o.maxFunctions, decompile: o.decompile }));
      } finally {
        await h.close();
      }
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key)); // never keep a rejected analysis
  }
  return p;
}

let hooked = false;

export function ghidraPlugin(o: GhidraPluginOptions = {}): BunPlugin {
  return {
    name: "aphrody-ghidra",
    setup(build) {
      build.onStart(() => { cache.clear(); });
      if (!hooked) {
        hooked = true;
        process.once("beforeExit", () => { if (!o.keepAlive) void shutdown(); });
      }
      build.onResolve({ filter: /\?ghidra(=[a-z]+)?(&.*)?$|^ghidra:/ }, (args) => {
        const spec = parseSpecifier(args.path);
        if (!spec) return undefined;
        const base = args.importer ? dirname(args.importer) : process.cwd();
        const abs = isAbsolute(spec.file) ? spec.file : resolve(base, spec.file);
        if (!existsSync(abs)) throw new Error(`ghidra: no such file ${abs}`);
        return { path: abs + "#" + (spec.backend ?? ""), namespace: "ghidra" }; // always suffixed: a path containing `#` stays intact
      });
      build.onLoad({ filter: /.*/, namespace: "ghidra" }, async (args: any) => {
        if (o.deferAnalysis && typeof args.defer === "function") await args.defer();
        const hash = args.path.lastIndexOf("#");
        const file = hash >= 0 ? args.path.slice(0, hash) : args.path;
        const tag = hash >= 0 ? args.path.slice(hash + 1) : undefined;
        const backend = (tag ? (tag as "jvm" | "native") : undefined) ?? o.backend ?? "jvm";
        return { contents: await analyzeToModule(file, backend, o), loader: "js" };
      });
    },
  };
}

/** Build-only native onBeforeParse plugin (Rust cdylib in system/ghidra-bun): files `*.ghidra.js` become analysis modules. */
export function nativeGhidraPlugin(addonPath: string, filter = /\.ghidra\.js$/): BunPlugin {
  return {
    name: "aphrody-ghidra-native",
    setup(build) {
      const napiModule = require(addonPath);
      (build as any).onBeforeParse({ filter }, { napiModule, symbol: "ghidra_on_before_parse" });
    },
  };
}

export async function shutdown() { if (started()) await stop(); }
