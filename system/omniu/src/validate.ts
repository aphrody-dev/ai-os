// Validator of the oh-my-niu bundle layout (port of tools/validate_bundle.py, same rules and messages).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

type Table = Record<string, unknown>;
type Errors = string[];

export const KNOWN_KINDS = new Set(["builtin", "source", "wasm", "process"]);
export const FRAMEWORK_PLUGIN_KINDS = new Set(["source", "bridge"]);
export const KNOWN_CATEGORIES = new Set(["devtools", "environment", "workflow", "hints", "ux"]);
export const BUNDLE_API_VERSION = "niubash:plugin-bundle@0.1.0";
export const INDEX_SCHEMA = "niubash:plugin-index@0.1.0";
const EXPORT_KEYS = new Set(["aliases", "completions", "prompt_segments", "hooks", "commands", "keybindings", "themes", "providers"]);
const REQUIRED_EXPORT_KEYS = [...EXPORT_KEYS].filter((k) => k !== "keybindings" && k !== "providers");
const KNOWN_PROVIDER_EXPORTS = new Set(["command-not-found"]);
const SOURCE_PLUGIN_HOOKS = new Set(["startup", "precmd", "preexec", "postcmd", "chpwd", "period", "zshaddhistory", "zshexit", "greeting", "title"]);
const PROCESS_PLUGIN_PROTOCOL = "niubash:process-plugin@0.1.0";
const PROCESS_PLUGIN_MAX_TIMEOUT_MILLIS = 30_000;
const WASM_PLUGIN_PROTOCOL = "niubash:wasm-plugin@0.1.0";
const WASM_PLUGIN_MAX_TIMEOUT_MILLIS = 30_000;
const WASM_PLUGIN_MAX_MEMORY_PAGES = 4096;
const AUTHORING_TEMPLATE_KINDS = ["builtin", "source", "process", "wasm"];
const THEME_STYLE_KEYS = new Set(["prompt_user", "prompt_host", "prompt_dir", "prompt_symbol", "error", "warning", "success", "git_clean", "git_dirty", "git_status_detail"]);
const THEME_COLOR_NAMES = new Set([
  "black", "darkgray", "darkgrey", "red", "lightred", "green", "lightgreen", "yellow", "lightyellow", "blue", "lightblue",
  "purple", "lightpurple", "magenta", "lightmagenta", "cyan", "lightcyan", "white", "lightgray", "lightgrey",
]);
const RELEASE_DOCUMENTS: Record<string, string[]> = {
  "CHANGELOG.md": ["# Changelog", "oh-my-niu-{version}.zip", 'api = "niubash:plugin-bundle@0.1.0"', 'min_niubash = "{min_niubash}"'],
  "docs/compatibility.md": [
    "# Compatibility", "niubash:plugin-bundle@0.1.0", "niubash:plugin@0.1.0", PROCESS_PLUGIN_PROTOCOL, WASM_PLUGIN_PROTOCOL,
    'min_niubash = "{min_niubash}"', "Patch releases", "Minor releases", "Major releases",
  ],
};
const FRAMEWORK_FILES = ["oh-my-niu.niu", "lib/hooks.niu", "lib/aliases.niu", "lib/prompt.niu", "lib/git.niu", "plugins/README.md", "tools/smoke_framework.niu"];

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const isList = (v: unknown): v is unknown[] => Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => isStr(v) && v.trim() !== "";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const validToken = (v: unknown): v is string => nonEmpty(v) && !v.includes("\n") && !v.includes("\r");
const relativeInside = (p: string) => !isAbsolute(p) && !p.split(/[\\/]/).includes("..");
const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

export function loadToml(path: string): Table {
  return Bun.TOML.parse(readFileSync(path, "utf8")) as Table;
}

function safeLoadToml(path: string, context: string, errors: Errors): Table | null {
  try {
    return loadToml(path);
  } catch (e) {
    errors.push(`${context}: invalid TOML or unreadable file ${path}: ${(e as Error).message}`);
    return null;
  }
}

function expect(cond: boolean, message: string, errors: Errors) {
  if (!cond) errors.push(message);
}

function validateCompletionFlags(owner: string, flags: unknown, errors: Errors) {
  expect(isList(flags), `${owner}: flags must be list`, errors);
  if (!isList(flags)) return;
  flags.forEach((flag, index) => {
    const o = `${owner}: flags[${index}]`;
    expect(isTable(flag), `${o} must be table`, errors);
    if (!isTable(flag)) return;
    const { short, long } = flag;
    if (short !== undefined) expect(nonEmpty(short), `${o}.short must be non-empty string`, errors);
    if (long !== undefined) expect(nonEmpty(long), `${o}.long must be non-empty string`, errors);
    expect(short !== undefined || long !== undefined, `${o} must define short or long`, errors);
    if ("description" in flag) expect(isStr(flag.description), `${o}.description must be string`, errors);
    if ("takes_value" in flag) expect(typeof flag.takes_value === "boolean", `${o}.takes_value must be bool`, errors);
    if ("values" in flag) {
      expect(isList(flag.values), `${o}.values must be list`, errors);
      if (isList(flag.values)) for (const v of flag.values) expect(nonEmpty(v), `${o}.values entries must be non-empty strings`, errors);
    }
    if ("values_from" in flag) expect(flag.values_from === "path", `${o}.values_from must be "path"`, errors);
  });
}

