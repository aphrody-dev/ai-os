#!/usr/bin/env bun
// brain: merge AGY sessions into a redacted Obsidian vault, build the code graph (graphify), sync to Google Drive.
// The Google OAuth consent for the agent account is done by a human (see `brain auth-drive`); nothing here handles passwords.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const VAULT = process.env.BRAIN_VAULT ?? "C:/aphrody/var/brain";
const REMOTE = process.env.BRAIN_RCLONE_REMOTE ?? "gdrive-yoyo";
const REMOTE_DIR = process.env.BRAIN_REMOTE_DIR ?? "aphrody-brain";
const HOME = process.env.USERPROFILE ?? "";
const run = (cmd: string, args: string[], cwd?: string) =>
  spawnSync(cmd, args, {
    stdio: "inherit",
    cwd,
    env: { ...process.env, PATH: `${HOME}\\.local\\bin;${process.env.PATH}` },
  });

function envSecrets(): string[] {
  const out: string[] = [];
  if (!existsSync("C:/aphrody/.env")) return out;
  for (const l of readFileSync("C:/aphrody/.env", "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    const v = m?.[2]?.replace(/^['"]|['"]$/g, "") ?? "";
    if (
      v.length >= 12 &&
      !/^[A-Za-z]:[\\/]/.test(v) &&
      !/^https?:\/\/[^@]*$/.test(v)
    )
      out.push(v);
  }
  return out;
}
const PATTERNS = [
  /figd_[A-Za-z0-9_-]{20,}/,
  /(ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /sk-[A-Za-z0-9_-]{30,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /ya29\.[A-Za-z0-9._-]{20,}/,
  /1\/\/[A-Za-z0-9._-]{20,}/,
  /ctx7sk-[A-Za-z0-9_-]{16,}/,
  /npm_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function leakScan(dir: string): string[] {
  const secrets = envSecrets();
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git") walk(p);
        continue;
      }
      if (statSync(p).size > 8_000_000) continue;
      const buf = readFileSync(p);
      if (buf.includes(0)) continue;
      const t = buf.toString();
      if (
        secrets.some((s) => t.includes(s)) ||
        PATTERNS.some((re) => re.test(t))
      )
        hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

function main() {
  const cmd = process.argv[2] ?? "status";
  switch (cmd) {
    case "merge":
      process.exit(
        run("bun", ["run", join(import.meta.dir, "merge-sessions.ts")])
          .status ?? 1,
      );
    case "graph": {
      for (const d of ["packages", "crates", "apps", "infra"])
        run("graphify", ["update", `C:/aphrody/${d}`]);
      const graphs = ["packages", "crates", "apps", "infra"]
        .map((d) => `C:/aphrody/${d}/graphify-out/graph.json`)
        .filter(existsSync);
      if (graphs.length > 1)
        run("graphify", [
          "merge-graphs",
          ...graphs,
          "--out",
          `${VAULT}/graphify-out/merged-graph.json`,
        ]);
      const g = existsSync(`${VAULT}/graphify-out/merged-graph.json`)
        ? `${VAULT}/graphify-out/merged-graph.json`
        : graphs[0];
      if (g)
        run("graphify", [
          "export",
          "obsidian",
          "--graph",
          g,
          "--dir",
          `${VAULT}/Code Graph`,
        ]);
      break;
    }
    case "auth-drive":
      console.log(
        `Run this once, signed in as the agent account in the browser that opens:\n  rclone config create ${REMOTE} drive scope=drive.file\nUse your own OAuth client (client_id/client_secret from the GCP project) to avoid shared rate limits.`,
      );
      break;
    case "sync": {
      const hits = leakScan(VAULT);
      if (hits.length) {
        console.error(
          `Refusing to sync: secret-like content in ${hits.length} file(s):\n${hits.slice(0, 10).join("\n")}`,
        );
        process.exit(2);
      }
      const remotes =
        spawnSync("rclone", ["listremotes"], { encoding: "utf8" }).stdout ?? "";
      if (!remotes.includes(`${REMOTE}:`)) {
        console.error(
          `rclone remote '${REMOTE}:' is not configured. Run: brain auth-drive`,
        );
        process.exit(3);
      }
      process.exit(
        run("rclone", [
          "copy",
          VAULT,
          `${REMOTE}:${REMOTE_DIR}`,
          "--exclude",
          ".obsidian/workspace*.json",
          "--exclude",
          "graphify-out/cache/**",
          "--progress",
        ]).status ?? 1,
      );
    }
    case "leak-scan": {
      const hits = leakScan(VAULT);
      console.log(
        hits.length ? `LEAKS in:\n${hits.join("\n")}` : "vault clean",
      );
      process.exit(hits.length ? 2 : 0);
    }
    default: {
      const remotes =
        spawnSync("rclone", ["listremotes"], { encoding: "utf8" }).stdout ?? "";
      console.log(
        JSON.stringify(
          {
            vault: VAULT,
            notes: existsSync(`${VAULT}/Sessions`)
              ? readdirSync(`${VAULT}/Sessions`).length
              : 0,
            graph: existsSync(`${VAULT}/graphify-out`),
            driveRemoteConfigured: remotes.includes(`${REMOTE}:`),
          },
          null,
          2,
        ),
      );
    }
  }
}

if (import.meta.main) main();
