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

/**
 * The `.env` files secrets are read from, in order: $ENV_FILE, then `<root>/.env` of the workspace. Both are resolved from the
 * configuration, never from the current directory: a `.env` found there is untrusted input and must not decide what is redacted.
 */
export function envFiles(): string[] {
  const explicit = process.env.ENV_FILE?.trim();
  return [
    ...new Set([
      ...(explicit ? [resolve(explicit)] : []),
      join(workspaceRoot(), ".env"),
    ]),
  ];
}

/** The `.env` to read first: $ENV_FILE, else `<root>/.env`. */
export function envFile(): string {
  return envFiles()[0]!;
}

/**
 * Every existing `.env` of {@link envFiles}. Throws when none exists: a caller that redacts or syncs secrets must refuse to run
 * without knowing them rather than let them through.
 */
export function requireEnvFiles(): string[] {
  const found = envFiles().filter((f) => existsSync(f));
  if (found.length === 0)
    throw new Error(
      `no .env found (looked at: ${envFiles().join(", ")}); set ENV_FILE or WORKSPACE_ROOT`,
    );
  return found;
}