function validateCompletionAsset(pack: string, name: string, dir: string, errors: Errors) {
  const path = join(dir, `${name}.toml`);
  expect(existsSync(path), `${pack}: missing completion asset ${path}`, errors);
  if (!existsSync(path)) return;
  const asset = safeLoadToml(path, `${pack}: completion ${name}`, errors);
  if (!asset) return;
  expect(asset.command === name, `${pack}: completion asset ${path} must declare command = '${name}'`, errors);
  if ("description" in asset) expect(isStr(asset.description), `${pack}: completion ${name}.description must be string`, errors);
  if ("flags" in asset) validateCompletionFlags(`${pack}: completion ${name}`, asset.flags, errors);
  if ("subcommands" in asset) {
    const subs = asset.subcommands;
    expect(isList(subs), `${pack}: completion ${name}.subcommands must be list`, errors);
    if (isList(subs)) {
      subs.forEach((sub, index) => {
        const o = `${pack}: completion ${name}: subcommands[${index}]`;
        expect(isTable(sub), `${o} must be table`, errors);
        if (!isTable(sub)) return;
        expect(nonEmpty(sub.name), `${o}.name must be non-empty string`, errors);
        if ("description" in sub) expect(isStr(sub.description), `${o}.description must be string`, errors);
        if ("flags" in sub) validateCompletionFlags(o, sub.flags, errors);
      });
    }
  }
}

function validatePromptAssets(pack: string, exported: unknown[], dir: string, errors: Errors) {
  const path = join(dir, "segments.toml");
  expect(existsSync(path), `${pack}: missing prompt asset ${path}`, errors);
  if (!existsSync(path)) return;
  const asset = safeLoadToml(path, `${pack}: prompt segments`, errors);
  if (!asset) return;
  const segments = asset.segments;
  expect(isTable(segments), `${pack}: prompt asset must contain [segments] tables`, errors);
  if (isTable(segments)) {
    for (const name of exported) {
      expect(nonEmpty(name), `${pack}: exports.prompt_segments entries must be non-empty strings`, errors);
      if (nonEmpty(name)) expect(name in segments, `${pack}: missing prompt segment asset '${name}'`, errors);
    }
    for (const [name, segment] of Object.entries(segments)) {
      const o = `${pack}: prompt segment ${name}`;
      expect(isTable(segment), `${o} must be table`, errors);
      if (!isTable(segment)) continue;
      expect(nonEmpty(segment.id), `${o}.id must be non-empty string`, errors);
      if ("description" in segment) expect(isStr(segment.description), `${o}.description must be string`, errors);
    }
  }
  const presets = asset.presets;
  expect(isTable(presets) && Object.keys(presets).length > 0, `${pack}: prompt asset must contain non-empty [presets] tables`, errors);
  if (!isTable(presets)) return;
  for (const [name, preset] of Object.entries(presets)) {
    const o = `${pack}: prompt preset ${name}`;
    expect(isTable(preset), `${o} must be table`, errors);
    if (!isTable(preset)) continue;
    for (const key of ["left", "right"]) {
      const values = preset[key];
      expect(isList(values), `${o}.${key} must be list`, errors);
      if (!isList(values)) continue;
      for (const v of values) {
        expect(nonEmpty(v), `${o}.${key} entries must be non-empty strings`, errors);
        if (isStr(v) && isTable(segments)) expect(v in segments, `${o}.${key} references unknown segment '${v}'`, errors);
      }
    }
    if ("separator" in preset) expect(isStr(preset.separator), `${o}.separator must be string`, errors);
    if ("git_prompt_format" in preset) expect(isStr(preset.git_prompt_format), `${o}.git_prompt_format must be string`, errors);
  }
}

function validateKeybindingAsset(pack: string, name: string, dir: string, errors: Errors) {
  const path = join(dir, `${name}.toml`);
  expect(existsSync(path), `${pack}: missing keybinding asset ${path}`, errors);
  if (!existsSync(path)) return;
  const asset = safeLoadToml(path, `${pack}: keybinding ${name}`, errors);
  if (!asset) return;
  expect(asset.name === name, `${pack}: keybinding asset ${path} must declare name = '${name}'`, errors);
  if ("summary" in asset) expect(isStr(asset.summary), `${pack}: keybinding ${name}.summary must be string`, errors);
  if ("keymap" in asset) expect(isStr(asset.keymap), `${pack}: keybinding ${name}.keymap must be string`, errors);
  const bindings = asset.bindings;
  expect(isList(bindings) && bindings.length > 0, `${pack}: keybinding ${name}.bindings must be non-empty list`, errors);
  if (!isList(bindings)) return;
  bindings.forEach((b, index) => {
    const o = `${pack}: keybinding ${name}.bindings[${index}]`;
    expect(isTable(b), `${o} must be table`, errors);
    if (!isTable(b)) return;
    expect(nonEmpty(b.key), `${o}.key must be non-empty string`, errors);
    expect(nonEmpty(b.action), `${o}.action must be non-empty string`, errors);
    if ("description" in b) expect(isStr(b.description), `${o}.description must be string`, errors);
  });
}

const normalizeThemeColor = (v: string) => v.replace(/[_\-\s]/g, "").toLowerCase();

