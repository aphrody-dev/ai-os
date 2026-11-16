// Browser app of gnu.aphrody.com: searchable package table, GNU vs Rust status, kernel, feeds. No dependency.
import type { Entry, Feed, GnuEvent } from "../src/types.ts";

type SortKey = "id" | "date" | "rust" | "sig";
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
const ago = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
/** Feed URLs come from upstream (GitHub, kernel.org, ftp): only http(s) or same-origin paths reach an href. */
const url = (u: unknown) => {
  try {
    const p = new URL(String(u ?? ""), location.href);
    return p.protocol === "https:" || p.protocol === "http:" ? esc(p.href) : "#";
  } catch {
    return "#";
  }
};
/** Class token from feed data: anything outside [a-z0-9-] is dropped so it cannot leave the attribute. */
const cls = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");
const RANK: Record<string, number> = {
  none: 0,
  lib: 1,
  alt: 2,
  partial: 3,
  "drop-in": 4,
};
const SIG: Record<string, number> = {
  verified: 3,
  unverified: 2,
  invalid: 1,
  missing: 0,
};

let feed: Feed;
let sortKey: SortKey = "date";
let sortDir = -1;

const badge = (c: string, text: string) =>
  `<span class="b ${cls(c)}">${esc(text)}</span>`;

function rustCell(e: Entry) {
  if (!e.rust.length) return `<span class="dim">none</span>`;
  return e.rust
    .map((r) => {
      const v = r.version ?? r.crate_version;
      return `<div>${badge(`k-${r.kind}`, r.kind)} <a href="${url(r.url)}">${esc(r.name)}</a> ${v ? esc(v) : '<span class="dim">no release</span>'}${r.coverage ? ` <span class="dim" title="${esc(r.coverage)}">${esc(r.coverage.match(/\d+[.,]\d+ ?%/)?.[0] ?? "")}</span>` : ""}</div>`;
    })
    .join("");
}

function row(e: Entry) {
  const u = e.upstream;
  const sig = u.signature.status;
  return `<tr data-id="${esc(e.id)}">
  <td><a class="id" href="${url(e.homepage)}">${esc(e.id)}</a><div class="dim">${esc(e.description ?? "")}</div></td>
  <td>${u.version ? `<b>${esc(u.version)}</b>` : '<span class="dim">-</span>'}<div class="dim">${ago(u.date)}${e.drift.gsrc ? " " + badge("warn", "GSRC behind") : ""}</div></td>
  <td>${badge(`s-${sig}`, sig)}</td>
  <td>${e.gsrc ? esc(e.gsrc.version) : '<span class="dim">-</span>'}</td>
  <td>${rustCell(e)}</td>
  <td>${e.proof.status === "present" ? badge("s-verified", e.proof.rate ?? "proof") : '<span class="dim">none</span>'}</td>
  <td class="links">${u.url ? `<a href="${url(u.url)}">tar</a>` : ""} ${u.sig_url ? `<a href="${url(u.sig_url)}">sig</a>` : ""} ${e.announce ? `<a href="${url(e.announce.url)}" title="${esc(e.announce.subject)}">info-gnu</a>` : ""}</td>
</tr>`;
}

