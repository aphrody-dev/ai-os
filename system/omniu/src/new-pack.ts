// Scaffold (or remove) an oh-my-niu pack with every registration wired (port of tools/new_pack.py).
//
// A pack lives in four places plus one optional asset; forgetting any of them fails the validator:
//   packs/<name>/plugin.toml, packs/<name>/init.niu, plugins/<name>/plugin.toml, plugins/<name>/<name>.plugin.niu,
//   completions/<name>.toml (optional)
// Registrations: index.toml ([[packs]] at the end), bundle.toml ("available" list), framework-plugins.toml ("plugins" list).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { validateAll } from "./validate.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface AddOptions {
  summary?: string;
  category?: string;
  requiredBinary?: string;
  withCompletions?: boolean;
}

interface Fields {
  name: string;
  /** Shell identifier derived from the name (`modern-cli` -> `modern_cli`). */
  fn: string;
  /** TOML basic strings, already quoted and escaped. */
  summary: string;
  category: string;
  required: string;
  completions: string;
  processPerm: string;
  /** The summary as one comment line. */
  summaryText: string;
}

const KNOWN_CATEGORIES = ["devtools", "environment", "workflow", "hints", "ux"];
/** A TOML basic string: JSON string syntax is a subset of it. */
const q = (s: string) => JSON.stringify(s);

const packManifest = (f: Fields) => `name = "${f.name}"
bundle = "oh-my-niu"
version = "1.0.0"
kind = "source"
api = "niubash:plugin@0.1.0"
category = ${f.category}
summary = ${f.summary}
default = false
permissions = ["shell:source", "cwd:read"${f.processPerm}]
required_binaries = [${f.required}]

[exports]
aliases = false
completions = [${f.completions}]
prompt_segments = []
hooks = []
commands = []
keybindings = []
themes = []

[source]
entry = "packs/${f.name}/init.niu"
`;

const packInit = (f: Fields) => `# oh-my-niu ${f.name} plugin
# Scaffolded by omniu new-pack; replace the placeholder with real
# behavior. Aliases and completions live in bundle assets.

${f.fn}_hello() {
  echo "${f.name} pack is wired"
}
`;

const pluginManifest = (f: Fields) => `name = "${f.name}"
version = "1.0.0"
kind = "source"
entry = "${f.name}.plugin.niu"
summary = ${f.summary}
permissions = ["shell:source", "cwd:read"${f.processPerm}]
required_binaries = [${f.required}]

[exports]
aliases = false
functions = ["${f.fn}_hello"]
completions = [${f.completions}]
`;

const pluginBody = (f: Fields) => `# Oh My Niu ${f.name} plugin.

# Scaffolded by omniu new-pack; the framework loader sources this file
# when the pack is enabled. Keep it aligned with packs/${f.name}/init.niu.
${f.fn}_hello() {
  echo "${f.name} pack is wired"
}
`;

const completionsStub = (f: Fields) => `# ${f.name} completions for niubash / oh-my-niu.
command = "${f.name}"
description = ${f.summary}

[[flags]]
short = "-h"
long = "--help"
description = "show help"
`;