export function isThemeColor(value: string): boolean {
  const n = normalizeThemeColor(value);
  if (THEME_COLOR_NAMES.has(n)) return true;
  if (/^\d+$/.test(n)) return Number(n) >= 0 && Number(n) <= 255;
  const hex = n.startsWith("#") ? n.slice(1) : n;
  return hex.length === 6 && /^[0-9a-f]+$/.test(hex);
}

function validateThemeAsset(pack: string, name: string, dir: string, errors: Errors) {
  const path = join(dir, `${name}.toml`);
  expect(existsSync(path), `${pack}: missing theme asset ${path}`, errors);
  if (!existsSync(path)) return;
  const asset = safeLoadToml(path, `${pack}: theme ${name}`, errors);
  if (!asset) return;
  expect(Object.keys(asset).length > 0, `${pack}: theme asset ${path} must define at least one style table`, errors);
  for (const [styleName, style] of Object.entries(asset)) {
    const o = `${pack}: theme ${name}.${styleName}`;
    expect(THEME_STYLE_KEYS.has(styleName), `${o} is not a supported theme style`, errors);
    expect(isTable(style), `${o} must be table`, errors);
    if (!isTable(style)) continue;
    for (const key of Object.keys(style)) expect(["fg", "bg", "bold", "italic", "underline", "dimmed"].includes(key), `${o}.${key} is not supported`, errors);
    for (const ck of ["fg", "bg"]) {
      if (!(ck in style)) continue;
      const color = style[ck];
      expect(nonEmpty(color), `${o}.${ck} must be non-empty string`, errors);
      if (nonEmpty(color)) expect(isThemeColor(color), `${o}.${ck} uses unknown color '${color}'`, errors);
    }
    for (const bk of ["bold", "italic", "underline", "dimmed"]) if (bk in style) expect(typeof style[bk] === "boolean", `${o}.${bk} must be bool`, errors);
  }
}

function validateSemver(owner: string, value: unknown, errors: Errors) {
  expect(nonEmpty(value), `${owner} must be non-empty string`, errors);
  if (!isStr(value)) return;
  const core = value.split("-", 1)[0]!.split("+", 1)[0]!;
  const parts = core.split(".");
  expect(parts.length === 3 && parts.every((p) => /^\d+$/.test(p)), `${owner} must be semver major.minor.patch`, errors);
}

function validateProviderExports(pack: string, manifest: Table, exports: Table, errors: Errors) {
  if (!("providers" in exports)) return;
  const providers = exports.providers;
  expect(isList(providers), `${pack}: exports.providers must be list`, errors);
  if (!isList(providers)) return;
  const seen = new Set<string>();
  providers.forEach((p, index) => {
    expect(validToken(p), `${pack}: exports.providers[${index}] must be a non-empty single-line string`, errors);
    if (!validToken(p)) return;
    if (seen.has(p)) errors.push(`${pack}: exports.providers repeats '${p}'`);
    seen.add(p);
    expect(KNOWN_PROVIDER_EXPORTS.has(p), `${pack}: exports.providers contains unknown provider '${p}'`, errors);
  });
  if (providers.length === 0) return;
  const kind = manifest.kind;
  expect(kind !== "wasm", `${pack}: wasm packs must not export providers until a WASM provider ABI is implemented`, errors);
  if (providers.includes("command-not-found")) {
    if (kind === "builtin") expect(pack === "command-not-found", `${pack}: provider 'command-not-found' is reserved for the command-not-found pack`, errors);
    else expect(kind === "process", `${pack}: provider 'command-not-found' requires kind = 'builtin' or kind = 'process'`, errors);
    if (isList(manifest.permissions)) expect(manifest.permissions.includes("command:diagnose"), `${pack}: provider 'command-not-found' requires command:diagnose`, errors);
  }
}

function validateWasmArtifact(root: string, pack: string, module: string, expectedSha: string, errors: Errors) {
  const path = join(root, module);
  expect(existsSync(path), `${pack}: missing wasm module ${path}`, errors);
  if (!existsSync(path)) return;
  const data = readFileSync(path);
  const digest = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  expect(digest === expectedSha.toLowerCase(), `${pack}: wasm module checksum mismatch for ${module}: expected ${expectedSha}, found ${digest}`, errors);
  expect(data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])), `${pack}: wasm module ${module} must be a valid WASM binary`, errors);
}

const inRange = (v: unknown, max: number) => isInt(v) && v > 0 && v <= max;

