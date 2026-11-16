import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");

/** A throwaway copy of the bundle (data only), for tests that mutate it. */
export function copyBundle(): string {
  const dst = mkdtempSync(join(tmpdir(), "omniu-test-"));
  const keep = ["lib", "plugins", "packs", "aliases", "completions", "prompts", "keybindings", "themes", "docs", "templates", "tools", "envs"];
  for (const d of keep) cpSync(join(ROOT, d), join(dst, d), { recursive: true });
  for (const f of ["oh-my-niu.niu", "bundle.toml", "index.toml", "CHANGELOG.md", "framework-plugins.toml"]) cpSync(join(ROOT, f), join(dst, f));
  return dst;
}
