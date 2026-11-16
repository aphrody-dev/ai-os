import { describe, expect, test } from "bun:test";
import { buildAtom, buildFeed } from "../src/feed.ts";
import {
  buildKernel,
  emptyKernel,
  isChromeos,
  isGki,
  parseGitiles,
  parseSums,
  pickBranches,
  parseAndroid,
} from "../src/kernel.ts";
import {
  RUST_MAP,
  pollCrates,
  pollGithub,
  resolveRust,
  rustStatus,
} from "../src/rust.ts";
import { emptyState } from "../src/store.ts";
import { diffEvents } from "../src/sync.ts";
import { brief, pkg, recent, search, status } from "../src/tools.ts";
import {
  ftpDirFor,
  latestRelease,
  matchAnnounce,
  parseInfoGnu,
  parseInfoRefs,
  parseListing,
  parseRevno,
  pollMonths,
  savannahGitUrl,
  versionCmp,
} from "../src/upstream.ts";

const NOW = new Date("2026-11-14T22:00:00Z");
const LISTING = `/home/ftp/gnu:
total 4
drwxr-xr-x 2 root root 4096 Jan 21 2026 coreutils

/home/ftp/gnu/coreutils:
total 99
-rw-r--r-- 1 g n  6020616 Apr  2  2003 coreutils-5.0.tar.gz
-rw-r--r-- 1 g n  5000000 Nov  1 10:00 coreutils-9.11.tar.xz
-r--r--r-- 1 g n      65 Nov  1 10:00 coreutils-9.11.tar.xz.sig
-rw-r--r-- 1 g n  5100000 Nov 13 07:56 coreutils-9.12.tar.xz
-r--r--r-- 1 g n      65 Nov 13 07:56 coreutils-9.12.tar.xz.sig
-rw-r--r-- 1 g n  5100000 Nov 13 08:00 coreutils-9.13-rc1.tar.xz
lrwxrwxrwx 1 g n      11 Nov 13 08:00 coreutils-latest.tar.xz -> coreutils-9.12.tar.xz

/home/ftp/gnu/gcc:

/home/ftp/gnu/gcc/gcc-16.2.0:
-rw-r--r-- 1 g n 90000000 Oct  9 12:00 gcc-16.2.0.tar.xz
-r--r--r-- 1 g n      65 Oct  9 12:00 gcc-16.2.0.tar.xz.sig

/home/ftp/gnu/gcc/gcc-9.1.0:
-rw-r--r-- 1 g n 90000000 Oct  9 2019 gcc-9.1.0.tar.xz

/home/ftp/gnu/groff:
-rw-r--r-- 1 g n  1000000 Nov  8 15:36 groff-1.25.0.tar.gz
-rw-r--r-- 1 g n  1000000 Dec 30 15:36 groff-1.24.0.tar.gz
`;

describe("versions", () => {
  test("natural order", () => {
    expect(versionCmp("9.12", "9.9")).toBe(1);
    expect(versionCmp("2.4", "2.4.1")).toBe(-1);
    expect(versionCmp("1.0", "1.0")).toBe(0);
    expect(versionCmp("v0.11.0", "0.9.9")).toBe(1);
  });
});

describe("ftp listing", () => {
  const l = parseListing(LISTING, NOW);
  test("parses directories and infers the year", () => {
    expect([...l.keys()]).toContain("coreutils");
    expect(l.get("coreutils")!.length).toBe(6); // the symlink is skipped
    const old = l.get("groff")!.find((f) => f.name.includes("1.24"))!;
    expect(new Date(old.mtime).getUTCFullYear()).toBe(2025); // Dec 30 with a time, in the future of NOW: previous year
    expect(new Date(l.get("coreutils")![0]!.mtime).toISOString()).toBe(
      "2003-04-02T00:00:00.000Z",
    );
  });
  test("latest stable release, prerelease and symlink ignored", () => {
    const r = latestRelease(l, "coreutils", ["coreutils"])!;
    expect(r.version).toBe("9.12");
    expect(r.file).toBe("coreutils-9.12.tar.xz");
    expect(r.sig).toBe("coreutils/coreutils-9.12.tar.xz.sig");
    expect(r.date).toBe("2026-11-13T07:56:00.000Z");
  });
  test("one level of sub-directories", () => {
    const r = latestRelease(l, "gcc", ["gcc"])!;
    expect(r.version).toBe("16.2.0");
    expect(r.path).toBe("gcc/gcc-16.2.0/gcc-16.2.0.tar.xz");
  });
  test("ftpDirFor resolves GSRC subdir and falls back to the id", () => {
    expect(ftpDirFor(l, "gcc16", "gcc16", "gnu/gcc/gcc-$(GARVERSION)/")).toBe(
      "gcc",
    );
    expect(ftpDirFor(l, "coreutils", "coreutils", "coreutils/")).toBe(
      "coreutils",
    );
    expect(ftpDirFor(l, "nope", "nope", null)).toBeNull();
  });
});

