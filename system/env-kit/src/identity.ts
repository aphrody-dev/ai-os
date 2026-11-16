// Product identity read from tools/identity.toml (single source: the binary name is never written in messages).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Repository root: $SRC_ROOT, otherwise the nearest ancestor holding tools/identity.toml. */
export function identityRoot(from = import.meta.dir): string {
  if (process.env.SRC_ROOT) return process.env.SRC_ROOT;
  let d = resolve(from);
  for (;;) {
    if (existsSync(join(d, "tools", "identity.toml"))) return d;
    const up = dirname(d);
    if (up === d) return resolve(from, "..", "..", "..");
    d = up;
  }
}

type Identity = {
  cli?: { binary?: string };
  products?: Record<string, { binary?: string }>;
};

export function readIdentity(root = identityRoot()): Identity {
  try {
    return Bun.TOML.parse(
      readFileSync(join(root, "tools", "identity.toml"), "utf8"),
    ) as Identity;
  } catch {
    return {};
  }
}

/** Main CLI (`[cli].binary`). */
export const cliBinary = (root?: string) =>
  readIdentity(root).cli?.binary ?? "ay";

/** Binary of a sub-product (`[products.<name>].binary`). */
export const productBinary = (name: string, root?: string) =>
  readIdentity(root).products?.[name]?.binary ?? name;
