// Host of the shared plugin surface: reads oh-my-niu `plugins/<name>/plugin.toml` and, for plugins that declare a
// `[bun]` entry, registers them with Bun.plugin. niu reads the same plugin.toml through its own loader (oh-my-niu.niu),
// so one directory serves both hosts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { plugin as register } from "bun";
import type { BunPlugin } from "bun";

export interface HostedPlugin {
  name: string;
  version: string;
  dir: string;
  /** Entry sourced by niu. */
  entry: string;
  /** Bun host entry and the module name it provides, when the plugin has one. */
  bun?: { entry: string; module: string };
}

/** Root of the bundle: `$OMNIU_ROOT`, else the package directory. */
export function bundleRoot(): string {
  return Bun.env.OMNIU_ROOT ?? join(import.meta.dir, "..");
}

/** Every framework plugin of `root/plugins`, sorted by name. */
export function discover(root: string = bundleRoot()): HostedPlugin[] {
  const dir = join(root, "plugins");
  if (!existsSync(dir)) return [];
  const out: HostedPlugin[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const manifestPath = join(dir, e.name, "plugin.toml");
    if (!e.isDirectory() || !existsSync(manifestPath)) continue;
    const m = Bun.TOML.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
    const bun = m.bun && typeof m.bun.entry === "string" ? { entry: m.bun.entry as string, module: String(m.bun.module ?? m.name) } : undefined;
    out.push({ name: String(m.name), version: String(m.version), dir: join(dir, e.name), entry: String(m.entry), bun });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Import the Bun entry of each plugin that has one and register its default export; returns the module names provided. */
export async function loadBunPlugins(root: string = bundleRoot(), only?: string[]): Promise<string[]> {
  const loaded: string[] = [];
  for (const p of discover(root)) {
    if (!p.bun || (only && !only.includes(p.name))) continue;
    // A file URL: a bare Windows path (`C:\\...`) is not a valid module specifier.
    const mod = await import(pathToFileURL(join(p.dir, p.bun.entry)).href);
    const exported = mod.default as BunPlugin | ((plugin: HostedPlugin) => BunPlugin) | undefined;
    if (!exported) throw new Error(`${p.name}: ${p.bun.entry} has no default export`);
    register(typeof exported === "function" ? exported(p) : exported);
    loaded.push(p.bun.module);
  }
  return loaded;
}