const INFO = `<ul>
<li><strong>November 11, 2026</strong>
<ul>
<li><a name="00003" href="msg00003.html">autoconf-archive-2026.11.11 released [stable]</a>, <i>Peter Simons</i>, <tt>15:34</tt></li>
</ul></li>
<li><strong>November 08, 2026</strong>
<ul>
<li><a name="00001" href="msg00001.html">groff 1.25.0 released</a>, <i>G. Branden Robinson</i>, <tt>15:36</tt></li>
<li><a name="00000" href="msg00000.html">GNU libmatheval 1.1.12 is out</a>, <i>Aleksandar Samard&#382;i&#263;</i>, <tt>09:15</tt></li>
</ul></li>
</ul>`;

describe("info-gnu", () => {
  const a = parseInfoGnu(INFO, "2026-11");
  test("parses subject, date, url, author", () => {
    expect(a.length).toBe(3);
    expect(a[1]).toEqual({
      subject: "groff 1.25.0 released",
      url: "https://lists.gnu.org/archive/html/info-gnu/2026-11/msg00001.html",
      date: "2026-11-08T15:36:00Z",
      author: "G. Branden Robinson",
    });
    expect(a[2]!.author).toBe("Aleksandar Samardžić");
  });
  test("matches the longest package name", () => {
    const names = ["autoconf", "autoconf-archive", "groff", "libmatheval"];
    expect(matchAnnounce(a[0]!.subject, names)).toBe("autoconf-archive");
    expect(matchAnnounce("GNU libmatheval 1.1.12 is out", names)).toBe(
      "libmatheval",
    );
    expect(matchAnnounce("groffer news", names)).toBeNull();
  });
  test("poll months", () => {
    expect(pollMonths(new Date("2026-01-05T00:00:00Z"))).toEqual([
      "2026-01",
      "2025-12",
    ]);
  });
});

