// Rust equivalents of GNU packages, keyed by GSRC id (or ftp directory). Sources: docs/native/gnu/gnu-packages.json
// `modern`. Versions come live from GitHub releases and crates.io.
import type { RustDef, RustRelease } from "./types.ts";
import { UA } from "./upstream.ts";

export const RUST_MAP: Record<string, RustDef[]> = {
  coreutils: [
    {
      name: "uutils coreutils",
      repo: "uutils/coreutils",
      crate: "coreutils",
      kind: "drop-in",
      coverage: "GNU testsuite 676/719 pass (94.0 %), CI 2026-11-12",
      mirror: true,
    },
  ],
  findutils: [
    {
      name: "uutils findutils",
      repo: "uutils/findutils",
      crate: "findutils",
      kind: "drop-in",
      mirror: true,
    },
    { name: "fd", repo: "sharkdp/fd", crate: "fd-find", kind: "alt" },
  ],
  diffutils: [
    {
      name: "uutils diffutils",
      repo: "uutils/diffutils",
      crate: "diffutils",
      kind: "partial",
      coverage: "diff and cmp; diff3 and sdiff partial",
      mirror: true,
    },
    {
      name: "difftastic",
      repo: "Wilfred/difftastic",
      crate: "difftastic",
      kind: "alt",
    },
  ],
  sed: [
    {
      name: "uutils sed",
      repo: "uutils/sed",
      crate: "sed",
      kind: "drop-in",
      mirror: true,
    },
    { name: "sd", repo: "chmln/sd", crate: "sd", kind: "alt" },
  ],
  grep: [
    {
      name: "uutils grep",
      repo: "uutils/grep",
      crate: "grep",
      kind: "partial",
      mirror: true,
    },
    {
      name: "ripgrep",
      repo: "BurntSushi/ripgrep",
      crate: "ripgrep",
      kind: "alt",
      mirror: true,
    },
  ],
  tar: [{ name: "uutils tar", repo: "uutils/tar", kind: "partial" }],
  gzip: [
    {
      name: "zlib-rs",
      repo: "trifectatechfoundation/zlib-rs",
      crate: "libz-rs-sys",
      kind: "lib",
    },
  ],
  bash: [
    {
      name: "brush",
      repo: "reubeno/brush",
      crate: "brush-shell",
      kind: "partial",
      coverage: "shell-matrix 31/34",
    },
  ],
  binutils: [
    {
      name: "wild",
      repo: "davidlattimore/wild",
      crate: "wild-linker",
      kind: "partial",
    },
  ],
  gcc: [{ name: "rustc", repo: "rust-lang/rust", kind: "alt" }],
  gdbm: [{ name: "redb", repo: "cberner/redb", crate: "redb", kind: "lib" }],
  gnutls: [
    { name: "rustls", repo: "rustls/rustls", crate: "rustls", kind: "lib" },
  ],
  gmp: [
    {
      name: "malachite",
      repo: "mhogrefe/malachite",
      crate: "malachite",
      kind: "lib",
    },
  ],
  libiconv: [
    {
      name: "encoding_rs",
      repo: "hsivonen/encoding_rs",
      crate: "encoding_rs",
      kind: "lib",
    },
  ],
  libgcrypt: [
    {
      name: "aws-lc-rs",
      repo: "aws/aws-lc-rs",
      crate: "aws-lc-rs",
      kind: "lib",
    },
  ],
  nettle: [
    {
      name: "aws-lc-rs",
      repo: "aws/aws-lc-rs",
      crate: "aws-lc-rs",
      kind: "lib",
    },
  ],
  libmicrohttpd: [
    { name: "hyper", repo: "hyperium/hyper", crate: "hyper", kind: "lib" },
  ],
  libtasn1: [
    { name: "rasn", repo: "librasn/rasn", crate: "rasn", kind: "lib" },
  ],
  less: [{ name: "bat", repo: "sharkdp/bat", crate: "bat", kind: "alt" }],
  make: [{ name: "just", repo: "casey/just", crate: "just", kind: "alt" }],
  nano: [{ name: "helix", repo: "helix-editor/helix", kind: "alt" }],
  emacs: [{ name: "zed", repo: "zed-industries/zed", kind: "alt" }],
  time: [
    {
      name: "hyperfine",
      repo: "sharkdp/hyperfine",
      crate: "hyperfine",
      kind: "alt",
    },
  ],
  wget: [{ name: "xh", repo: "ducaale/xh", crate: "xh", kind: "alt" }],
  screen: [
    { name: "zellij", repo: "zellij-org/zellij", crate: "zellij", kind: "alt" },
  ],
  ncurses: [
    { name: "ratatui", repo: "ratatui/ratatui", crate: "ratatui", kind: "lib" },
  ],
  readline: [
    {
      name: "reedline",
      repo: "nushell/reedline",
      crate: "reedline",
      kind: "lib",
    },
  ],
  parallel: [
    {
      name: "rust-parallel",
      repo: "aaronriekenberg/rust-parallel",
      crate: "rust-parallel",
      kind: "alt",
    },
  ],
  global: [
    {
      name: "ast-grep",
      repo: "ast-grep/ast-grep",
      crate: "ast-grep",
      kind: "alt",
    },
  ],
  gnupg: [
    {
      name: "sequoia-sq",
      repo: "sequoia-pgp/sequoia-sq",
      crate: "sequoia-sq",
      kind: "partial",
    },
  ],
  stow: [
    { name: "dotter", repo: "SuperCuber/dotter", crate: "dotter", kind: "alt" },
  ],
};