function validateProcessManifest(pack: string, manifest: Table, exports: Table, errors: Errors) {
  const kind = manifest.kind;
  const proc = manifest.process;
  if (kind !== "process") {
    expect(proc === undefined, `${pack}: [process] is only valid for kind = "process"`, errors);
    return;
  }
  expect(manifest.default === false, `${pack}: process packs must be explicit opt-in with default = false`, errors);
  expect(isTable(proc), `${pack}: process pack must include [process]`, errors);
  if (!isTable(proc)) return;
  expect(proc.protocol === PROCESS_PLUGIN_PROTOCOL, `${pack}: process.protocol must be '${PROCESS_PLUGIN_PROTOCOL}'`, errors);
  const command = proc.command;
  expect(validToken(command), `${pack}: process.command must be a non-empty single-line string`, errors);
  const args = proc.args ?? [];
  expect(isList(args), `${pack}: process.args must be list`, errors);
  if (isList(args)) args.forEach((a, i) => expect(validToken(a), `${pack}: process.args[${i}] must be a non-empty single-line string`, errors));
  expect(inRange(proc.timeout_millis, PROCESS_PLUGIN_MAX_TIMEOUT_MILLIS), `${pack}: process.timeout_millis must be between 1 and ${PROCESS_PLUGIN_MAX_TIMEOUT_MILLIS}`, errors);
  const truthy = (v: unknown) => (isList(v) ? v.length > 0 : Boolean(v));
  expect(truthy(exports.commands) || truthy(exports.hooks), `${pack}: process packs must export at least one command or hook`, errors);
  if (validToken(command) && isList(manifest.permissions)) expect(manifest.permissions.includes(`process:run:${command}`), `${pack}: permissions must include process:run:${command}`, errors);
  const rb = manifest.required_binaries;
  expect(isList(rb), `${pack}: process packs must declare required_binaries`, errors);
  if (validToken(command) && isList(rb)) expect(rb.includes(command), `${pack}: required_binaries must include '${command}'`, errors);
}

function validateSourceManifest(root: string, pack: string, manifest: Table, errors: Errors) {
  const kind = manifest.kind;
  const source = manifest.source;
  if (kind !== "source") {
    expect(source === undefined, `${pack}: [source] is only valid for kind = "source"`, errors);
    return;
  }
  expect(isTable(source), `${pack}: source pack must include [source]`, errors);
  if (!isTable(source)) return;
  const entry = source.entry;
  expect(validToken(entry), `${pack}: source.entry must be a non-empty single-line string`, errors);
  if (validToken(entry)) {
    expect(entry.endsWith(".niu"), `${pack}: source.entry must point to a .niu script`, errors);
    expect(relativeInside(entry), `${pack}: source.entry must be relative inside the bundle`, errors);
    expect(isFile(join(root, entry)), `${pack}: missing source entry ${join(root, entry)}`, errors);
  }
  if (isList(manifest.permissions)) expect(manifest.permissions.includes("shell:source"), `${pack}: source packs must declare shell:source`, errors);
  const exports = manifest.exports;
  if (isTable(exports)) {
    const hooks = exports.hooks ?? [];
    if (isList(hooks)) {
      hooks.forEach((h, i) => {
        expect(validToken(h), `${pack}: exports.hooks[${i}] must be a non-empty single-line string`, errors);
        if (validToken(h)) expect(SOURCE_PLUGIN_HOOKS.has(h), `${pack}: source hook '${h}' is not supported`, errors);
      });
    }
  }
}

function validateWasmManifest(root: string, pack: string, manifest: Table, exports: Table, errors: Errors) {
  const kind = manifest.kind;
  const wasm = manifest.wasm;
  if (kind !== "wasm") {
    expect(wasm === undefined, `${pack}: [wasm] is only valid for kind = "wasm"`, errors);
    return;
  }
  expect(manifest.default === false, `${pack}: wasm packs must be explicit opt-in with default = false`, errors);
  expect(isTable(wasm), `${pack}: wasm pack must include [wasm]`, errors);
  if (!isTable(wasm)) return;
  expect(wasm.protocol === WASM_PLUGIN_PROTOCOL, `${pack}: wasm.protocol must be '${WASM_PLUGIN_PROTOCOL}'`, errors);
  const module = wasm.module;
  expect(validToken(module), `${pack}: wasm.module must be a non-empty single-line string`, errors);
  const sha = wasm.sha256;
  expect(validToken(sha), `${pack}: wasm.sha256 must be a non-empty single-line string`, errors);
  if (validToken(module)) {
    expect(module.endsWith(".wasm"), `${pack}: wasm.module must point to a .wasm artifact`, errors);
    expect(relativeInside(module), `${pack}: wasm.module must be relative inside the bundle`, errors);
    if (validToken(sha)) validateWasmArtifact(root, pack, module, sha, errors);
  }
  if (wasm.wit_world !== undefined) expect(validToken(wasm.wit_world), `${pack}: wasm.wit_world must be a non-empty single-line string`, errors);
  expect(inRange(wasm.timeout_millis, WASM_PLUGIN_MAX_TIMEOUT_MILLIS), `${pack}: wasm.timeout_millis must be between 1 and ${WASM_PLUGIN_MAX_TIMEOUT_MILLIS}`, errors);
  expect(inRange(wasm.max_memory_pages, WASM_PLUGIN_MAX_MEMORY_PAGES), `${pack}: wasm.max_memory_pages must be between 1 and ${WASM_PLUGIN_MAX_MEMORY_PAGES}`, errors);
  const rb = manifest.required_binaries;
  expect(isList(rb) && rb.length === 0, `${pack}: wasm packs must not declare native required_binaries`, errors);
  if (isList(manifest.permissions)) expect(!manifest.permissions.some((p) => isStr(p) && p.startsWith("process:run:")), `${pack}: wasm packs must not request native process permissions`, errors);
  const truthy = (v: unknown) => (isList(v) ? v.length > 0 : Boolean(v));
  expect(!truthy(exports.aliases) && !truthy(exports.hooks) && !truthy(exports.keybindings) && !truthy(exports.themes), `${pack}: wasm packs may only export commands, completions, or prompt_segments in phase 8`, errors);
  expect(truthy(exports.commands) || truthy(exports.completions) || truthy(exports.prompt_segments), `${pack}: wasm packs must export at least one command, completion, or prompt_segment`, errors);
}

