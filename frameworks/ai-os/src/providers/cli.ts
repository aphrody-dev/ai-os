// LLM provider inventory: reads the registries of frameworks/ai-os/src/providers/sources.toml, merges providers by id, then recurses
// into every provider exposing a public API base URL (<api>/models, OpenAI-compatible, no key) to count the models
// it really serves. Writes docs/ai/providers.json and docs/ai/PROVIDERS.md; deterministic order, so the commit
// diff shows only real changes. Usage: ai-os providers [--check]  (just ai-providers)
import { join, resolve } from "node:path";

type Source = {
  name: string;
  kind: "openrouter" | "modelsdev" | "litellm" | "arena";
  url: string;
  /** modelsdev only: checkout of anomalyco/models.dev (third_party/models.dev); read first, `url` is the fallback. */
  dir?: string;
};
type Conf = {
  settings: { depth: number; concurrency: number; timeout_ms: number };
  source: Source[];
};
type Provider = {
  id: string;
  sources: Record<string, number>;
  api?: string;
  doc?: string;
  probe?: { status: number; models?: number };
};

const SRC = resolve(import.meta.dir, "..", "..", "..", "..");
const conf = Bun.TOML.parse(
  await Bun.file(
    join(SRC, "frameworks/ai-os/src/providers/sources.toml"),
  ).text(),
) as Conf;
const get = async (url: string) => {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(conf.settings.timeout_ms),
    headers: { "user-agent": "aphrody-providers" },
  });
  return {
    status: r.status,
    json: r.ok ? await r.json().catch(() => null) : null,
  };
};

// models.dev source of truth: providers/<id>/provider.toml (api, doc) and providers/<id>/models/**/*.toml (one per model,
// ids may be nested, e.g. MiniMaxAI/MiniMax-M3). Read from the git objects of the checkout (HEAD), not the work tree:
// model files such as amazon.nova-lite-v1:0.toml cannot be checked out on Windows. Returns the shape of
// https://models.dev/api.json so the pipeline and docs/ai/providers.json do not change; null without a checkout.
const modelsDevRepo = async (dir: string) => {
  const git = (args: string[], stdin?: string) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      maxBuffer: 256 * 1024 * 1024,
    });
    return r.exitCode === 0 ? r.stdout : null;
  };
  const tree = git(["ls-tree", "-r", "HEAD", "--", "providers"]);
  if (!tree) return null;
  const out: Record<
    string,
    { api?: string; doc?: string; models: Record<string, 1> }
  > = {};
  const meta = new Map<string, string>(); // provider id -> blob oid of provider.toml
  for (const line of tree.toString().split("\n")) {
    const m = /^\d+ blob (\w+)\t(providers\/([^/]+)\/(.+))$/.exec(line);
    if (!m) continue;
    const [, oid, , id, rest] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (rest === "provider.toml") meta.set(id, oid);
    else if (rest.startsWith("models/") && rest.endsWith(".toml"))
      (out[id] ??= { models: {} }).models[rest.slice(7, -5)] = 1;
  }
  if (!meta.size) return null;
  // one cat-file --batch for every provider.toml
  const ids = [...meta.keys()];
  const blobs = git(
    ["cat-file", "--batch"],
    `${ids.map((i) => meta.get(i)).join("\n")}\n`,
  );
  if (!blobs) return null;
  let at = 0;
  for (const id of ids) {
    const nl = blobs.indexOf(10, at);
    const size = Number(blobs.subarray(at, nl).toString().split(" ")[2]);
    const body = blobs.subarray(nl + 1, nl + 1 + size).toString();
    at = nl + 1 + size + 1;
    const p = Bun.TOML.parse(body) as { api?: string; doc?: string };
    out[id] = { api: p.api, doc: p.doc, models: out[id]?.models ?? {} };
  }
  return out;
};

const all = new Map<string, Provider>();
const add = (
  id: string,
  source: string,
  n: number,
  extra: Partial<Provider> = {},
) => {
  const p = all.get(id) ?? { id, sources: {} };
  p.sources[source] = (p.sources[source] ?? 0) + n;
  all.set(id, {
    ...p,
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)),
  });
};

