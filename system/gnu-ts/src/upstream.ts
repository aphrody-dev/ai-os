// GNU upstream sources: ftp.gnu.org listing, info-gnu archive, Savannah git heads, GSRC revno. Parsers are pure.
import type { Announce, FtpFile, FtpListing, Release } from "./types.ts";

export const UA = "aphrody-gnu-tracker/0.1 (+https://gnu.aphrody.com)";
/** GET with the tracker User-Agent and a timeout (callers check `r.ok`). */
export const get = (
  url: string,
  headers: Record<string, string> = {},
  ms = 60_000,
) =>
  fetch(url, {
    headers: { "user-agent": UA, ...headers },
    signal: AbortSignal.timeout(ms),
  });

/** Tarballs and signatures are downloaded through the mirror redirector: ftp.gnu.org rate-limits (blocked fr2 on 2026-11-14). */
export const mirrorUrl = (u: string) =>
  u.replace("https://ftp.gnu.org/gnu/", "https://ftpmirror.gnu.org/gnu/");
export const GNU_KEYRING = "https://ftpmirror.gnu.org/gnu/gnu-keyring.gpg";
export const FTP_LISTING = "https://ftp.gnu.org/ls-lrRt.txt.gz";
export const INFO_GNU = "https://lists.gnu.org/archive/html/info-gnu/";
export const GSRC_REVNO =
  "https://bzr.savannah.gnu.org/r/gsrc/trunk/.bzr/branch/last-revision";
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Natural version comparison: numeric tokens by value, a numeric token beats a letter token, longer beats shorter. */
export function versionCmp(a: string, b: string): number {
  const ta = a.replace(/^v/i, "").match(/\d+|[a-z]+/gi) ?? [];
  const tb = b.replace(/^v/i, "").match(/\d+|[a-z]+/gi) ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
    } else if (nx !== ny) return nx ? 1 : -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x);
    }),
  );
}

export const isPrerelease =(v: string) =>
  /(alpha|beta|rc\d*|pre\d*|snap|test|dev|git|nightly)/i.test(v);

/** Parse `ls -lRt` output (as ftp.gnu.org/ls-lrRt.txt.gz): returns dirs under /home/ftp/gnu. Times are UTC. */
export function parseListing(text: string, now = new Date()): FtpListing {
  const out: FtpListing = new Map();
  let cur: FtpFile[] | null = null;
  const re =
    /^([-dl])\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/;
  for (const line of text.split("\n")) {
    if (line.endsWith(":") && line.startsWith("/")) {
      const m = /^\/home\/ftp\/gnu(?:\/(.*))?:$/.exec(line);
      cur = m
        ? (out.get(m[1] ?? "") ?? out.set(m[1] ?? "", []).get(m[1] ?? "")!)
        : null;
      continue;
    }
    if (!cur) continue;
    const m = re.exec(line);
    if (!m || m[1] !== "-") continue;
    const mon = MONTHS.indexOf(m[3]!);
    const day = Number(m[4]);
    let t: number;
    if (m[5]!.includes(":")) {
      const [hh, mm] = m[5]!.split(":").map(Number);
      t = Date.UTC(now.getUTCFullYear(), mon, day, hh, mm);
      if (t > now.getTime() + 86_400_000)
        t = Date.UTC(now.getUTCFullYear() - 1, mon, day, hh, mm);
    } else t = Date.UTC(Number(m[5]), mon, day);
    cur.push({ name: m[6]!, size: Number(m[2]), mtime: t });
  }
  return out;
}

const TARBALL =
  /^(.+?)-(v?\d[\w.+~]*?(?:-\d[\w.+~]*?)*)\.(?:tar\.(?:gz|bz2|xz|lz|zst)|tgz|zip)$/;
const EXT_RANK: Record<string, number> = {
  xz: 5,
  lz: 4,
  zst: 3,
  gz: 2,
  bz2: 1,
};
const extRank = (f: string) => EXT_RANK[f.split(".").pop() ?? ""] ?? 0;

/**
 * Latest stable tarball of a package directory (flat files plus one level of sub-directories),
 * preferring the tarball name equal to `hints` (the directory name, the GSRC tarball name).
 */