function exportList(plugin: string, exports: Table, key: string, errors: Errors): string[] {
  const values = exports[key] ?? [];
  expect(isList(values), `framework plugin ${plugin}: exports.${key} must be list`, errors);
  if (!isList(values)) return [];
  values.forEach((v, i) => expect(validToken(v), `framework plugin ${plugin}: exports.${key}[${i}] must be a non-empty single-line string`, errors));
  return values.filter(validToken).map(String);
}

type AssetDirs = Record<"aliases" | "completions" | "prompts" | "keybindings" | "themes", string>;

function validateFrameworkPlugin(name: string, dir: string, assets: AssetDirs, errors: Errors) {
  const manifestPath = join(dir, "plugin.toml");
  expect(existsSync(manifestPath), `framework plugin ${name}: missing plugin.toml`, errors);
  if (!existsSync(manifestPath)) return;
  const manifest = safeLoadToml(manifestPath, `framework plugin ${name}`, errors);
  if (!manifest) return;
  expect(manifest.name === name, `framework plugin ${name}: name mismatch`, errors);
  validateSemver(`framework plugin ${name}: version`, manifest.version, errors);
  const kind = manifest.kind;
  expect(isStr(kind) && FRAMEWORK_PLUGIN_KINDS.has(kind), `framework plugin ${name}: kind must be one of ${JSON.stringify([...FRAMEWORK_PLUGIN_KINDS].sort())}`, errors);
  const entry = manifest.entry;
  expect(validToken(entry), `framework plugin ${name}: entry must be a non-empty single-line string`, errors);
  if (validToken(entry)) {
    expect(entry.endsWith(".niu"), `framework plugin ${name}: entry must point to a .niu script`, errors);
    expect(relativeInside(entry), `framework plugin ${name}: entry must be relative inside the plugin directory`, errors);
    expect(entry === `${name}.plugin.niu`, `framework plugin ${name}: entry must follow <name>.plugin.niu`, errors);
    expect(isFile(join(dir, entry)), `framework plugin ${name}: missing entry ${join(dir, entry)}`, errors);
  }
  expect(nonEmpty(manifest.summary), `framework plugin ${name}: summary must be non-empty string`, errors);
  const permissions = manifest.permissions;
  expect(isList(permissions), `framework plugin ${name}: permissions must be list`, errors);
  if (kind === "source" && isList(permissions)) expect(permissions.includes("shell:source"), `framework plugin ${name}: source plugins must declare shell:source`, errors);
  expect(isList(manifest.required_binaries), `framework plugin ${name}: required_binaries must be list`, errors);
  // The Bun host entry of the same plugin (`[bun]`, read by @aphrody/omniu): optional, relative, a TypeScript module.
  if (manifest.bun !== undefined) {
    const bun = manifest.bun;
    expect(isTable(bun), `framework plugin ${name}: [bun] must be a table`, errors);
    if (isTable(bun)) {
      expect(validToken(bun.entry) && relativeInside(bun.entry) && /\.[cm]?[jt]s$/.test(bun.entry), `framework plugin ${name}: bun.entry must be a relative .ts or .js path`, errors);
      if (validToken(bun.entry)) expect(isFile(join(dir, bun.entry)), `framework plugin ${name}: missing bun entry ${join(dir, bun.entry)}`, errors);
    }
  }
  const exports = manifest.exports;
  expect(isTable(exports), `framework plugin ${name}: missing [exports]`, errors);
  if (!isTable(exports)) return;
  const allowed = new Set([...EXPORT_KEYS, "functions", "host_bridge"]);
  for (const key of Object.keys(exports)) expect(allowed.has(key), `framework plugin ${name}: exports.${key} is not supported`, errors);
  if ("aliases" in exports) expect(typeof exports.aliases === "boolean", `framework plugin ${name}: exports.aliases must be bool`, errors);
  if ("host_bridge" in exports) expect(validToken(exports.host_bridge), `framework plugin ${name}: exports.host_bridge must be a non-empty single-line string`, errors);
  if (kind === "bridge") expect(validToken(exports.host_bridge), `framework plugin ${name}: bridge plugins must declare exports.host_bridge`, errors);
  for (const hook of exportList(name, exports, "hooks", errors)) expect(SOURCE_PLUGIN_HOOKS.has(hook), `framework plugin ${name}: source hook '${hook}' is not supported`, errors);
  for (const key of ["commands", "completions", "functions", "keybindings", "prompt_segments", "providers", "themes"]) exportList(name, exports, key, errors);
  if (exports.aliases === true) {
    const p = join(assets.aliases, `${name}.toml`);
    expect(existsSync(p), `framework plugin ${name}: missing aliases asset ${p}`, errors);
  }
  for (const c of exportList(name, exports, "completions", errors)) validateCompletionAsset(name, c, assets.completions, errors);
  const segments = exportList(name, exports, "prompt_segments", errors);
  if (segments.length) validatePromptAssets(name, segments, assets.prompts, errors);
  for (const k of exportList(name, exports, "keybindings", errors)) validateKeybindingAsset(name, k, assets.keybindings, errors);
  for (const t of exportList(name, exports, "themes", errors)) validateThemeAsset(name, t, assets.themes, errors);
  for (const p of exportList(name, exports, "providers", errors)) expect(KNOWN_PROVIDER_EXPORTS.has(p), `framework plugin ${name}: unknown provider '${p}'`, errors);
}

