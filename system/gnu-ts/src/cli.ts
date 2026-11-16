#!/usr/bin/env bun
// ay gnu <status|search|package|sync|feed|diff|kernel|daemon|site|verify> -- GNU upstream tracker.
import { buildSite } from "./site.ts";
import { paths, readEvents } from "./store.ts";
import { sync } from "./sync.ts";
import {
  brief,
  changes,
  kernel,
  loadFeed,
  pkg,
  recent,
  search,
  status,
} from "./tools.ts";
import { sqvPath } from "./verify.ts";

const USAGE = `usage: ay gnu <command> [options]
  status                      feed age, counts, sources, latest releases
  search [words] [--filter rust|drop-in|norust|drift|verified|proven|mirrored] [--limit N]
  package <id>                full entry of one package
  feed [--since 24h|7d] [--limit N] [--atom]   recent releases (Atom with --atom)
  diff [--since 24h|7d]       changes detected between polls (release, rust, announce, kernel)
  kernel                      Linux kernel upstream: releases, trees, GKI, ChromeOS, Rust for Linux
  sync [--mirror] [--no-heads] [--no-rust] [--no-kernel] [--no-site] [--bucket B] [--gsrc DIR]
                              one poll cycle: fetch sources, rebuild feed/site, optionally mirror to R2
  daemon                      poll forever (GNU_INTERVAL seconds, default 600) with R2 mirroring; run by aphrody-gnu.service
  site [--out DIR]            rebuild the static site from the current feed
  verify                      signature tooling check (sqv)
env: GNU_HOME (work dir, default var/gnu), GNU_FEED (feed path or URL), GNU_BUCKET (default aphrody-gnu)
`;

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const pad = (s: unknown, n: number) =>
  String(s ?? "")
    .padEnd(n)
    .slice(0, n);

async function main(): Promise<number> {
  switch (cmd) {
    case "status": {
      const s = status(await loadFeed());
      if (flag("json")) return (json(s), 0);
      const c = s.counts;
      console.log(
        `feed ${s.generated} (${s.age_minutes} min${s.stale ? ", STALE" : ""}) gsrc r${s.sources.gsrc_revno ?? "?"}`,
      );
      console.log(
        `${c.packages} packages, ${c.with_release} released, ${c.verified} verified, ${c.rust_any} rust (${c.rust_drop_in} drop-in), ${c.drift_gsrc} gsrc behind, ${c.proven} proven, ${c.mirrored} mirrored`,
      );
      if (s.kernel) console.log(`kernel: ${s.kernel.releases.join(", ")}`);
      for (const e of s.latest)
        console.log(
          `  ${pad(e.id, 18)} ${pad(e.version, 12)} ${e.date}  ${e.rust.join("; ")}`,
        );
      return 0;
    }
    case "search": {
      const r = search(await loadFeed(), {
        query: args
          .filter(
            (a, i) =>
              !a.startsWith("--") &&
              !["--filter", "--limit"].includes(args[i - 1] ?? ""),
          )
          .join(" "),
        filter: opt("filter") as never,
        limit: Number(opt("limit") ?? 25),
      });
      if (flag("json")) return (json(r), 0);
      console.log(`${r.total} match`);
      for (const e of r.results)
        console.log(
          `${pad(e.id, 18)} ${pad(e.version, 12)} ${pad(e.date, 10)} ${pad(e.signature, 10)} ${e.rust.join("; ") || "-"}`,
        );
      return 0;
    }
    case "package": {
      const e = pkg(await loadFeed(), args[0] ?? "");
      if (!e) return (console.error(`unknown package ${args[0] ?? ""}`), 1);
      return (json(e), 0);
    }
    case "feed": {
      const feed = await loadFeed();
      const o = { since: opt("since"), limit: Number(opt("limit") ?? 30) };
      if (flag("atom"))
        return (console.log(recent(feed, { ...o, format: "atom" })), 0);
      const r = recent(feed, o);
      if (flag("json")) return (json(r), 0);
      for (const e of (r as { entries: ReturnType<typeof brief>[] }).entries)
        console.log(
          `${pad(e.date, 10)} ${pad(e.id, 18)} ${pad(e.version, 12)} ${e.rust.join("; ") || "-"}`,
        );
      return 0;
    }
    case "diff": {
      const ev = await changes({
        since: opt("since") ?? "7d",
        limit: Number(opt("limit") ?? 50),
      });
      if (flag("json")) return (json(ev), 0);
      for (const e of ev)
        console.log(
          `${e.at.slice(0, 16)} ${pad(e.kind, 8)} ${pad(e.id, 18)} ${e.detail}`,
        );
      if (!ev.length) console.log("no change recorded");
      return 0;
    }
    case "kernel": {
      const k = kernel(await loadFeed());
      if (!k) return (console.error("no kernel data in the feed"), 1);
      if (flag("json")) return (json(k), 0);
      for (const r of k.releases)
        console.log(
          `${pad(r.moniker, 10)} ${pad(r.version, 12)} ${r.date.slice(0, 10)} ${pad(r.signature.status, 10)} rust=${r.rust_in_tree ?? "?"}${r.eol ? " EOL" : ""}${r.mirror ? " r2" : ""}`,
        );
      console.log(`GKI: ${k.gki.map((b) => b.name).join(" ")}`);
      console.log(
        `ChromeOS: ${k.chromeos
          .slice(0, 8)
          .map((b) => b.name)
          .join(" ")}`,
      );
      console.log(
        `Rust for Linux: in tree since ${k.rust.in_tree_since ?? "?"}; rust-next ${k.rust.rust_for_linux.head?.slice(0, 10) ?? "?"}`,
      );
      return 0;
    }
    case "sync": {
      const f = await sync({
        mirror: flag("mirror"),
        heads: !flag("no-heads"),
        rust: !flag("no-rust"),
        kernel: !flag("no-kernel"),
        site: !flag("no-site"),
        bucket: opt("bucket"),
        gsrcRoot: opt("gsrc") ?? Bun.env.GNU_GSRC,
        log: (s) => console.log(s),
      });
      console.log(`ok ${f.counts.packages} packages, generated ${f.generated}`);
      return 0;
    }
    case "daemon": {
      // Long-running poller (systemd aphrody-gnu.service): one cycle per GNU_INTERVAL seconds (default 600), mirror on.
      const every = Math.max(60, Number(Bun.env.GNU_INTERVAL ?? 600)) * 1000;
      for (;;) {
        const t = Date.now();
        try {
          const f = await sync({
            mirror: Bun.env.GNU_MIRROR !== "0",
            gsrcRoot: Bun.env.GNU_GSRC,
            log: (m) => console.log(m),
          });
          console.log(
            `cycle ok ${f.counts.packages} packages in ${Math.round((Date.now() - t) / 1000)}s`,
          );
        } catch (e) {
          console.error(`cycle failed: ${String(e).slice(0, 300)}`);
        }
        await Bun.sleep(Math.max(5000, every - (Date.now() - t)));
      }
    }
    case "site": {
      const p = paths();
      await buildSite(
        await loadFeed({ fresh: true }),
        opt("out") ?? p.site,
        await readEvents(p),
      );
      console.log(`site -> ${opt("out") ?? p.site}`);
      return 0;
    }
    case "verify": {
      const s = sqvPath();
      console.log(
        s
          ? `sqv: ${s}`
          : "sqv: not installed (signatures are recorded as unverified)",
      );
      return s ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0;
  }
}

process.exitCode = await main();
