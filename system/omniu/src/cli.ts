#!/usr/bin/env bun
// omniu: validate, package and scaffold the oh-my-niu bundle; list the plugins both hosts load.
import { join } from "node:path";
import { convertJjCompletions } from "./convert-jj.ts";
import { bundleRoot, discover } from "./host.ts";
import { addPack, removePack, validateAfterChange } from "./new-pack.ts";
import { build, check } from "./package.ts";
import { validateAll } from "./validate.ts";

const USAGE = `usage: omniu <command>
  validate                          check the bundle layout, manifests, assets and index
  package [--check] [--out-dir D]   deterministic zip and sha256 (--check: temporary directory)
  new-pack add <name> [--summary S] [--category C] [--required-binary B] [--with-completions]
  new-pack remove <name>
  plugins                           framework plugins and their Bun entries
  convert-jj [FILE]                 jj bash completions (FILE or stdin) to completions/jj.toml on stdout`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const root = bundleRoot();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "validate": {
      const errors = validateAll(root);
      if (errors.length) {
        for (const e of errors) console.error(`error: ${e}`);
        return 1;
      }
      const packs = discover(root).length;
      console.log(`bundle validation ok: ${packs} framework plugins`);
      return 0;
    }
    case "package": {
      if (rest.includes("--check")) {
        const r = check(root);
        console.log(`package check ok: ${r.zipPath.split(/[\\/]/).pop()} sha256=${r.sha256}`);
        return 0;
      }
      const r = build(root, flag(rest, "--out-dir") ?? join(root, "dist"), false);
      console.log(`wrote ${r.zipPath}\nwrote ${r.checksumPath}\nsha256=${r.sha256}`);
      return 0;
    }
    case "new-pack": {
      const [action, name] = rest;
      if (!name || (action !== "add" && action !== "remove")) throw new Error(USAGE);
      const log =
        action === "add"
          ? addPack(root, name, {
              summary: flag(rest, "--summary"),
              category: flag(rest, "--category"),
              requiredBinary: flag(rest, "--required-binary"),
              withCompletions: rest.includes("--with-completions"),
            })
          : removePack(root, name);
      console.log(log.join("\n"));
      validateAfterChange(root);
      console.log(`bundle validation ok`);
      return 0;
    }
    case "plugins": {
      for (const p of discover(root)) console.log(`${p.name}\t${p.version}\t${p.bun ? `bun:${p.bun.module}` : "-"}`);
      return 0;
    }
    case "convert-jj": {
      const text = rest[0] ? await Bun.file(rest[0]).text() : await Bun.stdin.text();
      console.log(convertJjCompletions(text));
      return 0;
    }
    default:
      console.error(USAGE);
      return cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