function validateFrameworkSurface(root: string, assets: AssetDirs, errors: Errors) {
  for (const rel of FRAMEWORK_FILES) {
    const p = join(root, rel);
    expect(existsSync(p), `missing framework file: ${p}`, errors);
    if (existsSync(p)) expect(statSync(p).size > 0, `framework file must not be empty: ${p}`, errors);
  }
  const pluginsDir = join(root, "plugins");
  expect(isDir(pluginsDir), `missing framework plugins directory: ${pluginsDir}`, errors);
  if (!isDir(pluginsDir)) return;
  const pluginDirs = dirs(pluginsDir);
  const invPath = join(root, "framework-plugins.toml");
  expect(existsSync(invPath), `missing framework plugin inventory: ${invPath}`, errors);
  const inv = existsSync(invPath) ? loadToml(invPath).plugins : [];
  expect(isList(inv), "framework-plugins.toml: plugins must be a list", errors);
  const expected = (isList(inv) ? inv.map(String) : []).sort();
  expect(JSON.stringify(pluginDirs) === JSON.stringify(expected), `framework plugin inventory drift: expected=${JSON.stringify(expected)} dirs=${JSON.stringify(pluginDirs)}`, errors);
  for (const name of pluginDirs) validateFrameworkPlugin(name, join(pluginsDir, name), assets, errors);
}

function validateAuthoringSurface(root: string, errors: Errors) {
  const doc = join(root, "docs", "authoring.md");
  expect(existsSync(doc), `missing authoring guide: ${doc}`, errors);
  const templates = join(root, "templates");
  expect(isDir(templates), `missing authoring templates directory: ${templates}`, errors);
  if (!isDir(templates)) return;
  expect(existsSync(join(templates, "README.md")), `missing template README: ${join(templates, "README.md")}`, errors);
  for (const kind of AUTHORING_TEMPLATE_KINDS) {
    const p = join(templates, kind, "plugin.toml");
    expect(existsSync(p), `missing ${kind} authoring template: ${p}`, errors);
    if (!existsSync(p)) continue;
    const m = safeLoadToml(p, `template ${kind}`, errors);
    if (!m) continue;
    expect(m.kind === kind, `template ${kind}: kind must be '${kind}'`, errors);
    expect(m.default === false, `template ${kind}: default must be false`, errors);
    expect(isList(m.permissions), `template ${kind}: permissions must be list`, errors);
    expect(isTable(m.exports), `template ${kind}: missing [exports]`, errors);
    if (kind !== "builtin") expect(isTable(m[kind]), `template ${kind}: missing [${kind}]`, errors);
  }
}

function validatePackageIndex(root: string, bundle: Table, available: unknown[], manifests: Map<string, Table>, errors: Errors) {
  const path = join(root, "index.toml");
  expect(existsSync(path), `missing package index: ${path}`, errors);
  if (!existsSync(path)) return;
  const index = safeLoadToml(path, "package index", errors);
  if (!index) return;
  expect(index.schema === INDEX_SCHEMA, `index.toml schema must be '${INDEX_SCHEMA}'`, errors);
  expect(index.bundle === bundle.name, "index.toml bundle must match bundle.toml name", errors);
  expect(index.version === bundle.version, "index.toml version must match bundle.toml version", errors);
  expect(index.bundle_api === bundle.api, "index.toml bundle_api must match bundle.toml api", errors);
  expect(index.min_niubash === bundle.min_niubash, "index.toml min_niubash must match bundle.toml min_niubash", errors);
  const release = index.release;
  expect(isTable(release), "index.toml must contain [release]", errors);
  if (isTable(release)) {
    const artifact = isStr(bundle.version) ? `oh-my-niu-${bundle.version}.zip` : undefined;
    expect(release.artifact === artifact, "index.toml release.artifact must match bundle version", errors);
    expect(release.checksum === (artifact ? `${artifact}.sha256` : undefined), "index.toml release.checksum must match bundle version", errors);
    expect(release.checksum_algorithm === "sha256", "index.toml release.checksum_algorithm must be sha256", errors);
    expect(release.checksum_required === true, "index.toml release.checksum_required must be true", errors);
    expect(release.signature === "unsupported", "index.toml release.signature must be unsupported until signing is implemented", errors);
  }
  const packs = index.packs;
  expect(isList(packs) && packs.length > 0, "index.toml packs must be a non-empty list", errors);
  if (!isList(packs)) return;
  const names = packs.filter(isTable).map((e) => e.name);
  expect(JSON.stringify(names) === JSON.stringify(available), `index.toml pack order drift: index=${JSON.stringify(names)} bundle=${JSON.stringify(available)}`, errors);
  for (const entry of packs) {
    expect(isTable(entry), "index.toml pack entries must be tables", errors);
    if (!isTable(entry)) continue;
    expect(nonEmpty(entry.name), "index.toml pack name must be non-empty string", errors);
    const m = isStr(entry.name) ? manifests.get(entry.name) : undefined;
    if (!m) continue;
    for (const key of ["version", "api", "kind", "category", "summary", "default", "permissions", "required_binaries"]) {
      expect(JSON.stringify(entry[key]) === JSON.stringify(m[key]), `index.toml ${entry.name}.${key} must match manifest`, errors);
    }
  }
}

