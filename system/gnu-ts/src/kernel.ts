// Linux kernel section of the feed: kernel.org releases, tarball sha256 and signatures, git.kernel.org trees,
// Android GKI and ChromeOS branches (gitiles), Rust for Linux and google/kernel-research.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unquote, vars } from "./mk.ts";
import { get as httpGet, parseInfoRefs, pool, versionCmp } from "./upstream.ts";
import { sha256File, sqvDetached, sqvPath } from "./verify.ts";
import type { SigStatus, Signature } from "./types.ts";

export type KernelRelease = {
  moniker: "mainline" | "stable" | "longterm" | "linux-next" | string;
  version: string;
  series: string; // 7.3, 6.18
  date: string;
  eol: boolean;
  url: string;
  sign_url: string | null;
  sha256: string | null;
  signature: Signature;
  changelog: string | null;
  rust_in_tree: boolean | null;
  mirror: { key: string; sign_key: string | null; at: string } | null;
};

/** Per-branch analysis of a GKI branch read from gitiles (parseAndroid). */
export type AndroidTrack = {
  branch: string;
  fetched: string;
  head: { commit: string; date: string; subject: string };
  kernel: string | null;
  upstream_base: string | null;
  kmi: {
    phase: string | null;
    enforced: boolean | null;
    abi_definition: boolean | null;
  };
  /** Which of CONSTANTS_PROBES carried the toolchain pins on this branch. */
  constants_path: string | null;
  clang: string | null;
  rustc: string | null;
  kmi_generation: string | null;
  rust_binder: string | null;
  rust_config: string | null;
};

export type KernelBranch = { name: string; head: string };
export type KernelTree = {
  name: string;
  url: string;
  head: string | null;
  changed_at: string | null;
};

export type KernelState = {
  releases: {
    moniker: string;
    version: string;
    iseol: boolean;
    released: { timestamp: number; isodate: string };
    source: string | null;
    pgp: string | null;
    changelog?: string | null;
  }[];
  latest_stable: string | null;
  sums: Record<string, string>; // linux-<v>.tar.xz -> sha256
  trees: Record<string, { head: string; changed_at: string }>;
  gki: Record<string, string>;
  chromeos: Record<string, string>;
  android: Record<string, AndroidTrack>;
  rust_tree: Record<string, boolean>; // kernel series ref -> rust/ exists in tree
  rfl: { head: string | null; changed_at: string | null };
  research: { pushed: string | null; url: string };
  docs_rust: boolean;
  mirror: Record<
    string,
    {
      file: string;
      sha256: string;
      key: string;
      sign_key: string | null;
      at: string;
      signature: Signature;
    }
  >;
  checked: number;
};

export const emptyKernel = (): KernelState => ({
  releases: [],
  latest_stable: null,
  sums: {},
  trees: {},
  gki: {},
  android: {},
  chromeos: {},
  rust_tree: {},
  rfl: { head: null, changed_at: null },
  research: { pushed: null, url: "https://github.com/google/kernel-research" },
  docs_rust: false,
  mirror: {},
  checked: 0,
});

export type KernelSection = {
  latest_stable: string | null;
  releases: KernelRelease[];
  trees: KernelTree[];
  gki: KernelBranch[];
  android: AndroidTrack[];
  chromeos: KernelBranch[];
  rust: {
    docs: string;
    docs_ok: boolean;
    in_tree_since: string | null;
    rust_for_linux: KernelTree;
  };
  research: { repo: string; url: string; pushed: string | null };
  sources: string[];
};

export const TREES: Record<string, string> = {
  torvalds:
    "https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git",
  stable: "https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git",
  "linux-next":
    "https://git.kernel.org/pub/scm/linux/kernel/git/next/linux-next.git",
};
const GKI_REPO = "https://android.googlesource.com/kernel/common";
const GKI_URL = `${GKI_REPO}/+refs/heads?format=JSON`;
const CHROMEOS_URL =
  "https://chromium.googlesource.com/chromiumos/third_party/kernel/+refs/heads?format=JSON";
const RFL = "https://github.com/Rust-for-Linux/linux.git";

const stripXssi = (body: string) => body.replace(/^\)\]\}'\n/, "");