export function latestRelease(
  listing: FtpListing,
  dir: string,
  hints: string[] = [],
  opts: { strict?: boolean; major?: string } = {},
): Release | null {
  const cands: Release[] = [];
  for (const [path, files] of listing) {
    if (path !== dir && !path.startsWith(`${dir}/`)) continue;
    if (path.slice(dir.length + 1).split("/").length > 1) continue;
    const sigs = new Set(
      files.filter((f) => f.name.endsWith(".sig")).map((f) => f.name),
    );
    for (const f of files) {
      const m = TARBALL.exec(f.name);
      if (!m || isPrerelease(m[2]!)) continue;
      cands.push({
        file: f.name,
        path: `${path}/${f.name}`,
        name: m[1]!,
        version: m[2]!.replace(/^v/i, ""),
        size: f.size,
        date: new Date(f.mtime).toISOString(),
        sig: sigs.has(`${f.name}.sig`) ? `${path}/${f.name}.sig` : null,
      });
    }
  }
  if (!cands.length) return null;
  // Hints in priority order (GSRC tarball name, id, directory): the first one that names a tarball wins.
  let pool: Release[] = [];
  for (const h of hints.filter(Boolean)) {
    pool = cands.filter((c) => c.name.toLowerCase() === h.toLowerCase());
    if (pool.length) break;
  }
  if (!pool.length) {
    if (opts.strict) return null;
    const top = cands.toSorted((a, b) => b.date.localeCompare(a.date))[0]!.name;
    pool = cands.filter((c) => c.name === top);
  }
  if (opts.major)
    pool = pool.filter((c) => c.version.split(/[.-]/)[0] === opts.major);
  return (
    pool.toSorted(
      (a, b) =>
        versionCmp(b.version, a.version) || extRank(b.file) - extRank(a.file),
    )[0] ?? null
  );
}

/** Resolve the ftp directory of a package from its GSRC MASTER_SUBDIR, tarball name and id. */
export function ftpDirFor(
  listing: FtpListing,
  id: string,
  tarball?: string | null,
  subdir?: string | null,
): string | null {
  const cands: string[] = [];
  if (subdir) {
    const s = subdir
      .replace(/\$\(GARNAME\)/g, tarball ?? id)
      .replace(/^gnu\//, "")
      .split("/")[0]!;
    if (s && !s.includes("$")) cands.push(s);
  }
  for (const c of [tarball, id, tarball?.toLowerCase()]) if (c) cands.push(c);
  return cands.find((c) => listing.has(c)) ?? null;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Parse a monthly info-gnu index page into announcements (newest first). */
export function parseInfoGnu(html: string, month: string): Announce[] {
  const out: Announce[] = [];
  let day = "";
  const tok =
    /<strong>([A-Za-z]+) (\d{1,2}), (\d{4})<\/strong>|<li><a name="\d+" href="(msg\d+\.html)">(.*?)<\/a>, <i>(.*?)<\/i>, <tt>(\d{2}:\d{2})<\/tt>/g;
  for (const m of html.matchAll(tok)) {
    if (m[1]) {
      const mi = MONTH_NAMES.indexOf(m[1]);
      day = `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
    } else if (day) {
      out.push({
        subject: decodeHtml(m[5]!),
        url: `${INFO_GNU}${month}/${m[4]}`,
        date: `${day}T${m[7]}:00Z`,
        author: decodeHtml(m[6]!),
      });
    }
  }
  return out;
}

const decodeHtml = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** Match an announcement subject to the longest known package name it starts with. */
export function matchAnnounce(subject: string, names: string[]): string | null {
  const s = subject
    .toLowerCase()
    .replace(/^(re:\s*)?(\[.*?\]\s*)?(gnu\s+)?/, "")
    .trim();
  let best: string | null = null;
  for (const n of names) {
    const k = n.toLowerCase();
    if (
      s.startsWith(k) &&
      !/[a-z]/.test(s[k.length] ?? "") &&
      (!best || k.length > best.length)
    )
      best = n;
  }
  return best;
}

/** Month keys (YYYY-MM) to poll: current and previous. */
export function pollMonths(now = new Date()): string[] {
  const d = (back: number) => {
    const x = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1),
    );
    return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return [d(0), d(1)];
}

/** Parse a git smart-HTTP `info/refs?service=git-upload-pack` body: HEAD sha and branch heads. */
export function parseInfoRefs(body: string): {
  head: string | null;
  refs: Record<string, string>;
} {
  const refs: Record<string, string> = {};
  let head: string | null = null;
  let i = 0;
  while (i + 4 <= body.length) {
    const n = Number.parseInt(body.slice(i, i + 4), 16);
    if (!n) {
      i += 4;
      continue;
    }
    const line = body
      .slice(i + 4, i + n)
      .replace(/\0.*$/s, "")
      .trim();
    i += n;
    const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(line);
    if (!m) continue;
    if (m[2] === "HEAD") head = m[1]!;
    else if (m[2]!.startsWith("refs/heads/")) refs[m[2]!.slice(11)] = m[1]!;
  }
  return { head, refs };
}

export const savannahGitUrl = (repo: string | null | undefined) => {
  const m =
    /git\.savannah(?:\.nongnu)?\.gnu\.org\/(?:cgit|git)\/(.+?)(?:\.git)?\/?$/.exec(
      repo ?? "",
    );
  return m ? `https://git.savannah.gnu.org/git/${m[1]}.git` : null;
};

export const parseRevno = (s: string) => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};