function matches(e: Entry, q: string, f: string) {
  if (q) {
    const hay =
      `${e.id} ${e.name} ${e.description ?? ""} ${e.category ?? ""} ${e.rust.map((r) => r.name).join(" ")}`.toLowerCase();
    if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  switch (f) {
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
}

function render() {
  const q = $<HTMLInputElement>("q").value.trim().toLowerCase();
  const f = $<HTMLSelectElement>("f").value;
  const rows = feed.entries.filter((e) => matches(e, q, f));
  rows.sort((a, b) => {
    const d =
      sortKey === "id"
        ? a.id.localeCompare(b.id)
        : sortKey === "date"
          ? (a.upstream.date ?? "").localeCompare(b.upstream.date ?? "")
          : sortKey === "rust"
            ? RANK[a.rust_status]! - RANK[b.rust_status]!
            : SIG[a.upstream.signature.status]! -
              SIG[b.upstream.signature.status]!;
    return d * sortDir || a.id.localeCompare(b.id);
  });
  $("count").textContent = `${rows.length} / ${feed.entries.length} packages`;
  $("rows").innerHTML = rows.slice(0, 600).map(row).join("");
}

function stat(label: string, v: number | string) {
  return `<div class="stat"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
}

function kernel() {
  const k = feed.kernel;
  const el = $("kernel");
  if (!k) {
    el.innerHTML = '<p class="dim">No kernel data yet.</p>';
    return;
  }
  const rel = k.releases
    .map(
      (r) =>
        `<tr><td>${badge(`m-${r.moniker}`, r.moniker)}</td><td><b>${esc(r.version)}</b>${r.eol ? " " + badge("warn", "EOL") : ""}</td><td>${ago(r.date)}</td><td>${badge(`s-${r.signature.status}`, r.signature.status)}</td><td>${r.rust_in_tree === null ? '<span class="dim">?</span>' : r.rust_in_tree ? "yes" : "no"}</td><td class="mono">${esc(r.sha256?.slice(0, 16) ?? "")}</td><td><a href="${url(r.url)}">src</a> ${r.sign_url ? `<a href="${url(r.sign_url)}">sign</a>` : ""} ${r.mirror ? badge("s-verified", "R2") : ""}</td></tr>`,
    )
    .join("");
  const br = (l: { name: string; head: string }[]) =>
    l
      .map(
        (b) =>
          `<li><span class="mono">${esc(b.name)}</span> <span class="dim mono">${esc(b.head.slice(0, 10))}</span></li>`,
      )
      .join("");
  const and = (k.android ?? [])
    .map(
      (a) =>
        `<tr><td class="mono">${esc(a.branch)}</td><td>${esc(a.kernel ?? "")}</td><td class="mono">${esc(a.head.commit.slice(0, 10))}</td><td>${ago(a.head.date)}</td><td>${esc(a.upstream_base ?? "")}</td><td>${badge("m-stable", a.kmi.phase ?? "?")}</td><td class="mono">clang ${esc(a.clang ?? "?")}, rustc ${esc(a.rustc ?? "?")}</td><td>${a.rust_binder === "y" ? badge("s-verified", "Rust Binder") : '<span class="dim">C Binder</span>'}</td></tr>`,
    )
    .join("");
  el.innerHTML = `
  <h2>Android GKI tracker</h2>
  <table id="atable"><thead><tr><th>Branch</th><th>Kernel</th><th>Head</th><th>Date</th><th>Base</th><th>KMI</th><th>Toolchain pins</th><th>Binder</th></tr></thead><tbody>${and || '<tr><td colspan="8" class="dim">No tracker output yet.</td></tr>'}</tbody></table>
  <h2>Kernel releases (kernel.org)</h2>
  <table id="ktable"><thead><tr><th>Branch</th><th>Version</th><th>Date</th><th>Signature</th><th>Rust in tree</th><th>sha256</th><th>Links</th></tr></thead><tbody>${rel}</tbody></table>
  <div class="cols">
    <section><h3>Trees</h3><ul>${k.trees.map((t) => `<li><a href="${url(t.url)}">${esc(t.name)}</a> <span class="dim mono">${esc(t.head?.slice(0, 10) ?? "")}</span></li>`).join("")}</ul>
      <h3>Rust for Linux</h3><ul><li><a href="${url(k.rust.docs)}">docs.kernel.org/rust</a> ${k.rust.docs_ok ? badge("s-verified", "up") : ""}</li><li>in tree since ${esc(k.rust.in_tree_since ?? "?")}</li><li><a href="${url(k.rust.rust_for_linux.url)}">${esc(k.rust.rust_for_linux.name)}</a> <span class="dim mono">${esc(k.rust.rust_for_linux.head?.slice(0, 10) ?? "")}</span></li></ul>
      <h3>Research</h3><ul><li><a href="${url(k.research.url)}">${esc(k.research.repo)}</a> <span class="dim">pushed ${ago(k.research.pushed)}</span></li></ul></section>
    <section><h3>Android GKI</h3><ul>${br(k.gki)}</ul></section>
    <section><h3>ChromeOS</h3><ul>${br(k.chromeos.slice(0, 12))}</ul></section>
  </div>`;
}

function events(list: GnuEvent[]) {
  $("events").innerHTML = list.length
    ? list
        .toReversed()
        .slice(0, 60)
        .map(
          (e) =>
            `<li><span class="mono dim">${esc(e.at.slice(0, 16).replace("T", " "))}</span> ${badge(`m-${e.kind}`, e.kind)} <b>${esc(e.id)}</b> ${esc(e.detail)}</li>`,
        )
        .join("")
    : '<li class="dim">No change recorded yet.</li>';
}

function tabs() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    b.addEventListener("click", () => {
      for (const x of document.querySelectorAll("nav button")) {
        x.setAttribute("aria-selected", String(x === b));
        x.setAttribute("tabindex", x === b ? "0" : "-1");
      }
      for (const s of document.querySelectorAll<HTMLElement>("main > section"))
        s.hidden = s.id !== b.dataset.tab;
      history.replaceState(null, "", `#${b.dataset.tab}`);
    });
  }
  // Roving tabindex: arrow keys, Home and End move between tabs (WAI-ARIA tabs pattern).
  const list = [...document.querySelectorAll<HTMLButtonElement>("nav button")];
  document.querySelector("nav")?.addEventListener("keydown", (ev) => {
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const k = (ev as KeyboardEvent).key;
    const j = k === "ArrowRight" ? (i + 1) % list.length : k === "ArrowLeft" ? (i - 1 + list.length) % list.length : k === "Home" ? 0 : k === "End" ? list.length - 1 : -1;
    if (j < 0) return;
    ev.preventDefault();
    list[j]!.focus();
    list[j]!.click();
  });
  const start = location.hash.slice(1);
  document
    .querySelector<HTMLButtonElement>(`nav button[data-tab="${start}"]`)
    ?.click();
}