function validateReleaseDocuments(root: string, bundle: Table, errors: Errors) {
  const { version, min_niubash: min } = bundle;
  for (const [rel, fragments] of Object.entries(RELEASE_DOCUMENTS)) {
    const p = join(root, rel);
    expect(existsSync(p), `missing release document: ${p}`, errors);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    if (isStr(version)) expect(text.includes(version), `${rel}: must mention bundle version '${version}'`, errors);
    for (const fragment of fragments) {
      let want = fragment;
      if (isStr(version)) want = want.replaceAll("{version}", version);
      if (isStr(min)) want = want.replaceAll("{min_niubash}", min);
      expect(text.includes(want), `${rel}: missing release note fragment '${want}'`, errors);
    }
  }
}

function validatePack(root: string, pack: string, packsDir: string, assets: AssetDirs, manifests: Map<string, Table>, errors: Errors) {
  const manifestPath = join(packsDir, pack, "plugin.toml");
  expect(existsSync(manifestPath), `missing manifest for pack: ${pack}`, errors);
  if (!existsSync(manifestPath)) return;
  const manifest = loadToml(manifestPath);
  manifests.set(pack, manifest);
  expect(manifest.name === pack, `${pack}: manifest name mismatch`, errors);
  expect(isStr(manifest.kind) && KNOWN_KINDS.has(manifest.kind), `${pack}: unknown kind`, errors);
  expect(isStr(manifest.category) && KNOWN_CATEGORIES.has(manifest.category), `${pack}: unknown category`, errors);
  expect(typeof manifest.default === "boolean", `${pack}: default must be bool`, errors);
  expect(isList(manifest.permissions), `${pack}: permissions must be list`, errors);
  if (manifest.required_binaries !== undefined) expect(isList(manifest.required_binaries), `${pack}: required_binaries must be list`, errors);
  const exports = manifest.exports;
  expect(isTable(exports), `${pack}: missing [exports]`, errors);
  if (!isTable(exports)) return;
  const missing = REQUIRED_EXPORT_KEYS.filter((k) => !(k in exports)).sort();
  expect(missing.length === 0, `${pack}: [exports] missing keys ${JSON.stringify(missing)}`, errors);
  expect(typeof exports.aliases === "boolean", `${pack}: exports.aliases must be bool`, errors);
  for (const key of REQUIRED_EXPORT_KEYS.filter((k) => k !== "aliases")) expect(isList(exports[key]), `${pack}: exports.${key} must be list`, errors);
  if ("keybindings" in exports) expect(isList(exports.keybindings), `${pack}: exports.keybindings must be list`, errors);
  if ("providers" in exports) expect(isList(exports.providers), `${pack}: exports.providers must be list`, errors);
  if (pack === "keybindings") expect(isList(exports.keybindings) && exports.keybindings.length > 0, "keybindings: exports.keybindings must not be empty", errors);
  validateProviderExports(pack, manifest, exports, errors);
  validateSourceManifest(root, pack, manifest, errors);
  validateProcessManifest(pack, manifest, exports, errors);
  validateWasmManifest(root, pack, manifest, exports, errors);

  if (exports.aliases === true) {
    expect(isDir(assets.aliases), `${pack}: aliases export without aliases dir`, errors);
    const p = join(assets.aliases, `${pack}.toml`);
    expect(existsSync(p), `${pack}: missing aliases asset ${p}`, errors);
    if (existsSync(p)) {
      const aliases = loadToml(p).aliases;
      expect(isTable(aliases), `${pack}: aliases asset must contain [aliases]`, errors);
      if (isTable(aliases)) {
        expect(Object.keys(aliases).length > 0, `${pack}: aliases asset must not be empty`, errors);
        for (const [k, v] of Object.entries(aliases)) {
          expect(k.trim() !== "", `${pack}: alias name must be non-empty`, errors);
          expect(nonEmpty(v), `${pack}: alias '${k}' must have a non-empty value`, errors);
        }
      }
    }
  }
  const listOf = (k: string) => (isList(exports[k]) ? (exports[k] as unknown[]) : []);
  if (listOf("completions").length) {
    expect(isDir(assets.completions), `${pack}: completions export without completions dir`, errors);
    for (const c of listOf("completions")) {
      expect(nonEmpty(c), `${pack}: exports.completions entries must be non-empty strings`, errors);
      if (nonEmpty(c)) validateCompletionAsset(pack, c, assets.completions, errors);
    }
  }
  if (listOf("prompt_segments").length) {
    expect(isDir(assets.prompts), `${pack}: prompt export without prompts dir`, errors);
    validatePromptAssets(pack, listOf("prompt_segments"), assets.prompts, errors);
  }
  if (listOf("keybindings").length) {
    expect(isDir(assets.keybindings), `${pack}: keybindings export without keybindings dir`, errors);
    for (const k of listOf("keybindings")) {
      expect(nonEmpty(k), `${pack}: exports.keybindings entries must be non-empty strings`, errors);
      if (nonEmpty(k)) validateKeybindingAsset(pack, k, assets.keybindings, errors);
    }
  }
  if (listOf("themes").length) {
    expect(isDir(assets.themes), `${pack}: themes export without themes dir`, errors);
    for (const t of listOf("themes")) {
      expect(nonEmpty(t), `${pack}: exports.themes entries must be non-empty strings`, errors);
      if (nonEmpty(t)) validateThemeAsset(pack, t, assets.themes, errors);
    }
  }
}

