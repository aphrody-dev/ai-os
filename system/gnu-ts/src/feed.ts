// Feed builder: one entry per GNU package, JSON and Atom.
import { buildKernel } from "./kernel.ts";
import { RUST_MAP, resolveRust, rustStatus } from "./rust.ts";
import { type Inventory, type State, readProof } from "./store.ts";
import type { Announce, Entry, Feed, FtpListing, Release } from "./types.ts";
import {
  ftpDirFor,
  latestRelease,
  matchAnnounce,
  versionCmp,
} from "./upstream.ts";

const bareVersion = (v: string | null | undefined) =>
  (v ?? "").replace(/^v/i, "");

export async function buildFeed(
  inv: Inventory,
  st: State,
  listing: FtpListing,
  opts: { now?: Date; root?: string } = {},
): Promise<Feed> {
  const now = opts.now ?? new Date();
  const ids = new Set<string>([
    ...Object.keys(inv.gsrc),
    ...Object.keys(inv.pkgs),
  ]);
  const ftpDirs = new Map<string, string>(); // ftp dir -> id already claimed
  const share = new Map<string, number>(); // ftp dir -> number of ids mapped to it
  const entries: Entry[] = [];
  const announceNames = new Set<string>();
  const dirOf: Record<string, string | null> = {};
  for (const id of ids) {
    const g = inv.gsrc[id];
    dirOf[id] = /snapshot$/.test(id)
      ? null
      : ftpDirFor(listing, id, g?.tarball, g?.subdir);
    if (dirOf[id]) share.set(dirOf[id]!, (share.get(dirOf[id]!) ?? 0) + 1);
    if (dirOf[id]) ftpDirs.set(dirOf[id]!, id);
  }
  // ftp directories with real tarballs that neither GSRC nor the inventory know about.
  for (const dir of listing.keys()) {
    if (
      !dir ||
      dir.includes("/") ||
      dir === "non-gnu" ||
      ftpDirs.has(dir) ||
      ids.has(dir)
    )
      continue;
    if (latestRelease(listing, dir, [dir])) {
      ids.add(dir);
      dirOf[dir] = dir;
    }
  }
  for (const id of ids) {
    announceNames.add(id);
    if (inv.gsrc[id]?.tarball) announceNames.add(inv.gsrc[id]!.tarball!);
    if (inv.gsrc[id]?.label) announceNames.add(inv.gsrc[id]!.label!);
  }
  const announces = new Map<string, Announce>();
  const all = Object.values(st.announce)
    .flatMap((m) => m.items)
    .toSorted((a, b) => b.date.localeCompare(a.date));
  for (const a of all) {
    const hit = matchAnnounce(a.subject, [...announceNames]);
    if (!hit) continue;
    const id = [...ids].find(
      (i) =>
        i === hit || inv.gsrc[i]?.tarball === hit || inv.gsrc[i]?.label === hit,
    );
    if (id && !announces.has(id)) announces.set(id, a);
  }

  for (const id of [...ids].toSorted()) {
    const g = inv.gsrc[id];
    const p = inv.pkgs[id] ?? inv.pkgs[g?.tarball ?? ""];
    const dir = dirOf[id] ?? null;
    const rel: Release | null = dir
      ? (() => {
          const shared = (share.get(dir) ?? 0) > 1;
          const versioned =
            id.startsWith(dir) && /^\d/.test(id.slice(dir.length));
          const hints = [
            g?.tarball ?? "",
            id,
            ...(!shared || id === dir || versioned ? [dir] : []),
          ];
          const major =
            shared && versioned
              ? /^\d+/.exec(g?.version ?? "")?.[0]
              : undefined;
          return latestRelease(listing, dir, hints, { strict: shared, major });
        })()
      : null;
    const mir = st.mirror[id];
    const sameAsGsrc = !!rel && !!g && g.sha256[rel.file] !== undefined;
    const sha = sameAsGsrc
      ? g!.sha256[rel!.file]!
      : mir && rel && mir.file === rel.file
        ? mir.sha256
        : null;
    const gv = g?.version ?? null;
    const head = st.heads[id];
    const rust = resolveRust(id, st.github, st.crates);
    const repo = p?.repo ?? null;
    entries.push({
      id,
      name: g?.label ?? p?.name ?? id,
      category: p?.category ?? null,
      description: g?.description ?? p?.purpose ?? null,
      homepage: p?.homepage ?? g?.home ?? null,
      ftp: dir,
      upstream: {
        version: rel?.version ?? gv,
        date: rel?.date ?? null,
        file: rel?.file ?? null,
        url: rel ? `https://ftp.gnu.org/gnu/${rel.path}` : null,
        size: rel?.size ?? null,
        sha256: sha,
        sha256_source: sha ? (sameAsGsrc ? "gsrc" : "mirror") : null,
        sig_url: rel?.sig ? `https://ftp.gnu.org/gnu/${rel.sig}` : null,
        signature:
          mir && rel && mir.file === rel.file
            ? mir.signature
            : rel
              ? {
                  status: rel.sig ? "unverified" : "missing",
                  detail: rel.sig
                    ? "not downloaded yet"
                    : "no .sig on ftp.gnu.org",
                }
              : { status: "missing" },
        source: rel ? "ftp" : gv ? "gsrc" : "none",
      },
      gsrc:
        g && gv
          ? {
              version: gv,
              deps: [...g.builddeps.filter((d) => d !== "#"), ...g.libdeps],
            }
          : null,
      drift: {
        gsrc:
          !!rel &&
          /^\d/.test(gv ?? "") &&
          versionCmp(rel.version, bareVersion(gv)) > 0,
      },
      announce: announces.get(id) ?? null,
      savannah:
        head && repo
          ? { repo, head: head.head, changed_at: head.changed_at }
          : null,
      rust,
      rust_status: rustStatus(rust),
      verdict: p?.verdict ?? null,
      proof: await readProof(id, opts.root),
      mirror:
        mir && rel && mir.file === rel.file
          ? { key: mir.key, at: mir.at, sig_key: mir.sig_key }
          : null,
    });
  }
  entries.sort(
    (a, b) =>
      (b.upstream.date ?? "").localeCompare(a.upstream.date ?? "") ||
      a.id.localeCompare(b.id),
  );
  const c = (f: (e: Entry) => boolean) => entries.filter(f).length;
  return {
    generated: now.toISOString(),
    generator: "@aphrody/gnu",
    sources: {
      gsrc_revno: st.gsrc.revno ?? inv.gsrcRevno,
      ftp_listing_mtime: st.ftp.mtime ?? null,
      info_gnu_latest: all[0]?.date ?? null,
    },
    counts: {
      packages: entries.length,
      with_release: c((e) => e.upstream.source === "ftp"),
      verified: c((e) => e.upstream.signature.status === "verified"),
      rust_any: c((e) => e.rust.length > 0),
      rust_drop_in: c((e) => e.rust_status === "drop-in"),
      proven: c((e) => e.proof.status === "present"),
      drift_gsrc: c((e) => e.drift.gsrc),
      mirrored: c((e) => e.mirror !== null),
    },
    kernel: st.kernel.checked ? buildKernel(st.kernel) : null,
    entries,
  };
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const entryTitle = (e: Entry) => {
  const r = e.rust.find((x) => x.version || x.crate_version);
  return `${e.id} ${e.upstream.version ?? "?"}${r ? ` | Rust: ${r.name} ${r.version ?? r.crate_version}` : ""}`;
};

export function entrySummary(e: Entry): string {
  const u = e.upstream;
  const lines = [
    `GNU ${e.name} ${u.version ?? "?"}${u.date ? ` (${u.date.slice(0, 10)})` : ""}`,
    u.url ? `Tarball: ${u.url}` : null,
    u.sha256 ? `sha256: ${u.sha256} (${u.sha256_source})` : null,
    `Signature: ${u.signature.status}${u.sig_url ? ` (${u.sig_url})` : ""}`,
    ...e.rust.map(
      (r) =>
        `Rust: ${r.name} ${r.version ?? r.crate_version ?? "no release"} [${r.kind}]${r.coverage ? `, ${r.coverage}` : ""}`,
    ),
    `Proof: ${e.proof.status}${e.proof.rate ? ` ${e.proof.rate}` : ""}`,
    e.announce ? `Announce: ${e.announce.subject} ${e.announce.url}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Atom 1.0: one entry per package, newest upstream release first. */
export function buildAtom(
  feed: Feed,
  base = "https://gnu.aphrody.com",
): string {
  const entries = feed.entries
    .filter((e) => e.upstream.date)
    .map(
      (e) => `  <entry>
    <id>tag:gnu.aphrody.com,2026:${esc(e.id)}/${esc(e.upstream.version ?? "")}</id>
    <title>${esc(entryTitle(e))}</title>
    <updated>${e.upstream.date}</updated>
    <link rel="alternate" href="${esc(e.announce?.url ?? e.homepage ?? e.upstream.url ?? base)}"/>
    ${e.upstream.url ? `<link rel="enclosure" href="${esc(e.upstream.url)}"/>` : ""}
    <category term="${esc(e.rust_status)}" label="rust-equivalent"/>
    <summary type="text">${esc(entrySummary(e))}</summary>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:gnu.aphrody.com,2026:feed</id>
  <title>GNU upstream releases and Rust equivalents</title>
  <subtitle>ftp.gnu.org, info-gnu, GSRC and the Rust replacements, one entry per package</subtitle>
  <updated>${feed.generated}</updated>
  <link rel="self" href="${base}/feed.atom"/>
  <link rel="alternate" href="${base}/"/>
  <generator>@aphrody/gnu</generator>
${entries}
</feed>
`;
}

export { RUST_MAP };
