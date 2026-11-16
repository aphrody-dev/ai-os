// The ay plugin for Bun. `ayPlugin()` registers the virtual module "ay" (Bun.plugin), so that any script can
// `import { run, sh, manifest } from "ay"`. The same plugin is described by plugins/ay/plugin.toml for niu;
// both hosts read the manifest the binary emits (`ay plugin manifest`), the single source of the command table.
import type { BunPlugin } from "bun";

/** Manifest schema; a host refuses another major. */
export const API = "aphrody:plugin@0.1.0";

export interface AyManifest {
  api: string;
  name: string;
  version: string;
  engine: { name: string; build: string };
  commands: { name: string; about: string }[];
  hosts: { niu: { api: string; manifest: string }; bun: { module: string; entry: string } };
}

export interface AyResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AyOptions {
  /** The ay binary (or a command prefix, e.g. `[bun, script]`); default `$AY_BIN`, then `ay` on PATH. */
  bin?: string | string[];
  cwd?: string;
  stdin?: string;
  env?: Record<string, string>;
}

/** The ay binary to run. */
export function resolveAy(bin?: string | string[]): string[] {
  const found = bin ?? Bun.env.AY_BIN ?? Bun.which("ay");
  if (!found) throw new Error("ay not found: set AY_BIN or put ay on PATH (cargo build -p aphrody)");
  return Array.isArray(found) ? found : [found];
}

/** Run `ay <args>` and collect its output. */
export async function run(args: string[], opts: AyOptions = {}): Promise<AyResult> {
  const proc = Bun.spawn([...resolveAy(opts.bin), ...args], {
    cwd: opts.cwd,
    env: { ...Bun.env, ...opts.env, AY_PLUGIN_HOST: "bun" },
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { code, stdout, stderr };
}

/** Run a command string through the Bash engine embedded in ay (`ay sh -c`); `args` become `$1...`. */
export function sh(command: string, args: string[] = [], opts: AyOptions = {}): Promise<AyResult> {
  return run(["sh", "-c", command, "ay-sh", ...args], opts);
}

/** The manifest of the ay binary. Throws when the binary predates `ay plugin` or speaks another schema major. */
export async function manifest(opts: AyOptions = {}): Promise<AyManifest> {
  const r = await run(["plugin", "manifest"], opts);
  if (r.code !== 0) throw new Error(`ay plugin manifest failed (${r.code}): ${r.stderr.trim() || "binary without the plugin command"}`);
  const m = JSON.parse(r.stdout) as AyManifest;
  const major = (api: string) => api.split("@")[1]?.split(".")[0];
  if (m.api.split("@")[0] !== API.split("@")[0] || major(m.api) !== major(API)) throw new Error(`unsupported ay plugin api ${m.api}, host speaks ${API}`);
  return m;
}

/** The subcommand names of the ay binary. */
export async function commands(opts: AyOptions = {}): Promise<string[]> {
  return (await manifest(opts)).commands.map((c) => c.name);
}

/** The Bun plugin: registers the virtual module "ay". */
export function ayPlugin(defaults: AyOptions = {}): BunPlugin {
  // Per-call options win, but the environment is merged: a call that adds one variable keeps the defaults of the plugin.
  const merge = (o: AyOptions = {}): AyOptions => ({ ...defaults, ...o, env: { ...defaults.env, ...o.env } });
  return {
    name: "ay",
    setup(build) {
      build.module("ay", () => ({
        loader: "object",
        exports: {
          API,
          resolveAy: (bin?: string | string[]) => resolveAy(bin ?? defaults.bin),
          run: (args: string[], o?: AyOptions) => run(args, merge(o)),
          sh: (command: string, args?: string[], o?: AyOptions) => sh(command, args, merge(o)),
          manifest: (o?: AyOptions) => manifest(merge(o)),
          commands: (o?: AyOptions) => commands(merge(o)),
        },
      }));
    },
  };
}