/** Validate the bundle rooted at `root` (layout, manifests, assets, index, release notes). */
export function validate(root: string): string[] {
  const errors: Errors = [];
  const bundlePath = join(root, "bundle.toml");
  expect(existsSync(bundlePath), "missing bundle.toml", errors);
  if (!existsSync(bundlePath)) return errors;
  const bundle = loadToml(bundlePath);
  expect(bundle.api === BUNDLE_API_VERSION, `bundle.toml api must be '${BUNDLE_API_VERSION}'`, errors);
  validateSemver("bundle.toml version", bundle.version, errors);
  validateSemver("bundle.toml min_niubash", bundle.min_niubash, errors);
  validateReleaseDocuments(root, bundle, errors);
  const packsConfig = (isTable(bundle.packs) ? bundle.packs : {}) as Table;
  const layout = (isTable(bundle.layout) ? bundle.layout : {}) as Table;
  const available = isList(packsConfig.available) ? packsConfig.available : [];
  const def = isList(packsConfig.default) ? packsConfig.default : [];
  expect(available.length > 0, "bundle.toml [packs].available must not be empty", errors);
  expect(def.every((d) => available.includes(d)), "bundle.toml [packs].default must be a subset of available packs", errors);
  const packsDir = join(root, String(layout.packs_dir ?? "packs"));
  expect(isDir(packsDir), `missing packs directory: ${packsDir}`, errors);
  if (!isDir(packsDir)) return errors;
  const packDirs = dirs(packsDir);
  const sortedAvailable = available.map(String).sort();
  expect(JSON.stringify(sortedAvailable) === JSON.stringify(packDirs), `pack inventory drift: bundle=${JSON.stringify(sortedAvailable)} dirs=${JSON.stringify(packDirs)}`, errors);
  const assets: AssetDirs = {
    aliases: join(root, String(layout.aliases_dir ?? "aliases")),
    completions: join(root, String(layout.completions_dir ?? "completions")),
    prompts: join(root, String(layout.prompts_dir ?? "prompts")),
    keybindings: join(root, String(layout.keybindings_dir ?? "keybindings")),
    themes: join(root, String(layout.themes_dir ?? "themes")),
  };
  for (const [key, p] of Object.entries(assets)) expect(isDir(p), `missing ${key} asset directory: ${p}`, errors);
  validateAuthoringSurface(root, errors);
  validateFrameworkSurface(root, assets, errors);
  const manifests = new Map<string, Table>();
  for (const pack of available) validatePack(root, String(pack), packsDir, assets, manifests, errors);
  validatePackageIndex(root, bundle, available, manifests, errors);
  return errors;
}

/** Validate `envs/*.toml` (wpm packages, enabled plugins, environment variables). */
export function validateEnvPacks(root: string, errors: Errors) {
  const envsDir = join(root, "envs");
  if (!isDir(envsDir)) {
    errors.push("missing envs/ directory");
    return;
  }
  const pluginNames = new Set(dirs(join(root, "plugins")));
  for (const file of readdirSync(envsDir).filter((f) => f.endsWith(".toml")).sort()) {
    const ctx = `env ${file}`;
    const env = safeLoadToml(join(envsDir, file), "envs", errors);
    if (!env) continue;
    const meta = isTable(env.meta) ? env.meta : {};
    expect(nonEmpty(meta.description), `${ctx}: meta.description must be a non-empty string`, errors);
    const pkgs = (isTable(env.packages) ? env.packages : {}).wpm;
    expect(isList(pkgs), `${ctx}: packages.wpm must be a list`, errors);
    if (isList(pkgs)) {
      expect(pkgs.length > 0, `${ctx}: packages.wpm must not be empty`, errors);
      for (const n of pkgs) expect(nonEmpty(n), `${ctx}: packages.wpm entries must be non-empty strings`, errors);
    }
    const enable = (isTable(env.plugins) ? env.plugins : {}).enable ?? [];
    expect(isList(enable), `${ctx}: plugins.enable must be a list`, errors);
    if (isList(enable)) {
      for (const n of enable) {
        expect(nonEmpty(n), `${ctx}: plugins.enable entries must be non-empty strings`, errors);
        if (nonEmpty(n)) expect(pluginNames.has(n), `${ctx}: plugin '${n}' has no matching plugins/${n} directory`, errors);
      }
    }
    const vars = env.env ?? {};
    expect(isTable(vars), `${ctx}: env must be a table`, errors);
    if (isTable(vars)) {
      for (const [k, v] of Object.entries(vars)) {
        expect(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k), `${ctx}: env key '${k}' must be a valid identifier`, errors);
        expect(isStr(v), `${ctx}: env '${k}' must be a string`, errors);
      }
    }
  }
}

/** All validation errors of a bundle root, empty when it is valid. */
export function validateAll(root: string): string[] {
  const errors = validate(root);
  validateEnvPacks(root, errors);
  return errors;
}
