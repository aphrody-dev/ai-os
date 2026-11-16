// Paths, persistent state and inventory loading.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type KernelState, emptyKernel } from "./kernel.ts";
import type { CrateCache, RustCache } from "./rust.ts";
import type { Announce, GnuEvent, Signature } from "./types.ts";

/** Repository root (system/gnu-ts/src -> repo). */
export const repoRoot = () => resolve(import.meta.dir, "..", "..", "..");
/** Working directory of the tracker: feed, state, staging, site. fr2 sets GNU_HOME=/srv/gnu. */
export const home = () => Bun.env.GNU_HOME ?? join(repoRoot(), "var", "gnu");
export const paths = (h = home()) => ({
  home: h,
  state: join(h, "state.json"),
  feed: join(h, "feed.json"),
  atom: join(h, "feed.atom"),
  events: join(h, "events.jsonl"),
  site: join(h, "site"),
  staging: join(h, "staging"),
});

export type State = {
  ftp: { etag?: string; mtime?: string; checked: number };
  gsrc: { revno: number | null; checked: number };
  announce: Record<string, { etag?: string; items: Announce[] }>;
  heads: Record<string, { head: string; changed_at: string; checked: number }>;
  github: RustCache;
  crates: CrateCache;
  mirror: Record<
    string,
    {
      file: string;
      sha256: string;
      key: string;
      sig_key: string | null;
      at: string;
      signature: Signature;
    }
  >;
  rust_mirror: Record<string, { tag: string; keys: string[]; at: string }>;
  kernel: KernelState;
};

export const emptyState = (): State => ({
  ftp: { checked: 0 },
  gsrc: { revno: null, checked: 0 },
  announce: {},
  heads: {},
  github: {},
  crates: {},
  mirror: {},
  rust_mirror: {},
  kernel: emptyKernel(),
});

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const f = Bun.file(file);
    return (await f.exists()) ? ((await f.json()) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Atomic write: temp file in the same directory, then rename. */
export async function writeAtomic(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await Bun.write(tmp, data);
  renameSync(tmp, file);
}

export const loadState = async (p = paths()): Promise<State> => ({
  ...emptyState(),
  ...(await readJson<Partial<State>>(p.state, {})),
});
export const saveState = (s: State, p = paths()) =>
  writeAtomic(p.state, JSON.stringify(s));

export async function appendEvents(events: GnuEvent[], p = paths()) {
  if (!events.length) return;
  mkdirSync(p.home, { recursive: true });
  const f = Bun.file(p.events);
  const prev = (await f.exists()) ? await f.text() : "";
  await Bun.write(
    p.events,
    prev + events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

export async function readEvents(p = paths()): Promise<GnuEvent[]> {
  const f = Bun.file(p.events);
  if (!(await f.exists())) return [];
  return (await f.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GnuEvent);
}

export type GsrcPkg = {
  label: string | null;
  tarball: string | null;
  version: string | null;
  description: string | null;
  home: string | null;
  subdir: string | null;
  sha256: Record<string, string>;
  builddeps: string[];
  libdeps: string[];
};
/** docs/research/gsrc-gnu.json, written by scripts/gsrc-gnu.ts. */
export type GsrcFile = {
  source: string;
  revno: number | null;
  count: number;
  packages: Record<string, GsrcPkg>;
};

/** Read docs/research/gsrc-gnu.json under `root`; throws when it is absent or malformed. */
export const loadGsrc = (root = repoRoot()): GsrcFile =>
  JSON.parse(readFileSync(join(root, "docs", "research", "gsrc-gnu.json"), "utf8"));

export type Inventory = {
  gsrc: Record<string, GsrcPkg>;
  gsrcRevno: number | null;
  pkgs: Record<
    string,
    {
      name: string;
      category: string | null;
      purpose: string | null;
      homepage: string | null;
      repo: string | null;
      verdict: string | null;
      status: string | null;
    }
  >;
};

/** Load the repository inventory: GSRC and gnu-packages.json (docs/research, docs/native/gnu). */
export async function loadInventory(root = repoRoot()): Promise<Inventory> {
  let g: Partial<GsrcFile> = {};
  try {
    g = loadGsrc(root);
  } catch {
    // no GSRC snapshot: empty inventory
  }
  const inv = await readJson<{
    packages?: {
      name: string;
      category?: string;
      purpose?: string;
      homepage?: string;
      repo?: string;
      verdict?: string;
      status?: string;
    }[];
  }>(join(root, "docs", "native", "gnu", "gnu-packages.json"), {});
  return {
    gsrc: g.packages ?? {},
    gsrcRevno: g.revno ?? null,
    pkgs: Object.fromEntries(
      (inv.packages ?? []).map((p) => [
        p.name,
        {
          name: p.name,
          category: p.category ?? null,
          purpose: p.purpose ?? null,
          homepage: p.homepage ?? null,
          repo: p.repo ?? null,
          verdict: p.verdict ?? null,
          status: p.status ?? null,
        },
      ]),
    ),
  };
}

/** PROOF.md of a package, written by `just gnu-check <id>`: first percentage found is the pass rate. */
export async function readProof(id: string, root = repoRoot()) {
  const f = Bun.file(join(root, "system", "gnu", id, "PROOF.md"));
  if (!existsSync(f.name!)) return { status: "none" as const };
  const m = /(\d{1,3}(?:[.,]\d+)?)\s*%/.exec(await f.text());
  return {
    status: "present" as const,
    path: `system/gnu/${id}/PROOF.md`,
    ...(m ? { rate: `${m[1]!.replace(",", ".")} %` } : {}),
  };
}
