// ai-os review: entry point of the tribunal (src/review/index.ts, docs/reviews/README.md). JSON output on stdout,
// JSONL journal on stderr. Exit code: 0 score >= threshold, 1 below the threshold (or frozen), 2 no engine, 3 gemini-web login missing (selftest).
//   ai-os review <chemins|diff|A..B|commit> [-- chemins] [--voices gemini,claude,judge] [--threshold 16]
//                [--fix] [--rounds 4] [--check "<cmd>"] [--slug s] [--title t] [--timeout 420] [--no-cache]
//                [--out <folder>] [--no-write] [--dry-run] [--host H] [--summary <file>]
//   headless overrides of config/review.json: [--files a,b | --files a --files b] (paths or git globs, added to the
//                targets) [--voice gemini] [--model <regex>] [--thinking low|medium|high] [--temperature 0] [--seed N]
//                [--prompt <template>] [--include <glob>] [--exclude <glob>] [--lenient] [--fresh] [--json]
//   --fresh           ignore recorded engine cooldowns (after enabling billing or an API key)
//   gemini-web:    [--web-mode carbon] [--web-thinking high] [--web-timeout 600] [--max-message-bytes 90000] [--headful] [--screenshot <png>]
//   --selftest gemini-web [--send]   checks each page selector on the live page (login state reported)
//   --bundle <path>   review a text bundle (`===== FILE: path =====` headers, the browser route's format)
//   --json            JSON on stdout only (no journal on stderr)
//   ai-os review sources [--force]   refreshes the official sources (var/review/sources, source commit noted)
//   ai-os review mine                scores of all archived verdicts, per voice
import { appendFileSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { srcRoot } from "../orch/fleet";
import { loadConfig, mine, review } from "./index";
import { SourceCache } from "./sources";

export async function main(argv: string[]): Promise<number> {
  const dash = argv.indexOf("--");
  const { positionals, values } = parseArgs({
    args: dash >= 0 ? argv.slice(0, dash) : argv,
    allowPositionals: true,
    options: {
      voices: { type: "string" },
      voice: { type: "string" },
      files: { type: "string", multiple: true },
      bundle: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      temperature: { type: "string" },
      seed: { type: "string" },
      prompt: { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      lenient: { type: "boolean" },
      fresh: { type: "boolean" },
      selftest: { type: "string" },
      send: { type: "boolean" },
      headful: { type: "boolean" },
      screenshot: { type: "string" },
      "web-mode": { type: "string" },
      "web-thinking": { type: "string" },
      "web-timeout": { type: "string" },
      "max-message-bytes": { type: "string" },
      json: { type: "boolean" },
      threshold: { type: "string" },
      fix: { type: "boolean" },
      rounds: { type: "string" },
      check: { type: "string" },
      slug: { type: "string" },
      title: { type: "string" },
      timeout: { type: "string" },
      "no-cache": { type: "boolean" },
      out: { type: "string" },
      "no-write": { type: "boolean" },
      "dry-run": { type: "boolean" },
      host: { type: "string" },
      summary: { type: "string" },
      force: { type: "boolean" },
      quiet: { type: "boolean" },
    },
  });
  const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  const num = (s: string | undefined, name: string, zero = false) => {
    if (s === undefined) return undefined;
    const n = Number(s);
    if (s.trim() === "" || !Number.isFinite(n) || n < 0 || (n === 0 && !zero))
      throw new Error(`--${name}: positive number expected`);
    return n;
  };
  const list = (xs: string[] | undefined) =>
    xs
      ?.flatMap((x) => x.split(","))
      .map((x) => x.trim())
      .filter(Boolean);
  const config = loadConfig();
  const flagsWeb = {
    mode: values["web-mode"],
    thinking: values["web-thinking"],
    timeoutMs:
      num(values["web-timeout"], "web-timeout") &&
      num(values["web-timeout"], "web-timeout")! * 1000,
    maxMessageBytes: num(values["max-message-bytes"], "max-message-bytes"),
    headful: values.headful,
    screenshot: values.screenshot && resolve(values.screenshot),
  };
  if (values.selftest !== undefined) {
    if (values.selftest !== "gemini-web")
      throw new Error("--selftest: only gemini-web is available");
    const { selftest } = await import("./gemini-web");
    const { webOptsOf } = await import("./index");
    const r = await selftest({
      ...webOptsOf(
        config,
        config.voices.gemini ?? { label: "", stance: "" },
        flagsWeb,
      ),
      deep: values.send,
    });
    print(r);
    return r.login ? 3 : r.ok ? 0 : 1;
  }
  if (positionals[0] === "sources" && dash < 0) {
    print(
      await new SourceCache(srcRoot()).refresh(
        loadConfig().sources,
        values.force === true,
      ),
    );
    return 0;
  }
  if (positionals[0] === "mine" && dash < 0) {
    print(mine());
    return 0;
  }
  const targets = [...positionals, ...(list(values.files) ?? [])];
  const spec = [...targets, ...(dash >= 0 ? argv.slice(dash) : [])];
  if (!targets.length && !values.bundle)
    throw new Error(
      "usage: ai-os review <paths|diff|A..B|commit> [-- paths] [--files a,b] [--bundle <path>] [--voice v] [--model <regex>] [--threshold 16] [--fix] [--json]",
    );
  const bundle = values.bundle
    ? (() => {
        const text = readFileSync(resolve(values.bundle!), "utf8");
        return {
          title: values.title ?? `bundle ${basename(values.bundle!)}`,
          text,
        };
      })()
    : undefined;
  const include = list(values.include);
  const exclude = list(values.exclude);
  const r = await review({
    spec: bundle ? [] : spec,
    content: bundle,
    model: values.model,
    thinking: values.thinking,
    temperature: num(values.temperature, "temperature", true),
    seed: num(values.seed, "seed", true),
    strict: values.lenient ? false : undefined,
    fresh: values.fresh,
    web: flagsWeb,
    prompt: values.prompt,
    globs: include || exclude ? { include, exclude } : undefined,
    voices: (values.voices ?? values.voice)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    threshold: num(values.threshold, "threshold"),
    fix: values.fix,
    rounds: num(values.rounds, "rounds"),
    check: values.check,
    slug: values.slug,
    title: values.title,
    timeoutS: num(values.timeout, "timeout"),
    noCache: values["no-cache"],
    out: values.out,
    write: values["no-write"] ? false : undefined,
    dryRun: values["dry-run"],
    host: values.host,
    log:
      values.quiet || values.json
        ? undefined
        : (e) => console.error(JSON.stringify(e)),
  });
  print(r);
  if (values.summary)
    appendFileSync(
      values.summary,
      `## ai-os review: ${r.status}, ${r.score ?? "?"}/20 (threshold ${r.threshold})\n\n${r.voices.map((v) => `- ${v.voice}: ${v.score ?? "?"}/20 (${v.provider ?? "no engine"})`).join("\n")}\n\n${r.verdict}\n`,
    );
  if (values["dry-run"]) return 0;
  return r.status === "no-engine" ? 2 : r.ok ? 0 : 1;
}

// Launched directly or by the src/cli.ts dispatcher; imported by tests without running (bun test: NODE_ENV=test).
// Runs only as an entry point: directly, or through the src/cli.ts dispatcher (`ai-os review`).
const entry = Bun.argv[1] ? resolve(Bun.argv[1]) : "";
if (import.meta.main || entry === resolve(import.meta.dir, "..", "cli.ts")) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (e: any) {
    console.error(String(e?.message ?? e));
    process.exitCode = 2;
  }
}
