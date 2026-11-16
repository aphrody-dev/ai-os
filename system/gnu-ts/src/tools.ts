// Read-only query layer over the feed: used by the CLI, the MCP tools of the relay (frameworks/ai-os) and tests.
import { join } from "node:path";
import { buildAtom, entryTitle } from "./feed.ts";
import { paths, readEvents } from "./store.ts";
import type { Entry, Feed, GnuEvent } from "./types.ts";

export const PUBLIC_FEED = "https://gnu.aphrody.com/feed.json";

let cached: { at: number; feed: Feed } | null = null;

/** Feed source: GNU_FEED (path or URL), else GNU_HOME/feed.json, else the public site. Cached 60 s. */
export async function loadFeed(opts: { fresh?: boolean } = {}): Promise<Feed> {
  if (!opts.fresh && cached && Date.now() - cached.at < 60_000)
    return cached.feed;
  const src = Bun.env.GNU_FEED;
  let feed: Feed | null = null;
  if (src && !/^https?:/.test(src)) feed = await Bun.file(src).json();
  else if (!src) {
    const f = Bun.file(paths().feed);
    if (await f.exists()) feed = await f.json();
  }
  if (!feed) {
    const r = await fetch(src ?? PUBLIC_FEED, {
      headers: { "user-agent": "aphrody-gnu-tracker/0.1" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok)
      throw new Error(
        `feed unavailable: ${src ?? PUBLIC_FEED} -> HTTP ${r.status}`,
      );
    feed = (await r.json()) as Feed;
  }
  cached = { at: Date.now(), feed };
  return feed;
}

export const brief = (e: Entry) => ({
  id: e.id,
  version: e.upstream.version,
  date: e.upstream.date?.slice(0, 10) ?? null,
  signature: e.upstream.signature.status,
  gsrc: e.gsrc?.version ?? null,
  drift: e.drift.gsrc,
  rust: e.rust.map(
    (r) =>
      `${r.name} ${r.version ?? r.crate_version ?? "no release"} [${r.kind}]`,
  ),
  rust_status: e.rust_status,
  proof: e.proof.status === "present" ? (e.proof.rate ?? "present") : "none",
});

export function status(feed: Feed) {
  const age = Math.round((Date.now() - Date.parse(feed.generated)) / 60_000);
  return {
    generated: feed.generated,
    age_minutes: age,
    stale: age > 60,
    counts: feed.counts,
    sources: feed.sources,
    latest: feed.entries
      .filter((e) => e.upstream.date)
      .slice(0, 8)
      .map(brief),
    kernel: feed.kernel
      ? {
          latest_stable: feed.kernel.latest_stable,
          releases: feed.kernel.releases.map(
            (r) => `${r.moniker} ${r.version}`,
          ),
        }
      : null,
  };
}

export type SearchOpts = {
  query?: string;
  filter?:
    | "rust"
    | "drop-in"
    | "norust"
    | "drift"
    | "verified"
    | "proven"
    | "mirrored";
  limit?: number;
};

export function search(feed: Feed, o: SearchOpts = {}) {
  const terms = (o.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const out = feed.entries.filter((e) => {
    const hay =
      `${e.id} ${e.name} ${e.description ?? ""} ${e.category ?? ""} ${e.rust.map((r) => r.name).join(" ")}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
    switch (o.filter) {
      case "rust":
        return e.rust.length > 0;
      case "drop-in":
        return e.rust_status === "drop-in";
      case "norust":
        return e.rust.length === 0;
      case "drift":
        return e.drift.gsrc;
      case "verified":
        return e.upstream.signature.status === "verified";
      case "proven":
        return e.proof.status === "present";
      case "mirrored":
        return e.mirror !== null;
      default:
        return true;
    }
  });
  return { total: out.length, results: out.slice(0, o.limit ?? 25).map(brief) };
}

export const pkg = (feed: Feed, id: string) => {
  const q = id.toLowerCase();
  return (
    feed.entries.find((e) => e.id === q) ??
    feed.entries.find((e) => e.name.toLowerCase() === q || e.ftp === q) ??
    null
  );
};

/** Entries released since `since` (ISO date or "24h", "7d"), newest first; format "atom" returns the Atom document. */
export function recent(
  feed: Feed,
  o: { since?: string; limit?: number; format?: "json" | "atom" } = {},
) {
  const m = /^(\d+)([hdw])$/.exec(o.since ?? "");
  const t = m
    ? Date.now() -
      Number(m[1]) *
        { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"]
    : o.since
      ? Date.parse(o.since)
      : 0;
  const list = feed.entries
    .filter((e) => e.upstream.date && Date.parse(e.upstream.date) >= t)
    .slice(0, o.limit ?? 30);
  if (o.format === "atom") return buildAtom({ ...feed, entries: list });
  return {
    generated: feed.generated,
    count: list.length,
    entries: list.map((e) => ({
      ...brief(e),
      title: entryTitle(e),
      url: e.upstream.url,
    })),
  };
}

export const kernel = (feed: Feed) => feed.kernel;

export async function changes(
  o: { since?: string; limit?: number } = {},
): Promise<GnuEvent[]> {
  const m = /^(\d+)([hdw])$/.exec(o.since ?? "");
  const t = m
    ? Date.now() -
      Number(m[1]) *
        { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"]
    : o.since
      ? Date.parse(o.since)
      : 0;
  const local = (await readEvents()).filter((e) => Date.parse(e.at) >= t);
  if (local.length || Bun.env.GNU_FEED)
    return local.toReversed().slice(0, o.limit ?? 50);
  const r = await fetch(PUBLIC_FEED.replace("feed.json", "events.json"), {
    headers: { "user-agent": "aphrody-gnu-tracker/0.1" },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const all = r?.ok ? ((await r.json()) as GnuEvent[]) : [];
  return all
    .filter((e) => Date.parse(e.at) >= t)
    .toReversed()
    .slice(0, o.limit ?? 50);
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

export type GnuTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: true;
  run: (a: any) => Promise<unknown>;
};

/** MCP tools, registered in the relay by frameworks/ai-os/src/relay/gnu-tools.ts. */
export const GNU_TOOLS: GnuTool[] = [
  {
    name: "gnu_status",
    description:
      "State of the GNU upstream tracker: feed age, package counts (releases, verified signatures, Rust equivalents, drift against GSRC, R2 mirror), GSRC revno, latest releases, Linux kernel versions.",
    inputSchema: obj({}),
    readOnly: true,
    run: async () => status(await loadFeed()),
  },
  {
    name: "gnu_search",
    description:
      "Search GNU packages (id, description, category, Rust equivalent name). filter: rust, drop-in, norust, drift (GSRC behind ftp.gnu.org), verified, proven, mirrored.",
    inputSchema: obj({
      query: str("Words, all must match"),
      filter: str(
        "rust | drop-in | norust | drift | verified | proven | mirrored",
      ),
      limit: num("Max results (default 25)"),
    }),
    readOnly: true,
    run: async (a) =>
      search(await loadFeed(), {
        query: a.query,
        filter: a.filter,
        limit: a.limit,
      }),
  },
  {
    name: "gnu_package",
    description:
      "Full feed entry of one GNU package (GSRC id such as coreutils, gcc16): upstream version, date, tarball URL, sha256, signature status, GSRC pin, Rust equivalents with versions and coverage, proof, mirror key, deps.",
    inputSchema: obj({ id: str("Package id or ftp directory") }, ["id"]),
    readOnly: true,
    run: async (a) =>
      pkg(await loadFeed(), String(a.id)) ?? {
        error: `unknown package ${a.id}`,
      },
  },
  {
    name: "gnu_feed",
    description:
      "Recent GNU upstream releases from the feed, newest first. since: ISO date or 24h, 7d, 2w. format atom returns the Atom document. Also lists detected changes when changes is true.",
    inputSchema: obj({
      since: str("ISO date or 24h | 7d | 2w"),
      limit: num("Max entries (default 30)"),
      format: str("json | atom"),
      changes: {
        type: "boolean",
        description: "Return detected change events instead",
      },
    }),
    readOnly: true,
    run: async (a) =>
      a.changes
        ? changes({ since: a.since, limit: a.limit })
        : recent(await loadFeed(), {
            since: a.since,
            limit: a.limit,
            format: a.format,
          }),
  },
  {
    name: "gnu_kernel",
    description:
      "Linux kernel upstream: mainline, stable, longterm and linux-next releases with sha256 and signature status, git.kernel.org tree heads, Android GKI and ChromeOS branches, Rust for Linux (in tree since, docs, rust-next), google/kernel-research.",
    inputSchema: obj({}),
    readOnly: true,
    run: async () =>
      kernel(await loadFeed()) ?? { error: "no kernel data in the feed" },
  },
];

export const feedFile = () => join(paths().home, "feed.json");