/** Gitiles JSON starts with the anti-XSSI prefix `)]}'`. Returns branch -> sha. */
export function parseGitiles(body: string): Record<string, string> {
  const j = JSON.parse(stripXssi(body)) as Record<
    string,
    { value?: string }
  >;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(j))
    if (v?.value && k !== "HEAD")
      out[k.replace(/^refs\/heads\//, "")] = v.value;
  return out;
}

export const isGki = (b: string) =>
  /^android-mainline$|^android\d+-\d+\.\d+(?:-\d+)?$/.test(b);
export const isChromeos = (b: string) => /^chromeos-\d+\.\d+$/.test(b);

const isMainline = (n: string) => n === "android-mainline";
/** Mainline first, then the newest kernel series (`android15-6.6` -> `15-6.6`, `chromeos-6.12` -> `6.12`). */
const byBranchDesc = (a: KernelBranch, b: KernelBranch) =>
  Number(isMainline(b.name)) - Number(isMainline(a.name)) ||
  versionCmp(b.name.replace(/^\D+/, ""), a.name.replace(/^\D+/, ""));
export const pickBranches = (
  all: Record<string, string>,
  pred: (b: string) => boolean,
): KernelBranch[] =>
  Object.entries(all)
    .filter(([n]) => pred(n))
    .map(([name, head]) => ({ name, head }))
    .toSorted(byBranchDesc);

/** sha256sums.asc (cleartext-signed): file -> sha256. */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(
    /^([0-9a-f]{64})\s+(linux-[\w.-]+\.tar\.(?:xz|gz))$/gm,
  ))
    out[m[2]!] = m[1]!;
  return out;
}

export const seriesOf = (v: string) => /^(\d+\.\d+)/.exec(v)?.[1] ?? v;
export const sumsUrl = (v: string) =>
  `https://cdn.kernel.org/pub/linux/kernel/v${v.split(".")[0]}.x/sha256sums.asc`;

const get = (url: string, headers: Record<string, string> = {}, ms = 30_000) =>
  httpGet(url, headers, ms);

export async function pollKernel(
  ks: KernelState,
  opts: { token?: string } = {},
) {
  const now = new Date().toISOString();
  try {
    const r = await get("https://www.kernel.org/releases.json");
    if (r.ok) {
      const j = (await r.json()) as {
        latest_stable?: { version?: string };
        releases: KernelState["releases"];
      };
      ks.releases = j.releases;
      ks.latest_stable = j.latest_stable?.version ?? null;
    }
  } catch {
    // keep
  }
  const majors = new Set(
    ks.releases
      .filter(
        (r) => /^\d/.test(r.version) && r.source?.includes("cdn.kernel.org"),
      )
      .map((r) => r.version.split(".")[0]!),
  );
  for (const m of majors) {
    try {
      const r = await get(sumsUrl(`${m}.0`));
      if (r.ok) Object.assign(ks.sums, parseSums(await r.text()));
    } catch {
      // keep
    }
  }
  for (const [name, url] of Object.entries(TREES)) {
    try {
      const r = await get(`${url}/info/refs?service=git-upload-pack`);
      if (!r.ok) continue;
      const { head } = parseInfoRefs(await r.text());
      if (head)
        ks.trees[name] = {
          head,
          changed_at:
            ks.trees[name]?.head === head ? ks.trees[name]!.changed_at : now,
        };
    } catch {
      // keep
    }
  }
  try {
    const r = await get(RFL.replace(/$/, "/info/refs?service=git-upload-pack"));
    if (r.ok) {
      const { refs } = parseInfoRefs(await r.text());
      const head = refs["rust-next"] ?? refs.rust ?? null;
      if (head)
        ks.rfl = {
          head,
          changed_at: ks.rfl.head === head ? ks.rfl.changed_at : now,
        };
    }
  } catch {
    // keep
  }
  for (const [url, field, pred] of [
    [GKI_URL, "gki", isGki],
    [CHROMEOS_URL, "chromeos", isChromeos],
  ] as const) {
    try {
      const r = await get(url, {}, 60_000);
      if (r.ok)
        ks[field] = Object.fromEntries(
          pickBranches(parseGitiles(await r.text()), pred).map((b) => [
            b.name,
            b.head,
          ]),
        );
    } catch {
      // keep
    }
  }
  await pollAndroid(ks);
  try {
    ks.docs_rust = (await get("https://docs.kernel.org/rust/index.html")).ok;
  } catch {
    // keep
  }
  try {
    const h: Record<string, string> = { accept: "application/vnd.github+json" };
    if (opts.token) h.authorization = `Bearer ${opts.token}`;
    const r = await get(
      "https://api.github.com/repos/google/kernel-research",
      h,
    );
    if (r.ok)
      ks.research.pushed =
        ((await r.json()) as { pushed_at?: string }).pushed_at ?? null;
  } catch {
    // keep
  }
  // rust/ in the tree: one GitHub contents probe per series (tag vX.Y); the answer for a released series never changes.
  for (const r of ks.releases.filter((x) =>
    ["mainline", "stable", "longterm"].includes(x.moniker),
  )) {
    const ref =
      r.moniker === "mainline" ? `v${r.version}` : `v${seriesOf(r.version)}`;
    if (ks.rust_tree[ref] !== undefined) continue;
    try {
      const h: Record<string, string> = {
        accept: "application/vnd.github+json",
      };
      if (opts.token) h.authorization = `Bearer ${opts.token}`;
      const p = await get(
        `https://api.github.com/repos/torvalds/linux/contents/rust?ref=${ref}`,
        h,
      );
      if (p.status === 200) ks.rust_tree[ref] = true;
      else if (p.status === 404) ks.rust_tree[ref] = false;
    } catch {
      // retry next cycle
    }
  }
  ks.checked = Date.now();
}

