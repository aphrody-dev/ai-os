// Bun-side wrapper: shells to the Rust CLI (`py2bun-rs`, crate system/py2bun).
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Diagnostic {
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
}
export interface TranspileResult {
  /** Bun TypeScript; empty on a syntax error. */
  ts: string;
  diagnostics: Diagnostic[];
  /** true when `ts` was produced and no error diagnostics exist. */
  ok: boolean;
}

const exe = process.platform === "win32" ? ".exe" : "";

/** Resolve the CLI: $PY2BUN_BIN, then `py2bun-rs` on PATH, then the crate's cargo target dirs. */
export function findBinary(): string | null {
  const env = process.env.PY2BUN_BIN;
  if (env && existsSync(env)) return env;
  const onPath = Bun.which("py2bun-rs");
  if (onPath) return onPath;
  const here = import.meta.dir;
  const crate = join(here, "..", "..", "..", "system", "py2bun");
  const targets = [process.env.CARGO_TARGET_DIR, join(crate, "target")].filter((t): t is string => !!t);
  for (const t of targets) for (const prof of ["release", "debug"]) {
    const p = join(t, prof, `py2bun-rs${exe}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Transpile Python source to Bun TypeScript. */
export function transpile(source: string, bin: string | null = findBinary(), mode: "auto" | "async" | "sync" = "auto"): TranspileResult {
  if (!bin) throw new Error("py2bun-rs not found: set PY2BUN_BIN or build system/py2bun (cargo build --release)");
  const args = [bin, "-", "--json", ...(mode === "async" ? ["--async"] : mode === "sync" ? ["--sync"] : [])];
  const p = Bun.spawnSync(args, { stdin: new TextEncoder().encode(source), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode === 2 || p.exitCode === null || p.signalCode) {
    throw new Error(`py2bun-rs failed (exit ${p.exitCode}${p.signalCode ? `, signal ${p.signalCode}` : ""}): ${p.stderr.toString().trim()}`);
  }
  const diagnostics: Diagnostic[] = [];
  for (const l of p.stderr.toString().split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      diagnostics.push(JSON.parse(l));
    } catch (e) {
      diagnostics.push({ line: 0, col: 0, severity: "error", message: `unparseable diagnostic: ${l}` } as Diagnostic);
    }
  }
  const ts = p.stdout.toString();
  return { ts, diagnostics, ok: ts.length > 0 && !diagnostics.some((d) => d.severity === "error") };
}

/** Transpile a .py file; writes `out` when given. */
export async function transpileFile(path: string, out?: string, bin?: string | null, mode: "auto" | "async" | "sync" = "auto"): Promise<TranspileResult> {
  const r = transpile(await Bun.file(path).text(), bin ?? findBinary(), mode);
  if (out && r.ts) await Bun.write(out, r.ts);
  return r;
}