export const kindRank: Record<string, number> = {
  none: 0,
  lib: 1,
  alt: 2,
  partial: 3,
  "drop-in": 4,
};

export function rustStatus(defs: { kind: string }[]): "none" | RustDef["kind"] {
  let best = "none";
  for (const d of defs) if (kindRank[d.kind]! > kindRank[best]!) best = d.kind;
  return best as "none" | RustDef["kind"];
}

export type RustCache = Record<
  string,
  {
    etag?: string;
    checked: number;
    tag: string | null;
    date: string | null;
    url: string | null;
  }
>;
export type CrateCache = Record<
  string,
  { checked: number; version: string | null; date: string | null }
>;

export const emptyRelease = (d: RustDef): RustRelease => ({
  ...d,
  version: null,
  date: null,
  url: null,
  crate_version: null,
  crate_date: null,
});

const gh = async (
  url: string,
  headers: Record<string, string>,
  f: typeof fetch,
) => f(url, { headers, signal: AbortSignal.timeout(20_000) });

export async function githubToken(): Promise<string | undefined> {
  if (Bun.env.GITHUB_TOKEN) return Bun.env.GITHUB_TOKEN;
  try {
    const r = await Bun.$`gh auth token`.quiet().nothrow();
    const t = r.stdout.toString().trim();
    return r.exitCode === 0 && t ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Latest GitHub release per repo, with ETag revalidation (a 304 does not count against the rate limit). */
export async function pollGithub(
  repos: string[],
  cache: RustCache,
  opts: { token?: string; fetch?: typeof fetch; now?: number } = {},
) {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  for (const repo of repos) {
    const prev = cache[repo];
    const h: Record<string, string> = {
      "user-agent": UA,
      accept: "application/vnd.github+json",
    };
    if (opts.token) h.authorization = `Bearer ${opts.token}`;
    if (prev?.etag) h["if-none-match"] = prev.etag;
    try {
      const r = await gh(
        `https://api.github.com/repos/${repo}/releases/latest`,
        h,
        f,
      );
      if (r.status === 304 && prev) cache[repo] = { ...prev, checked: now };
      else if (r.status === 200) {
        const j = (await r.json()) as {
          tag_name?: string;
          published_at?: string;
          html_url?: string;
        };
        cache[repo] = {
          etag: r.headers.get("etag") ?? undefined,
          checked: now,
          tag: j.tag_name ?? null,
          date: j.published_at ?? null,
          url: j.html_url ?? null,
        };
      } else if (r.status === 404)
        cache[repo] = { checked: now, tag: null, date: null, url: null };
    } catch {
      // keep the previous value; the next cycle retries
    }
  }
  return cache;
}

/** crates.io newest stable version per crate (1 request per second, at most every `ttl` ms per crate). */
export async function pollCrates(
  crates: string[],
  cache: CrateCache,
  opts: { fetch?: typeof fetch; now?: number; ttl?: number; gap?: number } = {},
) {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  for (const c of crates) {
    if (cache[c] && now - cache[c]!.checked < (opts.ttl ?? 3_600_000)) continue;
    try {
      const r = await f(
        `https://crates.io/api/v1/crates/${encodeURIComponent(c)}`,
        { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) },
      );
      if (r.ok) {
        const j = (await r.json()) as {
          crate?: {
            max_stable_version?: string;
            max_version?: string;
            updated_at?: string;
          };
        };
        cache[c] = {
          checked: now,
          version: j.crate?.max_stable_version ?? j.crate?.max_version ?? null,
          date: j.crate?.updated_at ?? null,
        };
      }
    } catch {
      // keep previous
    }
    await Bun.sleep(opts.gap ?? 1100);
  }
  return cache;
}

export function resolveRust(
  id: string,
  gh: RustCache,
  cr: CrateCache,
): RustRelease[] {
  return (RUST_MAP[id] ?? []).map((d) => {
    const g = gh[d.repo];
    const c = d.crate ? cr[d.crate] : undefined;
    return {
      ...d,
      version: g?.tag?.replace(/^v/, "") ?? null,
      date: g?.date ?? null,
      url: g?.url ?? `https://github.com/${d.repo}`,
      crate_version: c?.version ?? null,
      crate_date: c?.date ?? null,
    };
  });
}
