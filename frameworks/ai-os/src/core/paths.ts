// Where things live, derived and never written down: the checkout root, the data directory and the `.env` file.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Root of the checkout: $WORKSPACE_ROOT, then $SRC_ROOT, else the nearest ancestor of `from` holding `.git`, else four levels above this file. */
export function workspaceRoot(from: string = import.meta.dir): string {
  const explicit =
    process.env.WORKSPACE_ROOT?.trim() || process.env.SRC_ROOT?.trim();
  if (explicit) return resolve(explicit);
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir)
      return resolve(import.meta.dir, "..", "..", "..", "..");
  }
}

/** Mutable data of the workspace: $AY_DATA_DIR, else `<root>/var`; `parts` are joined below it. */
export function dataDir(...parts: string[]): string {
  return join(
    process.env.AY_DATA_DIR?.trim() || join(workspaceRoot(), "var"),
    ...parts,
  );
}

/** The `.env` file: $ENV_FILE, else the nearest `.env` from the current directory upward, else `<root>/.env`. */
export function envFile(): string {
  const explicit = process.env.ENV_FILE?.trim();
  if (explicit) return resolve(explicit);
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".env"))) return join(dir, ".env");
    if (dirname(dir) === dir) return join(workspaceRoot(), ".env");
  }
}