function write(root: string, path: string, content: string, log: string[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  log.push(`  wrote ${relative(root, path).replaceAll("\\", "/")}`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Append `"name",` before the closing `]` of the first `key = [` list of a TOML file. */
function appendToList(path: string, key: string, name: string) {
  const text = readFileSync(path, "utf8");
  const m = new RegExp(`${escapeRe(key)} = \\[\\n([\\s\\S]*?)^\\]`, "m").exec(text);
  if (!m) throw new Error(`anchor drifted in ${path}: ${key} list not found`);
  const at = m.index + m[0].length - 1;
  writeFileSync(path, `${text.slice(0, at)}  "${name}",\n${text.slice(at)}`);
}

function removeFromList(path: string, name: string) {
  const text = readFileSync(path, "utf8");
  const re = new RegExp(`^  "${escapeRe(name)}",\\n`, "gm");
  const found = text.match(re)?.length ?? 0;
  if (found !== 1) throw new Error(`expected exactly one registration line in ${path}, found ${found}`);
  writeFileSync(path, text.replace(re, ""));
}

/** Scaffold pack `name` under `root`; returns the log lines. Throws on a bad name, an existing pack or a drifted anchor. */
export function addPack(root: string, name: string, opts: AddOptions = {}): string[] {
  if (!NAME_RE.test(name)) throw new Error(`invalid pack name '${name}': lowercase letters, digits, dashes`);
  if (existsSync(join(root, "packs", name)) || existsSync(join(root, "plugins", name))) throw new Error(`pack '${name}' already exists`);
  const summary = opts.summary ?? "TODO: one-line summary";
  if (/[\r\n]/.test(summary)) throw new Error("summary must be a single line");
  const category = opts.category ?? "devtools";
  if (!KNOWN_CATEGORIES.includes(category)) throw new Error(`unknown category '${category}': ${KNOWN_CATEGORIES.join(", ")}`);
  if (opts.requiredBinary !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(opts.requiredBinary)) throw new Error(`invalid required binary '${opts.requiredBinary}'`);
  const f: Fields = {
    name,
    fn: name.replaceAll("-", "_"),
    summary: q(summary),
    summaryText: summary,
    category: q(category),
    required: opts.requiredBinary ? q(opts.requiredBinary) : "",
    completions: opts.withCompletions ? q(name) : "",
    processPerm: opts.requiredBinary ? `, ${q(`process:run:${opts.requiredBinary}`)}` : "",
  };
  const log = [`scaffolding pack '${name}':`];
  write(root, join(root, "packs", name, "plugin.toml"), packManifest(f), log);
  write(root, join(root, "packs", name, "init.niu"), packInit(f), log);
  write(root, join(root, "plugins", name, "plugin.toml"), pluginManifest(f), log);
  write(root, join(root, "plugins", name, `${name}.plugin.niu`), pluginBody(f), log);
  if (opts.withCompletions) write(root, join(root, "completions", `${name}.toml`), completionsStub(f), log);

  const index = join(root, "index.toml");
  let text = readFileSync(index, "utf8");
  if (!text.includes('[[packs]]\nname = "git"')) throw new Error(`anchor drifted in ${index}: '[[packs]] name = "git"' not found`);
  if (!text.endsWith("\n")) text += "\n";
  writeFileSync(index, `${text}\n[[packs]]\nname = "${name}"\nversion = "1.0.0"\napi = "niubash:plugin@0.1.0"\nkind = "source"\ncategory = ${f.category}\nsummary = ${f.summary}\ndefault = false\npermissions = ["shell:source", "cwd:read"${f.processPerm}]\nrequired_binaries = [${f.required}]\n`);
  log.push("  registered index.toml");
  appendToList(join(root, "bundle.toml"), "available", name);
  log.push("  registered bundle.toml");
  appendToList(join(root, "framework-plugins.toml"), "plugins", name);
  log.push("  registered framework-plugins.toml");
  return log;
}

/** Remove pack `name` and its registrations. */
export function removePack(root: string, name: string): string[] {
  const log: string[] = [];
  for (const sub of ["packs", "plugins"]) {
    const d = join(root, sub, name);
    if (existsSync(d)) {
      rmSync(d, { recursive: true });
      log.push(`  removed ${sub}/${name}/`);
    }
  }
  const comp = join(root, "completions", `${name}.toml`);
  if (existsSync(comp)) {
    rmSync(comp);
    log.push(`  removed completions/${name}.toml`);
  }
  if (log.length === 0) throw new Error(`pack '${name}' not found`);
  removeFromList(join(root, "bundle.toml"), name);
  removeFromList(join(root, "framework-plugins.toml"), name);
  log.push("  unregistered bundle.toml, framework-plugins.toml");

  const index = join(root, "index.toml");
  const parts = readFileSync(index, "utf8").split(/^\[\[packs\]\]\n/m);
  const header = parts[0]!;
  const blocks = parts.slice(1);
  const kept = blocks.filter((b) => !b.startsWith(`name = "${name}"\n`));
  if (blocks.length - kept.length !== 1) throw new Error(`expected exactly one [[packs]] block for '${name}' in index.toml, found ${blocks.length - kept.length}`);
  writeFileSync(index, `${header}${kept.map((b) => `[[packs]]\n${b}`).join("")}`.replace(/\n+$/, "\n"));
  log.push("  unregistered index.toml");
  return log;
}

/** Validate after a change; throws with the errors when the bundle is not valid. */
export function validateAfterChange(root: string) {
  const errors = validateAll(root);
  if (errors.length) throw new Error(`bundle validation failed after the change:\n${errors.map((e) => `error: ${e}`).join("\n")}`);
}