async function main() {
  const [f, ev] = await Promise.all([
    fetch("feed.json").then((r) => r.json() as Promise<Feed>),
    fetch("events.json")
      .then((r) => (r.ok ? (r.json() as Promise<GnuEvent[]>) : []))
      .catch(() => [] as GnuEvent[]),
  ]);
  feed = f;
  const c = f.counts;
  $("stats").innerHTML = [
    stat("packages", c.packages),
    stat("with release", c.with_release),
    stat("signature verified", c.verified),
    stat("Rust equivalent", c.rust_any),
    stat("Rust drop-in", c.rust_drop_in),
    stat("GSRC behind", c.drift_gsrc),
    stat("mirrored to R2", c.mirrored),
    stat("GSRC revno", f.sources.gsrc_revno ?? "?"),
  ].join("");
  $("generated").textContent =
    `feed ${f.generated.slice(0, 19).replace("T", " ")} UTC`;
  // One render per pause in typing: each render rebuilds up to 600 rows, too heavy for every keystroke (INP).
  let typing: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>("q").addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(render, 150);
  });
  $<HTMLSelectElement>("f").addEventListener("change", render);
  for (const th of document.querySelectorAll<HTMLElement>("th[data-sort]")) {
    th.addEventListener("click", () => {
      const k = th.dataset.sort as SortKey;
      sortDir = k === sortKey ? -sortDir : k === "id" ? 1 : -1;
      sortKey = k;
      render();
    });
  }
  render();
  kernel();
  events(ev);
  tabs();
  document.body.dataset.ready = "1";
}

main().catch((e) => {
  $("count").textContent = `Failed to load feed.json: ${e}`;
});