describe("git and misc", () => {
  test("info/refs parsing", () => {
    const sha = "a".repeat(40);
    const pkt = (s: string) =>
      `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
    const body = `${pkt("# service=git-upload-pack\n")}0000${pkt(`${sha} HEAD\0multi_ack\n`)}${pkt(`${"b".repeat(40)} refs/heads/master\n`)}0000`;
    const r = parseInfoRefs(body);
    expect(r.head).toBe(sha);
    expect(r.refs.master).toBe("b".repeat(40));
  });
  test("savannah url and revno", () => {
    expect(
      savannahGitUrl("https://git.savannah.gnu.org/cgit/coreutils.git"),
    ).toBe("https://git.savannah.gnu.org/git/coreutils.git");
    expect(savannahGitUrl("https://example.org/x.git")).toBeNull();
    expect(parseRevno("12334 carl@x-2026")).toBe(12334);
  });
});

describe("kernel", () => {
  test("gitiles parsing and branch filters", () => {
    const body = `)]}'\n{"HEAD":{"value":"h","target":"refs/heads/android-mainline"},"refs/heads/android-mainline":{"value":"1"},"android15-6.6":{"value":"2"},"android14-5.15":{"value":"3"},"android-gs-akita-5.15":{"value":"4"},"chromeos-6.12":{"value":"5"},"chromeos-5.4":{"value":"6"},"0.11.241.B":{"value":"7"}}`;
    const all = parseGitiles(body);
    expect(all["android-mainline"]).toBe("1");
    expect(all.HEAD).toBeUndefined();
    expect(pickBranches(all, isGki).map((b) => b.name)).toEqual([
      "android-mainline",
      "android15-6.6",
      "android14-5.15",
    ]);
    expect(pickBranches(all, isGki).map((b) => b.name)).not.toContain(
      "android-gs-akita-5.15",
    );
    expect(pickBranches(all, isChromeos).map((b) => b.name)).toEqual([
      "chromeos-6.12",
      "chromeos-5.4",
    ]);
  });
  test("android branch analysis from gitiles files", () => {
    const t = parseAndroid(
      "android18-7.3",
      { commit: "8cb307d9ca5e", message: "x\nbody", committer: { time: "Fri Nov 13 14:41:47 2026 -0800" } },
      {
        makefile: "VERSION = 7\nPATCHLEVEL = 3\nSUBLEVEL = 0\nEXTRAVERSION =\nNAME = Baby Opossum Posse\n",
        constants: "KMI_GENERATION=0\nCLANG_VERSION=\"r596125\"\nRUSTC_VERSION=\"1.96.0\"\n",
        bazel: "kmi_enforced = False",
        defconfig: "CONFIG_RUST=y\nCONFIG_ANDROID_BINDER_IPC_RUST=y\n",
      },
    )!;
    expect(t).toMatchObject({
      kernel: "7.3.0",
      upstream_base: "v7.3",
      clang: "r596125",
      rustc: "1.96.0",
      rust_binder: "y",
      head: { date: "2026-11-13T22:41:47.000Z", subject: "x" },
    });
    expect(t.kmi.phase).toBe("development");
    expect(parseAndroid("b", {}, { makefile: "", constants: "", bazel: "", defconfig: "" })).toBeNull();
    const ks = emptyKernel();
    ks.android = { [t.branch]: t };
    expect(buildKernel(ks).android[0]!.branch).toBe("android18-7.3");
  });
  test("sha256sums", () => {
    const s = parseSums(
      `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${"a".repeat(64)}  linux-7.3.4.tar.xz\n${"b".repeat(64)}  ChangeLog-7.3\n${"c".repeat(64)}  linux-7.3.4.tar.gz\n`,
    );
    expect(s["linux-7.3.4.tar.xz"]).toBe("a".repeat(64));
    expect(Object.keys(s).length).toBe(2);
  });
  test("section is ordered and marks rust in tree", () => {
    const ks = emptyKernel();
    ks.releases = [
      {
        moniker: "longterm",
        version: "6.12.117",
        iseol: false,
        released: { timestamp: 1794000000, isodate: "2026-11-10" },
        source:
          "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.117.tar.xz",
        pgp: "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.117.tar.sign",
      },
      {
        moniker: "mainline",
        version: "7.4-rc2",
        iseol: false,
        released: { timestamp: 1794183740, isodate: "2026-11-09" },
        source: "https://git.kernel.org/torvalds/t/linux-7.4-rc2.tar.gz",
        pgp: null,
      },
      {
        moniker: "stable",
        version: "7.3.4",
        iseol: false,
        released: { timestamp: 1794334272, isodate: "2026-11-10" },
        source:
          "https://cdn.kernel.org/pub/linux/kernel/v7.x/linux-7.3.4.tar.xz",
        pgp: "https://cdn.kernel.org/pub/linux/kernel/v7.x/linux-7.3.4.tar.sign",
      },
    ];
    ks.sums["linux-7.3.4.tar.xz"] = "d".repeat(64);
    ks.rust_tree["v7.3"] = true;
    ks.rust_tree["v6.12"] = true;
    ks.gki = { "android15-6.6": "x" };
    const k = buildKernel(ks);
    expect(k.releases.map((r) => r.moniker)).toEqual([
      "mainline",
      "stable",
      "longterm",
    ]);
    expect(k.releases[1]!.sha256).toBe("d".repeat(64));
    expect(k.releases[1]!.signature.status).toBe("unverified");
    expect(k.releases[0]!.signature.status).toBe("missing");
    expect(k.rust.in_tree_since).toBe("6.12");
  });
});