/** Gitiles GET: body, or null on 404 (absent); any other failure throws so the caller retries next cycle. */
async function gitilesGet(url: string): Promise<string | null> {
  const r = await get(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

/** Gitiles JSON document (anti-XSSI prefix stripped); null when absent. */
async function gitilesJson<T>(url: string): Promise<T | null> {
  const body = await gitilesGet(url);
  return body === null ? null : (JSON.parse(stripXssi(body)) as T);
}

/** Gitiles file as text (`?format=TEXT` is base64); "" when the ref has no such file. */
async function gitilesFile(ref: string, path: string): Promise<string> {
  const body = await gitilesGet(`${GKI_REPO}/+/${ref}/${path}?format=TEXT`);
  return body === null ? "" : Buffer.from(body, "base64").toString();
}

/** Files that can carry the toolchain pins, in order of preference (the newer Bazel layout first). */
export const CONSTANTS_PROBES = ["bazel/constants.scl", "build.config.constants"];

/** Per-branch analysis from the gitiles reads of one GKI branch head; pure so tests feed it fixtures. */
export function parseAndroid(
  branch: string,
  head: { commit?: string; message?: string; committer?: { time?: string } },
  files: { makefile: string; constants: string; constantsPath?: string | null; bazel: string; defconfig: string },
  fetched = new Date().toISOString(),
): AndroidTrack | null {
  if (!head.commit) return null;
  const mkv = vars(files.makefile);
  const pins = vars(files.constants);
  const cfgs = vars(files.defconfig);
  const mk = (k: string) => mkv[k] ?? "";
  const pin = (k: string) => unquote(pins[k]);
  const cfg = (k: string) => cfgs[`CONFIG_${k}`] ?? null;
  const enforced = /^\s*kmi_enforced = True/m.test(files.bazel);
  const t = head.committer?.time ? Date.parse(head.committer.time) : NaN;
  const known = mk("VERSION") !== "";
  return {
    branch,
    fetched,
    head: {
      commit: head.commit,
      date: Number.isNaN(t) ? "" : new Date(t).toISOString(),
      subject: head.message?.split("\n")[0] ?? "",
    },
    kernel: known ? `${mk("VERSION")}.${mk("PATCHLEVEL")}.${mk("SUBLEVEL")}${mk("EXTRAVERSION")}` : null,
    upstream_base: known ? `v${mk("VERSION")}.${mk("PATCHLEVEL")}` : null,
    kmi: {
      phase: files.bazel ? (enforced ? "kmi-tracking-or-frozen" : "development") : null,
      enforced: files.bazel ? enforced : null,
      abi_definition: files.bazel ? /^\s*abi_definition_stg = "/m.test(files.bazel) : null,
    },
    constants_path: files.constantsPath ?? null,
    clang: pin("CLANG_VERSION"),
    rustc: pin("RUSTC_VERSION"),
    kmi_generation: pin("KMI_GENERATION"),
    rust_binder: cfg("ANDROID_BINDER_IPC_RUST"),
    rust_config: cfg("RUST"),
  };
}

/** Analyse every GKI branch whose head moved since the last cycle (4 branches at a time; pins sit in CONSTANTS_PROBES). */
export async function pollAndroid(ks: KernelState) {
  const todo = Object.entries(ks.gki).filter(
    ([branch, sha]) => ks.android[branch]?.head.commit !== sha,
  );
  await pool(todo, 4, async ([branch, sha]) => {
    try {
      const [head, makefile, bazel, defconfig, ...probed] = await Promise.all([
        gitilesJson<Parameters<typeof parseAndroid>[1]>(`${GKI_REPO}/+/${sha}?format=JSON`),
        gitilesFile(sha, "Makefile"),
        gitilesFile(sha, "BUILD.bazel"),
        gitilesFile(sha, "arch/arm64/configs/gki_defconfig"),
        ...CONSTANTS_PROBES.map((p) => gitilesFile(sha, p)),
      ]);
      if (!head) return;
      const hit = probed.findIndex((s) => s !== "");
      const t = parseAndroid(branch, head, {
        makefile,
        constants: hit < 0 ? "" : probed[hit]!,
        constantsPath: hit < 0 ? null : CONSTANTS_PROBES[hit]!,
        bazel,
        defconfig,
      });
      if (t) ks.android[branch] = t;
    } catch {
      // retry next cycle: the record is not saved
    }
  });
  for (const b of Object.keys(ks.android)) if (!ks.gki[b]) delete ks.android[b];
}

export function buildKernel(ks: KernelState): KernelSection {
  const order = ["mainline", "stable", "longterm", "linux-next"];
  const releases: KernelRelease[] = ks.releases
    .filter((r) => order.includes(r.moniker))
    .map((r) => {
      const file = r.source?.split("/").at(-1) ?? "";
      const mir = ks.mirror[r.version];
      const ref =
        r.moniker === "mainline" ? `v${r.version}` : `v${seriesOf(r.version)}`;
      return {
        moniker: r.moniker,
        version: r.version,
        series: seriesOf(r.version),
        date: new Date(r.released.timestamp * 1000).toISOString(),
        eol: r.iseol,
        url: r.source ?? "",
        sign_url: r.pgp,
        sha256: ks.sums[file] ?? mir?.sha256 ?? null,
        signature: mir
          ? mir.signature
          : {
              status: (r.pgp ? "unverified" : "missing") as SigStatus,
              detail: r.pgp
                ? "not downloaded yet"
                : "no signature published for this snapshot",
            },
        changelog: r.changelog ?? null,
        rust_in_tree:
          r.moniker === "linux-next" ? true : (ks.rust_tree[ref] ?? null),
        mirror: mir
          ? { key: mir.key, sign_key: mir.sign_key, at: mir.at }
          : null,
      };
    })
    .toSorted(
      (a, b) =>
        order.indexOf(a.moniker) - order.indexOf(b.moniker) ||
        versionCmp(b.version, a.version),
    );
  const firstRust =
    releases
      .filter((r) => r.rust_in_tree)
      .toSorted((a, b) => versionCmp(a.series, b.series))[0]?.series ?? null;
  return {
    latest_stable: ks.latest_stable,
    releases,
    trees: Object.entries(TREES).map(([name, url]) => ({
      name,
      url,
      head: ks.trees[name]?.head ?? null,
      changed_at: ks.trees[name]?.changed_at ?? null,
    })),
    android: Object.values(ks.android ?? {}).toSorted((a, b) =>
      byBranchDesc({ name: a.branch, head: "" }, { name: b.branch, head: "" }),
    ),
    gki: Object.entries(ks.gki)
      .map(([name, head]) => ({ name, head }))
      .toSorted(byBranchDesc),
    chromeos: Object.entries(ks.chromeos)
      .map(([name, head]) => ({ name, head }))
      .toSorted(byBranchDesc),
    rust: {
      docs: "https://docs.kernel.org/rust/",
      docs_ok: ks.docs_rust,
      in_tree_since: firstRust,
      rust_for_linux: {
        name: "Rust-for-Linux/linux (rust-next)",
        url: RFL,
        head: ks.rfl.head,
        changed_at: ks.rfl.changed_at,
      },
    },
    research: {
      repo: "google/kernel-research",
      url: ks.research.url,
      pushed: ks.research.pushed,
    },
    sources: [
      "https://www.kernel.org/releases.json",
      "https://www.kernel.org/feeds/kdist.xml",
      "https://cdn.kernel.org/pub/linux/kernel/",
      GKI_URL,
      CHROMEOS_URL,
    ],
  };
}

/**
 * Verify linux-<v>.tar.xz against its .tar.sign (made over the uncompressed tar) with the keyring in
 * GNU_KERNEL_KEYRING (exported kernel.org developer keys); unverified when sqv, xz or the keyring is absent.
 */
export async function verifyKernel(
  tarXz: string,
  sign: string | null,
  keyring = Bun.env.GNU_KERNEL_KEYRING,
): Promise<Signature> {
  if (!sign) return { status: "missing", detail: "no .tar.sign" };
  if (!sqvPath()) return { status: "unverified", detail: "sqv not installed" };
  if (!keyring || !(await Bun.file(keyring).exists()))
    return {
      status: "unverified",
      detail: "kernel.org keyring not configured (GNU_KERNEL_KEYRING)",
    };
  const tar = tarXz.replace(/\.xz$/, "");
  const x = await Bun.$`xz -dc ${tarXz} > ${tar}`.quiet().nothrow();
  if (x.exitCode) return { status: "unverified", detail: "xz failed" };
  try {
    const r = await sqvDetached(tar, sign, keyring);
    return r.status === "verified"
      ? { ...r, detail: `${r.detail}; tar.sign over the uncompressed tar` }
      : r;
  } finally {
    rmSync(tar, { force: true });
  }
}

/** Mirror non-EOL stable and longterm tarballs plus their .sign to r2:<bucket>/kernel/v<N>.x/. */
export async function mirrorKernel(
  ks: KernelState,
  sec: KernelSection,
  opts: {
    bucket: string;
    staging: string;
    maxFiles?: number;
    log?: (s: string) => void;
  },
) {
  const todo = sec.releases
    .filter(
      (r) =>
        ["stable", "longterm"].includes(r.moniker) &&
        !r.eol &&
        r.url.includes("cdn.kernel.org") &&
        !r.mirror,
    )
    .slice(0, opts.maxFiles ?? 2);
  for (const r of todo) {
    const dir = join(opts.staging, `linux-${r.version}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, r.url.split("/").at(-1)!);
    try {
      const d = await get(r.url, {}, 900_000);
      if (!d.ok) throw new Error(`HTTP ${d.status}`);
      await Bun.write(file, d);
      const sha = await sha256File(file);
      if (r.sha256 && r.sha256 !== sha)
        throw new Error(`sha256 differs from kernel.org sha256sums (${sha})`);
      let sign: string | null = null;
      if (r.sign_url) {
        const s = await get(r.sign_url);
        if (s.ok) {
          sign = join(dir, r.sign_url.split("/").at(-1)!);
          await Bun.write(sign, s);
        }
      }
      const signature = await verifyKernel(file, sign);
      const key = `kernel/v${r.version.split(".")[0]}.x/${file.split(/[\\/]/).at(-1)}`;
      const up =
        await Bun.$`rclone copyto ${file} ${`r2:${opts.bucket}/${key}`}`
          .quiet()
          .nothrow();
      if (up.exitCode)
        throw new Error(
          `rclone: ${up.stderr.toString().trim().split("\n").at(-1)}`,
        );
      let signKey: string | null = null;
      if (sign) {
        signKey = `${key.replace(/\.tar\.xz$/, "")}.tar.sign`;
        await Bun.$`rclone copyto ${sign} ${`r2:${opts.bucket}/${signKey}`}`
          .quiet()
          .nothrow();
      }
      ks.mirror[r.version] = {
        file: file.split(/[\\/]/).at(-1)!,
        sha256: sha,
        key,
        sign_key: signKey,
        at: new Date().toISOString(),
        signature,
      };
      opts.log?.(`kernel mirror ${r.version} ${signature.status}`);
    } catch (err) {
      opts.log?.(
        `kernel mirror ${r.version} failed: ${String(err).slice(0, 160)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