const failed: string[] = [];
await Promise.all(
  conf.source.map(async (s) => {
    const repo =
      s.kind === "modelsdev" && s.dir
        ? await modelsDevRepo(join(SRC, s.dir)).catch(() => null)
        : null;
    const { status, json } = repo
      ? { status: 200, json: repo }
      : /^https?:/.test(s.url)
        ? await get(s.url).catch(() => ({ status: 0, json: null }))
        : {
            status: 200,
            json: await Bun.file(join(SRC, s.url))
              .json()
              .catch(() => null),
          };
    if (!json) return failed.push(`${s.name} (HTTP ${status})`);
    if (s.kind === "openrouter")
      for (const m of json.data ?? [])
        add(String(m.id).split("/")[0]!, s.name, 1);
    if (s.kind === "modelsdev")
      for (const [id, v] of Object.entries<any>(json))
        add(id, s.name, Object.keys(v.models ?? {}).length, {
          api: v.api,
          doc: v.doc,
        });
    if (s.kind === "arena")
      for (const o of json.orgs ?? [])
        add(
          String(o.org)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-"),
          s.name,
          o.models,
        );
    if (s.kind === "litellm")
      for (const v of Object.values<any>(json))
        if (v?.litellm_provider) add(v.litellm_provider, s.name, 1);
  }),
);

// Recursion: probe each discovered API, bounded concurrency.
if (conf.settings.depth > 0) {
  const queue = [...all.values()].filter((p) =>
    /^https:\/\//.test(p.api ?? ""),
  );
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const r = await get(`${p.api!.replace(/\/+$/, "")}/models`).catch(() => ({
        status: 0,
        json: null,
      }));
      p.probe = {
        status: r.status,
        models: Array.isArray(r.json?.data) ? r.json.data.length : undefined,
      };
    }
  };
  await Promise.all(Array.from({ length: conf.settings.concurrency }, worker));
}

const ours = new Set(
  [
    ...(await Bun.file(join(SRC, "tools/ai/ai.toml")).text()).matchAll(
      /^id = "([^"]+)"/gm,
    ),
  ].map((m) => m[1]!),
);
const list = [...all.values()].sort((a, b) => a.id.localeCompare(b.id));
const data = `${JSON.stringify({ sources: conf.source.map((s) => s.url), failed, providers: list }, null, 1)}\n`;
const open = list.filter((p) => p.probe?.models);
const md = `# LLM providers

Generated by \`ai-os providers\` from frameworks/ai-os/src/providers/sources.toml; data in docs/ai/providers.json. Do not edit.

${list.length} providers from ${conf.source.map((s) => s.name).join(", ")}${failed.length ? `; failed: ${failed.join(", ")}` : ""}. ${open.length} answer a public \`/models\` listing without a key. Configured in tools/ai/ai.toml: ${[...ours].sort().join(", ")}.

| Provider | Models per source | Public /models | In ai.toml |
|---|---|---|---|
${list
  .map(
    (p) =>
      `| ${p.doc ? `[${p.id}](${p.doc})` : p.id} | ${Object.entries(p.sources)
        .map(([k, v]) => `${k} ${v}`)
        .join(
          ", ",
        )} | ${p.probe ? (p.probe.models ?? `HTTP ${p.probe.status}`) : ""} | ${ours.has(p.id) ? "yes" : ""} |`,
  )
  .join("\n")}
`;

const out = [
  [join(SRC, "docs/ai/providers.json"), data],
  [join(SRC, "docs/ai/PROVIDERS.md"), md],
] as const;
const changed = [];
for (const [f, text] of out) {
  const cur = (await Bun.file(f).exists()) ? await Bun.file(f).text() : "";
  if (cur === text) continue;
  changed.push(f);
  if (!process.argv.includes("--check")) await Bun.write(f, text);
}
console.log(
  `${list.length} providers, ${open.length} public listings, ${failed.length} source(s) failed; ${changed.length ? "changed" : "unchanged"}`,
);
process.exitCode = failed.length === conf.source.length ? 1 : 0;
