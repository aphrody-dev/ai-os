// Static site builder: bundles site/app.ts, writes index.html, copies the feeds and the design tokens.
import { join } from "node:path";
import { buildAtom } from "./feed.ts";
import { repoRoot, writeAtomic } from "./store.ts";
import type { Feed, GnuEvent } from "./types.ts";

const CSS = `
:root{--bg:var(--md-sys-color-surface,#f6faff);--fg:var(--md-sys-color-on-surface,#141d23);--dim:var(--md-sys-color-on-surface-variant,#51606c);--pri:var(--md-sys-color-primary,#135b82);--cont:var(--md-sys-color-surface-container,#e6eff8);--line:var(--md-sys-color-outline-variant,#c0c7cf)}
@media(prefers-color-scheme:dark){:root{--bg:#0e1419;--fg:#dde3ea;--dim:#9aa6b2;--pri:#8bcdf6;--cont:#182028;--line:#3a444d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 var(--md-ref-typeface-plain,system-ui,sans-serif)}
header,main{max-width:1280px;margin:0 auto;padding:12px 16px}
h1{font-size:22px;margin:8px 0 2px}h2{font-size:17px}h3{font-size:14px;margin:12px 0 4px}
a{color:var(--pri);text-decoration:none}a:hover{text-decoration:underline}
.dim{color:var(--dim);font-size:12px}.mono{font-family:var(--md-ref-typeface-code,ui-monospace,monospace);font-size:12px}
nav{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:8px 0}
nav button{background:none;border:0;color:var(--fg);padding:8px 14px;cursor:pointer;font:inherit;border-bottom:2px solid transparent}
nav button[aria-selected=true]{border-bottom-color:var(--pri);color:var(--pri);font-weight:600}
#stats{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.stat{background:var(--cont);border-radius:10px;padding:6px 12px;min-width:110px}.stat b{display:block;font-size:20px}.stat span{font-size:11px;color:var(--dim)}
.bar{display:flex;gap:8px;align-items:center;margin:8px 0}.bar input,.bar select{background:var(--cont);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit}.bar input{flex:1;max-width:420px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:12px;color:var(--dim);padding:6px 8px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}th[data-sort]{cursor:pointer}
td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr:hover td{background:var(--cont)}
.b{display:inline-block;border-radius:6px;padding:0 6px;font-size:11px;background:var(--cont);border:1px solid var(--line)}
.s-verified,.k-drop-in{background:#1b6e3a;color:#fff;border-color:#1b6e3a}.s-invalid{background:#a02020;color:#fff}.s-unverified,.k-partial{background:#8a6a00;color:#fff;border-color:#8a6a00}.s-missing{opacity:.7}.warn{background:#a05a00;color:#fff}.k-alt,.k-lib{background:var(--pri);color:var(--bg)}
.links a{margin-right:6px}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}ul{padding-left:18px;margin:4px 0}
#events{list-style:none;padding:0}#events li{padding:3px 0;border-bottom:1px solid var(--line)}
`;

const HTML = (feed: Feed) => `<!doctype html>
<html lang="en" data-theme="aphrody">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GNU upstream and Rust equivalents - Aphrody</title>
<meta name="description" content="Real-time tracker of every GNU package upstream release, its Rust equivalent, and the Linux kernel.">
<link rel="alternate" type="application/atom+xml" title="GNU releases" href="feed.atom">
<link rel="alternate" type="application/json" title="GNU feed" href="feed.json">
<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="themes.css">
<style>${CSS}</style>
</head>
<body>
<header>
<h1>GNU upstream, in real time</h1>
<div class="dim"><span id="generated">${feed.generated.slice(0, 19).replace("T", " ")} UTC</span> | <a href="feed.json">feed.json</a> | <a href="feed.atom">feed.atom</a> | <a href="events.json">events.json</a></div>
<div id="stats"></div>
<nav aria-label="Sections" role="tablist"><button role="tab" id="t-packages" aria-controls="packages" data-tab="packages" aria-selected="true">Packages</button><button role="tab" id="t-kernel" aria-controls="kernel-tab" data-tab="kernel-tab" aria-selected="false" tabindex="-1">Linux kernel</button><button role="tab" id="t-changes" aria-controls="changes" data-tab="changes" aria-selected="false" tabindex="-1">Changes</button><button role="tab" id="t-about" aria-controls="about" data-tab="about" aria-selected="false" tabindex="-1">Feeds</button></nav>
</header>
<main>
<section id="packages" role="tabpanel" aria-labelledby="t-packages">
<div class="bar"><input id="q" type="search" placeholder="Search packages, descriptions, Rust equivalents" aria-label="Search"><select id="f" aria-label="Filter"><option value="all">All</option><option value="rust">With Rust equivalent</option><option value="drop-in">Rust drop-in</option><option value="norust">No Rust equivalent</option><option value="drift">GSRC behind upstream</option><option value="verified">Signature verified</option><option value="proven">Proof present</option><option value="mirrored">Mirrored to R2</option></select><span id="count" class="dim" role="status"></span></div>
<table><thead><tr><th data-sort="id">Package</th><th data-sort="date">Upstream</th><th data-sort="sig">Signature</th><th>GSRC</th><th data-sort="rust">Rust equivalent</th><th>Proof</th><th>Links</th></tr></thead><tbody id="rows"></tbody></table>
</section>
<section id="kernel-tab" role="tabpanel" aria-labelledby="t-kernel" hidden><div id="kernel"></div></section>
<section id="changes" role="tabpanel" aria-labelledby="t-changes" hidden><h2>Recent changes</h2><ul id="events"></ul></section>
<section id="about" role="tabpanel" aria-labelledby="t-about" hidden>
<h2>Feeds</h2>
<ul><li><a href="feed.json">feed.json</a>: one entry per package, plus the kernel section.</li><li><a href="feed.atom">feed.atom</a>: Atom 1.0, newest upstream release first.</li><li><a href="events.json">events.json</a>: detected changes (release, Rust, announce, kernel).</li></ul>
<p class="dim">Sources: ftp.gnu.org ls-lrRt, info-gnu archive, Savannah git, GSRC, GitHub releases, crates.io, kernel.org, Android GKI and ChromeOS gitiles. Polled every 10 minutes on fr2; tarballs and signatures mirrored to R2.</p>
</section>
</main>
<script type="module" src="app.js"></script>
</body>
</html>
`;

/** Build the static site into `out`: index.html, app.js, feed files, tokens. */
export async function buildSite(
  feed: Feed,
  out: string,
  events: GnuEvent[] = [],
) {
  const entry = join(repoRoot(), "system", "gnu-ts", "site", "app.ts");
  const r = await Bun.build({
    entrypoints: [entry],
    outdir: out,
    minify: true,
    target: "browser",
    naming: "app.js",
  });
  if (!r.success) throw new Error(`site bundle failed: ${r.logs.join("\n")}`);
  await writeAtomic(join(out, "index.html"), HTML(feed));
  await writeAtomic(join(out, "feed.json"), JSON.stringify(feed));
  await writeAtomic(join(out, "feed.atom"), buildAtom(feed));
  await writeAtomic(
    join(out, "events.json"),
    JSON.stringify(events.slice(-500)),
  );
  for (const f of ["tokens.css", "themes.css"]) {
    const src = Bun.file(join(repoRoot(), "frameworks", "design", "tokens", f));
    if (await src.exists()) await Bun.write(join(out, f), src);
  }
  await writeAtomic(join(out, "robots.txt"), "User-agent: *\nAllow: /\n");
}