describe("rust side", () => {
  test("map covers the uutils drop-ins", () => {
    expect(RUST_MAP.coreutils![0]!.repo).toBe("uutils/coreutils");
    expect(rustStatus(RUST_MAP.grep!)).toBe("partial");
    expect(rustStatus(RUST_MAP.coreutils!)).toBe("drop-in");
    expect(rustStatus([])).toBe("none");
  });
  test("github polling uses ETag and handles 304, 404", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(
        `${url} ${(init?.headers as Record<string, string>)["if-none-match"] ?? ""}`,
      );
      if (url.includes("none/none")) return new Response("{}", { status: 404 });
      if ((init?.headers as Record<string, string>)["if-none-match"])
        return new Response(null, { status: 304 });
      return new Response(
        JSON.stringify({
          tag_name: "v0.12.0",
          published_at: "2026-09-17T00:00:00Z",
          html_url: "https://x",
        }),
        { status: 200, headers: { etag: 'W/"1"' } },
      );
    }) as unknown as typeof fetch;
    const cache = {};
    await pollGithub(["uutils/coreutils", "none/none"], cache, {
      fetch: fake,
      now: 1,
    });
    await pollGithub(["uutils/coreutils"], cache, { fetch: fake, now: 2 });
    expect(calls[2]).toContain('W/"1"');
    expect((cache as any)["uutils/coreutils"]).toMatchObject({
      tag: "v0.12.0",
      checked: 2,
    });
    expect((cache as any)["none/none"].tag).toBeNull();
  });
  test("crates.io polling honours ttl", async () => {
    let n = 0;
    const fake = (async () => (
      n++,
      new Response(
        JSON.stringify({
          crate: {
            max_stable_version: "0.12.0",
            updated_at: "2026-09-17T00:00:00Z",
          },
        }),
      )
    )) as unknown as typeof fetch;
    const cache = {};
    await pollCrates(["coreutils"], cache, { fetch: fake, now: 1000, gap: 0 });
    await pollCrates(["coreutils"], cache, { fetch: fake, now: 2000, gap: 0 });
    expect(n).toBe(1);
    expect(
      resolveRust(
        "coreutils",
        {
          "uutils/coreutils": {
            checked: 1,
            tag: "v0.12.0",
            date: "d",
            url: "u",
          },
        },
        cache,
      )[0],
    ).toMatchObject({ version: "0.12.0", crate_version: "0.12.0" });
  });
});

const inv = {
  gsrc: {
    coreutils: {
      label: "coreutils",
      tarball: "coreutils",
      version: "9.11",
      description: "Core GNU utilities",
      home: "http://www.gnu.org/software/coreutils/",
      subdir: "coreutils/",
      sha256: { "coreutils-9.11.tar.xz": "e".repeat(64) },
      builddeps: [],
      libdeps: [],
    },
    gcc9: {
      label: "GCC 9",
      tarball: "gcc9",
      version: "9.1.0",
      description: "GCC 9",
      home: null,
      subdir: "gnu/gcc/gcc-$(GARVERSION)/",
      sha256: {},
      builddeps: [],
      libdeps: [],
    },
    gcc16: {
      label: "GCC 16",
      tarball: "gcc16",
      version: "16.2.0",
      description: "GCC",
      home: null,
      subdir: "gnu/gcc/gcc-$(GARVERSION)/",
      sha256: { "gcc-16.2.0.tar.xz": "f".repeat(64) },
      builddeps: ["gmp", "#"],
      libdeps: [],
    },
  },
  gsrcRevno: 12334,
  pkgs: {
    coreutils: {
      name: "coreutils",
      category: "shell/userland",
      purpose: "Core utils",
      homepage: "https://www.gnu.org/software/coreutils/",
      repo: "https://git.savannah.gnu.org/cgit/coreutils.git",
      verdict: "keep",
      status: "active",
    },
  },
};

