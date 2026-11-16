import type { KernelSection } from "./kernel.ts";

// Types shared by the tracker, the feed, the CLI, the MCP tools and the site.

export type FtpFile = { name: string; size: number; mtime: number };
export type FtpListing = Map<string, FtpFile[]>; // path under /home/ftp/gnu, "" = gnu/ itself

export type Release = {
  file: string;
  /** Path under ftp.gnu.org/gnu/ (e.g. "coreutils/coreutils-9.12.tar.xz"). */
  path: string;
  name: string;
  version: string;
  size: number;
  date: string; // ISO 8601, UTC
  sig: string | null; // path of the .sig, when present
};

export type SigStatus = "verified" | "unverified" | "invalid" | "missing";
export type Signature = { status: SigStatus; detail?: string };

export type Announce = {
  subject: string;
  url: string;
  date: string;
  author: string;
};

export type RustKind = "drop-in" | "alt" | "lib" | "partial";
export type RustDef = {
  name: string;
  /** GitHub owner/repo. */
  repo: string;
  /** crates.io crate, when published there. */
  crate?: string;
  kind: RustKind;
  /** Curated coverage, with its basis. */
  coverage?: string;
  /** Mirror release binaries to R2. */
  mirror?: boolean;
};
export type RustRelease = RustDef & {
  version: string | null;
  date: string | null;
  url: string | null;
  crate_version: string | null;
  crate_date: string | null;
};

export type Proof = {
  status: "none" | "present";
  path?: string;
  rate?: string;
};

export type Entry = {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  homepage: string | null;
  ftp: string | null;
  upstream: {
    version: string | null;
    date: string | null;
    file: string | null;
    url: string | null;
    size: number | null;
    sha256: string | null;
    sha256_source: "gsrc" | "mirror" | null;
    sig_url: string | null;
    signature: Signature;
    source: "ftp" | "gsrc" | "none";
  };
  gsrc: { version: string; deps: string[] } | null;
  /** True when the ftp release is newer than the GSRC pin. */
  drift: { gsrc: boolean };
  announce: Announce | null;
  savannah: { repo: string; head: string; changed_at: string } | null;
  rust: RustRelease[];
  rust_status: "none" | RustKind;
  verdict: string | null;
  proof: Proof;
  mirror: { key: string; at: string; sig_key: string | null } | null;
};

export type Feed = {
  generated: string;
  generator: string;
  sources: {
    gsrc_revno: number | null;
    ftp_listing_mtime: string | null;
    info_gnu_latest: string | null;
  };
  counts: {
    packages: number;
    with_release: number;
    verified: number;
    rust_any: number;
    rust_drop_in: number;
    proven: number;
    drift_gsrc: number;
    mirrored: number;
  };
  kernel: KernelSection | null;
  entries: Entry[];
};

export type GnuEvent = {
  at: string;
  id: string;
  kind: "release" | "rust" | "announce" | "kernel";
  detail: string;
};