describe("feed", () => {
  const listing = parseListing(LISTING, NOW);
  const st = emptyState();
  st.github["uutils/coreutils"] = {
    checked: 1,
    tag: "v0.12.0",
    date: "2026-09-17T00:00:00Z",
    url: "https://github.com/uutils/coreutils/releases/tag/0.12.0",
  };
  st.announce["2026-11"] = { items: parseInfoGnu(INFO, "2026-11") };
  st.heads.coreutils = {
    head: "abc",
    changed_at: "2026-11-14T00:00:00Z",
    checked: 1,
  };
  test("one entry per package, ftp wins over GSRC, drift flagged", async () => {
    const f = await buildFeed(inv, st, listing, {
      now: NOW,
      root: "C:/nonexistent",
    });
    const ids = f.entries.map((e) => e.id);
    expect(ids).toContain("coreutils");
    expect(ids).toContain("gcc16");
    expect(ids).toContain("groff"); // ftp directory unknown to GSRC and the inventory
    const c = pkg(f, "coreutils")!;
    expect(c.upstream.version).toBe("9.12");
    expect(c.upstream.source).toBe("ftp");
    expect(c.drift).toEqual({ gsrc: true });
    expect(c.upstream.sha256).toBeNull(); // 9.12 is not the GSRC file: only a mirror download can fill it
    expect(c.rust_status).toBe("drop-in");
    expect(c.rust[0]!.version).toBe("0.12.0");
    expect(c.savannah?.head).toBe("abc");
    expect(c.upstream.signature.status).toBe("unverified");
    const g9 = pkg(f, "gcc9")!;
    expect(g9.upstream.version).toBe("9.1.0"); // shared ftp directory: the major of the GSRC pin selects the series
    expect(g9.drift.gsrc).toBe(false);
    const g = pkg(f, "gcc16")!;
    expect(g.upstream.sha256).toBe("f".repeat(64));
    expect(g.upstream.sha256_source).toBe("gsrc");
    expect(g.gsrc!.deps).toEqual(["gmp"]);
    expect(f.entries.find((e) => e.id === "groff")!.announce?.subject).toBe(
      "groff 1.25.0 released",
    );
    expect(f.counts.packages).toBe(f.entries.length);
    expect(f.sources.gsrc_revno).toBe(12334);
  });
  test("atom is well formed with one entry per released package", async () => {
    const f = await buildFeed(inv, st, listing, {
      now: NOW,
      root: "C:/nonexistent",
    });
    const x = buildAtom(f);
    expect(x.startsWith('<?xml version="1.0"')).toBe(true);
    expect((x.match(/<entry>/g) ?? []).length).toBe(
      f.entries.filter((e) => e.upstream.date).length,
    );
    expect(x).toContain("coreutils 9.12 | Rust: uutils coreutils 0.12.0");
    expect(x).not.toMatch(/<summary[^>]*>[^<]*&(?!amp;|lt;|gt;|quot;)/);
  });
  test("query layer", async () => {
    const f = await buildFeed(inv, st, listing, {
      now: NOW,
      root: "C:/nonexistent",
    });
    expect(search(f, { query: "core util" }).results[0]!.id).toBe("coreutils");
    expect(search(f, { filter: "drop-in" }).total).toBe(1);
    expect(search(f, { filter: "norust" }).total).toBe(f.entries.length - 1);
    expect(brief(pkg(f, "coreutils")!).rust[0]).toContain(
      "uutils coreutils 0.12.0 [drop-in]",
    );
    expect(status(f).counts.packages).toBe(f.entries.length);
    expect(recent(f, { limit: 1, since: "2020-01-01" })).toMatchObject({
      count: 1,
    });
    expect(typeof recent(f, { format: "atom", since: "2020-01-01" })).toBe(
      "string",
    );
    expect(pkg(f, "nonexistent")).toBeNull();
  });
  test("diff events: release, rust bump, announce, kernel", async () => {
    const a = await buildFeed(inv, st, listing, {
      now: NOW,
      root: "C:/nonexistent",
    });
    const b = structuredClone(a);
    b.generated = "2026-11-15T00:00:00Z";
    pkg(b, "coreutils")!.upstream.version = "9.13";
    pkg(b, "coreutils")!.rust[0]!.version = "0.13.0";
    const ev = diffEvents(a, b);
    expect(ev.map((e) => e.kind).toSorted()).toEqual(["release", "rust"]);
    expect(ev.find((e) => e.kind === "release")!.detail).toBe("9.12 -> 9.13");
  });
});
