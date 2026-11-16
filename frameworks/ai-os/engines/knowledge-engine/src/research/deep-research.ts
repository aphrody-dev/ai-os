import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getLibraryDocs,
  searchLibraries,
  type Context7ClientOptions,
} from "../context7/client.ts";
import { openKnowledgeDatabase } from "../db/sqlite.ts";
import {
  getSecretKeyValue,
  redactSecretsFromText,
  stripEmojis,
} from "../env/safe-env.ts";
import { blake3Hex } from "../ffi/blake3.ts";

export type AuthorityTier =
  | "Tier 1: Official Spec / Context7 / Local Verified Source"
  | "Tier 2: Upstream GitHub/GitLab Repo"
  | "Tier 3: Neural Web";

export interface ResearchEvidenceItem {
  channel:
    "context7" | "exa" | "github" | "systems_upstream" | "local_monorepo";
  tier: AuthorityTier;
  tierRank: 1 | 2 | 3;
  title: string;
  canonicalUrl: string;
  summary: string;
  fingerprint: string;
  publishedAt?: string;
}

export interface DeepResearchResult {
  query: string;
  slug: string;
  subQueries: string[];
  detectedLibraries: string[];
  evidence: ResearchEvidenceItem[];
  channelStatuses: Record<string, string>;
  dossierMarkdown: string;
  savedPath: string | null;
  durationMs: number;
}

export interface DeepResearchOptions {
  srcRoot?: string;
  outDir?: string;
  saveReport?: boolean;
  dbPath?: string;
  envPath?: string;
  fetchImpl?: typeof fetch;
  maxResultsPerChannel?: number;
}

const KNOWN_TECH_LIBRARIES: ReadonlyArray<{
  pattern: RegExp;
  libraryName: string;
  preferredId?: string;
}> = [
  {
    pattern: /\bbun\b|\bbun:ffi\b|\bbun:sqlite\b/i,
    libraryName: "bun",
    preferredId: "/oven-sh/bun",
  },
  { pattern: /\bcontext7\b/i, libraryName: "context7" },
  {
    pattern: /\bmcp\b|model\s*context\s*protocol/i,
    libraryName: "modelcontextprotocol",
  },
  { pattern: /\btokio\b/i, libraryName: "tokio" },
  { pattern: /\baxum\b/i, libraryName: "axum" },
  { pattern: /\bwgpu\b|\bwebgpu\b/i, libraryName: "wgpu" },
  {
    pattern: /\bcloudflare\b|\bwrangler\b|\bworkers?\b|\br2\b/i,
    libraryName: "cloudflare",
  },
  { pattern: /\bvercel\b|\bnext\.?js\b/i, libraryName: "nextjs" },
  { pattern: /\bcaddy\b/i, libraryName: "caddy" },
  { pattern: /\bsqlite\b/i, libraryName: "sqlite" },
  { pattern: /\btypescript\b/i, libraryName: "typescript" },
  { pattern: /\bplaywright\b/i, libraryName: "playwright" },
  { pattern: /\bdioxus\b/i, libraryName: "dioxus" },
  { pattern: /\bzed\b|\bgpui\b/i, libraryName: "zed" },
];

const SYSTEMS_GRAPHICS_KEYWORDS =
  /\b(linux|kernel|nt|mingw|wsl|wayland|vulkan|mesa|dx12|directx|webgpu|wgpu|wasm|freedesktop|gamescope|proton|wine|cuda|uring|ioring)\b/i;

export function slugifyQuery(query: string): string {
  const cleaned = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return cleaned || `research-${blake3Hex(query).slice(0, 10)}`;
}

export function decomposeResearchQuery(query: string): {
  subQueries: string[];
  detectedLibraries: Array<{ libraryName: string; preferredId?: string }>;
  isSystemsOrGraphics: boolean;
} {
  const normalized = query.trim().replace(/\s+/g, " ");
  const detected: Array<{ libraryName: string; preferredId?: string }> = [];
  const seenLibs = new Set<string>();

  for (const entry of KNOWN_TECH_LIBRARIES) {
    if (entry.pattern.test(normalized) && !seenLibs.has(entry.libraryName)) {
      seenLibs.add(entry.libraryName);
      detected.push({
        libraryName: entry.libraryName,
        preferredId: entry.preferredId,
      });
    }
  }

  // Fallback token extraction for camelCase / package-like identifiers if none matched
  if (detected.length === 0) {
    const tokens = normalized
      .split(/[\s,;:()[\]/\\]+/)
      .filter((t) => t.length >= 3 && /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(t))
      .filter(
        (t) =>
          !/^(and|the|for|with|from|into|architecture|how|what|why|using|latest|spec|api|v\d+)$/i.test(
            t,
          ),
      );
    if (tokens[0]) {
      detected.push({ libraryName: tokens[0].toLowerCase() });
    }
  }

  const clauses = normalized
    .split(/\s+(?:and|vs\.?|versus|with|\+|&)\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length >= 4);

  const subQueries = Array.from(
    new Set([
      normalized,
      ...clauses.slice(0, 3),
      `${normalized} specification architecture reference`,
    ]),
  ).slice(0, 4);

  return {
    subQueries,
    detectedLibraries: detected.slice(0, 3),
    isSystemsOrGraphics: SYSTEMS_GRAPHICS_KEYWORDS.test(normalized),
  };
}

export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("file:///")) {
    return trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  }
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    for (const utm of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
    ]) {
      parsed.searchParams.delete(utm);
    }
    const str = parsed.toString();
    return str.endsWith("/") && parsed.pathname !== "/"
      ? str.slice(0, -1)
      : str;
  } catch {
    return trimmed;
  }
}

async function fetchContext7Channel(
  query: string,
  libs: Array<{ libraryName: string; preferredId?: string }>,
  opts: Context7ClientOptions,
): Promise<ResearchEvidenceItem[]> {
  const items: ResearchEvidenceItem[] = [];
  const tasks = libs.map(async (lib) => {
    let targetId = lib.preferredId;
    if (!targetId) {
      const searchRes = await searchLibraries(lib.libraryName, query, opts);
      targetId = searchRes.results[0]?.id;
    }
    if (!targetId) return;

    const docs = await getLibraryDocs(targetId, query, 2500, opts);
    for (const chunk of docs.chunks.slice(0, 4)) {
      const cleanSnippet = stripEmojis(redactSecretsFromText(chunk.snippet))
        .replace(/\s+/g, " ")
        .slice(0, 480);
      const url = canonicalizeUrl(chunk.sourceUrl);
      items.push({
        channel: "context7",
        tier: "Tier 1: Official Spec / Context7 / Local Verified Source",
        tierRank: 1,
        title: `[Context7 ${docs.libraryId}] ${stripEmojis(chunk.title)}`,
        canonicalUrl: url,
        summary: cleanSnippet,
        fingerprint: chunk.fingerprint,
      });
    }
  });

  await Promise.allSettled(tasks);
  return items;
}

async function fetchExaChannel(
  query: string,
  fetchFn: typeof fetch,
  envPath?: string,
  numResults = 5,
): Promise<ResearchEvidenceItem[]> {
  const exaKey = getSecretKeyValue("EXA_API_KEY", envPath);
  if (!exaKey) {
    return [];
  }

  const res = await fetchFn("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": exaKey,
    },
    body: JSON.stringify({
      query,
      numResults,
      type: "auto",
      contents: {
        text: { maxCharacters: 900 },
        highlights: { numSentences: 3 },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Exa search HTTP ${res.status}`);
  }

  const payload = (await res.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      publishedDate?: string;
      text?: string;
      highlights?: string[];
    }>;
  };

  const out: ResearchEvidenceItem[] = [];
  for (const r of payload.results ?? []) {
    if (!r.url) continue;
    const url = canonicalizeUrl(r.url);
    const rawExcerpt =
      Array.isArray(r.highlights) && r.highlights.length > 0
        ? r.highlights.join(" ... ")
        : (r.text ?? "");
    const summary = stripEmojis(redactSecretsFromText(rawExcerpt))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 480);
    const isSpecDomain =
      /(?:modelcontextprotocol\.io|bun\.sh|bun\.com|w3\.org|whatwg\.org|rust-lang\.org|kernel\.org|learn\.microsoft\.com|developers\.cloudflare\.com)/i.test(
        url,
      );

    out.push({
      channel: "exa",
      tier: isSpecDomain
        ? "Tier 1: Official Spec / Context7 / Local Verified Source"
        : "Tier 3: Neural Web",
      tierRank: isSpecDomain ? 1 : 3,
      title: stripEmojis(redactSecretsFromText(r.title || url)),
      canonicalUrl: url,
      summary: summary || "Exa neural search match.",
      fingerprint: blake3Hex(`${url}\n${summary}`),
      publishedAt: r.publishedDate,
    });
  }
  return out;
}

async function fetchGitHubChannel(
  query: string,
  fetchFn: typeof fetch,
  envPath?: string,
  perPage = 4,
): Promise<ResearchEvidenceItem[]> {
  const ghToken = getSecretKeyValue("GITHUB_TOKEN", envPath);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "sovereign-knowledge-engine/1.0",
  };
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }

  const searchUrl = new URL("https://api.github.com/search/repositories");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("sort", "stars");
  searchUrl.searchParams.set("order", "desc");
  searchUrl.searchParams.set("per_page", String(perPage));

  const res = await fetchFn(searchUrl.toString(), { headers });
  if (!res.ok) {
    throw new Error(`GitHub search HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    items?: Array<{
      full_name?: string;
      html_url?: string;
      description?: string;
      stargazers_count?: number;
      default_branch?: string;
      pushed_at?: string;
      archived?: boolean;
    }>;
  };

  const topRepos = (data.items ?? []).slice(0, perPage);
  const items: ResearchEvidenceItem[] = [];

  await Promise.allSettled(
    topRepos.map(async (repo) => {
      if (!repo.full_name || !repo.html_url) return;
      let latestTag = "";
      try {
        const relRes = await fetchFn(
          `https://api.github.com/repos/${repo.full_name}/releases/latest`,
          { headers },
        );
        if (relRes.ok) {
          const relJson = (await relRes.json()) as { tag_name?: string };
          if (relJson.tag_name)
            latestTag = `, latest release ${relJson.tag_name}`;
        }
      } catch {
        // Optional release enrichment
      }

      const url = canonicalizeUrl(repo.html_url);
      const desc = stripEmojis(
        redactSecretsFromText(repo.description ?? "Upstream GitHub repository"),
      );
      const summary = `${desc} (stars: ${repo.stargazers_count ?? 0}, default_branch: ${repo.default_branch ?? "main"}${latestTag}, archived: ${Boolean(repo.archived)})`;

      items.push({
        channel: "github",
        tier: "Tier 2: Upstream GitHub/GitLab Repo",
        tierRank: 2,
        title: `GitHub: ${repo.full_name}`,
        canonicalUrl: url,
        summary,
        fingerprint: blake3Hex(`${url}\n${summary}`),
        publishedAt: repo.pushed_at,
      });
    }),
  );

  return items;
}

async function fetchSystemsUpstreamChannel(
  query: string,
  isSystemsOrGraphics: boolean,
  fetchFn: typeof fetch,
): Promise<ResearchEvidenceItem[]> {
  if (!isSystemsOrGraphics) {
    return [];
  }

  const items: ResearchEvidenceItem[] = [];
  const tasks: Array<Promise<void>> = [];

  if (/\b(linux|kernel|uring|nt|wsl|posix|syscall)\b/i.test(query)) {
    tasks.push(
      (async () => {
        const res = await fetchFn("https://www.kernel.org/releases.json");
        if (!res.ok) return;
        const json = (await res.json()) as {
          latest_stable?: { version?: string; released?: { isodate?: string } };
          releases?: Array<{
            moniker?: string;
            version?: string;
            source?: string;
          }>;
        };
        const latest = json.latest_stable?.version ?? "unknown";
        const mainline =
          json.releases?.find((r) => r.moniker === "mainline")?.version ??
          latest;
        const summary = `Official kernel.org releases feed: latest_stable=${latest}, mainline=${mainline}.`;
        const url = "https://www.kernel.org/releases.json";
        items.push({
          channel: "systems_upstream",
          tier: "Tier 1: Official Spec / Context7 / Local Verified Source",
          tierRank: 1,
          title: "Linux Kernel Archives (kernel.org releases.json)",
          canonicalUrl: url,
          summary,
          fingerprint: blake3Hex(`${url}\n${summary}`),
          publishedAt: json.latest_stable?.released?.isodate,
        });
      })(),
    );
  }

  if (
    /\b(wayland|mesa|vulkan|freedesktop|gamescope|dx12|proton|wine|webgpu)\b/i.test(
      query,
    )
  ) {
    tasks.push(
      (async () => {
        const fdUrl = new URL("https://gitlab.freedesktop.org/api/v4/projects");
        fdUrl.searchParams.set("search", "wayland");
        fdUrl.searchParams.set("per_page", "2");
        const res = await fetchFn(fdUrl.toString());
        if (!res.ok) return;
        const projects = (await res.json()) as Array<{
          path_with_namespace?: string;
          web_url?: string;
          description?: string;
          last_activity_at?: string;
        }>;
        for (const proj of projects.slice(0, 2)) {
          if (!proj.web_url) continue;
          const url = canonicalizeUrl(proj.web_url);
          const summary = stripEmojis(
            redactSecretsFromText(
              proj.description ||
                `Freedesktop GitLab upstream repository ${proj.path_with_namespace ?? ""}`,
            ),
          );
          items.push({
            channel: "systems_upstream",
            tier: "Tier 2: Upstream GitHub/GitLab Repo",
            tierRank: 2,
            title: `Freedesktop GitLab: ${proj.path_with_namespace ?? url}`,
            canonicalUrl: url,
            summary,
            fingerprint: blake3Hex(`${url}\n${summary}`),
            publishedAt: proj.last_activity_at,
          });
        }
      })(),
    );
  }

  await Promise.allSettled(tasks);
  return items;
}

function scanLocalMonorepoChannel(
  query: string,
  srcRoot: string,
): ResearchEvidenceItem[] {
  const items: ResearchEvidenceItem[] = [];
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length >= 3);

  const scoreText = (text: string): number => {
    const lower = text.toLowerCase();
    let hits = 0;
    for (const term of terms) {
      if (lower.includes(term)) hits++;
    }
    return hits;
  };

  const lockPath = join(srcRoot, "src.lock.json");
  if (existsSync(lockPath)) {
    try {
      const lockObj = JSON.parse(readFileSync(lockPath, "utf8")) as {
        toolchains?: Record<string, string>;
        repositories?: Record<
          string,
          { path?: string; url?: string; commit?: string }
        >;
      };
      const matchedTools = Object.entries(lockObj.toolchains ?? {}).filter(
        ([k, v]) => scoreText(`${k} ${v}`) > 0,
      );
      const matchedRepos = Object.entries(lockObj.repositories ?? {})
        .filter(([k, v]) => scoreText(`${k} ${v.url ?? ""}`) > 0)
        .slice(0, 4);

      if (matchedTools.length > 0 || matchedRepos.length > 0) {
        const toolSummary = matchedTools
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        const repoSummary = matchedRepos
          .map(([k, v]) => `${k}@${(v.commit ?? "").slice(0, 8)}`)
          .join(", ");
        const summary = [
          toolSummary ? `Pinned toolchains: ${toolSummary}` : "",
          repoSummary ? `Locked repositories: ${repoSummary}` : "",
        ]
          .filter(Boolean)
          .join(" | ");
        const url = `file:///${lockPath.replace(/\\/g, "/")}`;
        items.push({
          channel: "local_monorepo",
          tier: "Tier 1: Official Spec / Context7 / Local Verified Source",
          tierRank: 1,
          title: "Local Monorepo Lockfile (src.lock.json)",
          canonicalUrl: url,
          summary,
          fingerprint: blake3Hex(`${url}\n${summary}`),
        });
      }
    } catch {
      // Ignore malformed lockfile
    }
  }

  const sentinelPath = join(
    srcRoot,
    "frameworks",
    "ai-os",
    "SENTINEL_REPORT.md",
  );
  if (existsSync(sentinelPath)) {
    try {
      const sentinelRaw = readFileSync(sentinelPath, "utf8");
      const matchingLines = sentinelRaw
        .split(/\r?\n/)
        .filter((line) => scoreText(line) > 0 && line.trim().length > 10)
        .slice(0, 3);
      if (matchingLines.length > 0) {
        const summary = stripEmojis(
          redactSecretsFromText(matchingLines.join(" | ").slice(0, 420)),
        );
        const url = `file:///${sentinelPath.replace(/\\/g, "/")}`;
        items.push({
          channel: "local_monorepo",
          tier: "Tier 1: Official Spec / Context7 / Local Verified Source",
          tierRank: 1,
          title: "Local AI-OS 25-Feed Sentinel Report (SENTINEL_REPORT.md)",
          canonicalUrl: url,
          summary,
          fingerprint: blake3Hex(`${url}\n${summary}`),
        });
      }
    } catch {
      // Ignore unreadable sentinel report
    }
  }

  // Scan top-level README.md + packages/*/package.json + crates/*/Cargo.toml
  const candidateFiles: string[] = [join(srcRoot, "README.md")];
  for (const sub of ["packages", "crates", "apps"]) {
    const dir = join(srcRoot, sub);
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const manifest of ["package.json", "Cargo.toml", "README.md"]) {
          const full = join(dir, entry.name, manifest);
          if (existsSync(full)) candidateFiles.push(full);
        }
      }
    } catch {
      // Ignore
    }
  }

  const scoredFiles: Array<{ path: string; hits: number; snippet: string }> =
    [];
  for (const filePath of candidateFiles) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const hits = scoreText(raw);
      if (hits <= 0) continue;
      const bestLine =
        raw
          .split(/\r?\n/)
          .find((l) => scoreText(l) > 0 && l.trim().length > 12) ??
        raw.slice(0, 240);
      scoredFiles.push({
        path: filePath,
        hits,
        snippet: stripEmojis(redactSecretsFromText(bestLine.trim())).slice(
          0,
          360,
        ),
      });
    } catch {
      // Ignore
    }
  }

  scoredFiles.sort((a, b) => b.hits - a.hits);
  for (const match of scoredFiles.slice(0, 4)) {
    const url = `file:///${match.path.replace(/\\/g, "/")}`;
    items.push({
      channel: "local_monorepo",
      tier: "Tier 1: Official Spec / Context7 / Local Verified Source",
      tierRank: 1,
      title: `Local Workspace Manifest: ${match.path.replace(srcRoot, "").replace(/^[\\/]/, "")}`,
      canonicalUrl: url,
      summary: match.snippet,
      fingerprint: blake3Hex(`${url}\n${match.snippet}`),
    });
  }

  return items;
}

export function deduplicateAndRankEvidence(
  rawItems: ResearchEvidenceItem[],
): ResearchEvidenceItem[] {
  const byUrl = new Map<string, ResearchEvidenceItem>();
  const seenFingerprints = new Set<string>();

  for (const item of rawItems) {
    const normUrl = canonicalizeUrl(item.canonicalUrl);
    if (seenFingerprints.has(item.fingerprint)) {
      continue;
    }
    const existing = byUrl.get(normUrl);
    if (!existing || item.tierRank < existing.tierRank) {
      byUrl.set(normUrl, { ...item, canonicalUrl: normUrl });
      seenFingerprints.add(item.fingerprint);
    }
  }

  return Array.from(byUrl.values()).sort((a, b) => {
    if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
    return a.title.localeCompare(b.title);
  });
}

function renderResearchDossierMarkdown(params: {
  query: string;
  slug: string;
  subQueries: string[];
  detectedLibraries: string[];
  evidence: ResearchEvidenceItem[];
  channelStatuses: Record<string, string>;
  durationMs: number;
}): string {
  const tier1 = params.evidence.filter((e) => e.tierRank === 1);
  const tier2 = params.evidence.filter((e) => e.tierRank === 2);
  const tier3 = params.evidence.filter((e) => e.tierRank === 3);

  const lines: string[] = [
    `# Sovereign Deep-Research Dossier: ${stripEmojis(params.query)}`,
    "",
    `- **Generated At**: \`${new Date().toISOString()}\``,
    `- **Slug**: \`${params.slug}\``,
    `- **Execution Latency**: \`${params.durationMs.toFixed(1)} ms\``,
    `- **Detected Upstream Libraries**: ${params.detectedLibraries.length > 0 ? params.detectedLibraries.map((l) => `\`${l}\``).join(", ") : "`none`"}`,
    `- **Evidence Summary**: \`${params.evidence.length}\` deduplicated sources (\`Tier 1: ${tier1.length}\`, \`Tier 2: ${tier2.length}\`, \`Tier 3: ${tier3.length}\`)`,
    "",
    "## 1. Decomposed Sub-Queries & Channel Telemetry",
    "",
    "### Targeted Sub-Queries",
    ...params.subQueries.map((sq, idx) => `${idx + 1}. \`${stripEmojis(sq)}\``),
    "",
    "### Parallel Channel Status",
    "| Channel | Status |",
    "| :--- | :--- |",
    ...Object.entries(params.channelStatuses).map(
      ([ch, st]) => `| \`${ch}\` | ${stripEmojis(redactSecretsFromText(st))} |`,
    ),
    "",
    "## 2. Ranked & Deduplicated Multi-Channel Evidence",
    "",
  ];

  const renderTierSection = (heading: string, list: ResearchEvidenceItem[]) => {
    lines.push(`### ${heading} (${list.length})`);
    lines.push("");
    if (list.length === 0) {
      lines.push("_No sources recorded in this tier for the given query._");
      lines.push("");
      return;
    }
    list.forEach((item, idx) => {
      lines.push(
        `${idx + 1}. **[${item.title}](${item.canonicalUrl})** (\`${item.channel}\`, blake3=\`${item.fingerprint.slice(0, 12)}\`)`,
      );
      lines.push(`   - ${item.summary}`);
    });
    lines.push("");
  };

  renderTierSection(
    "Tier 1: Official Spec / Context7 / Local Verified Source",
    tier1,
  );
  renderTierSection("Tier 2: Upstream GitHub/GitLab Repo", tier2);
  renderTierSection("Tier 3: Neural Web", tier3);

  lines.push("## 3. Citation Ledger");
  lines.push("");
  lines.push("| # | Tier | Channel | Source | Blake3 Prefix |");
  lines.push("| :--- | :--- | :--- | :--- | :--- |");
  params.evidence.forEach((item, i) => {
    lines.push(
      `| ${i + 1} | Tier ${item.tierRank} | \`${item.channel}\` | [${item.title.replace(/\|/g, "/")}](${item.canonicalUrl}) | \`${item.fingerprint.slice(0, 16)}\` |`,
    );
  });
  lines.push("");

  return stripEmojis(redactSecretsFromText(lines.join("\n")));
}

/**
 * Multi-hop parallel Deep Research engine fanning out across Context7 v2, Exa Neural Search,
 * GitHub Live API, Kernel.org/Freedesktop GitLab, and local `C:\aphrody` manifests.
 */
export async function runDeepResearch(
  query: string,
  options: DeepResearchOptions = {},
): Promise<DeepResearchResult> {
  const t0 = Bun.nanoseconds();
  const srcRoot =
    options.srcRoot ?? (process.platform === "win32" ? "C:\\aphrody" : "/src");
  const outDir = options.outDir ?? join(srcRoot, "docs", "research");
  const saveReport = options.saveReport ?? true;
  const fetchFn = options.fetchImpl ?? fetch;
  const maxPerChannel = options.maxResultsPerChannel ?? 5;

  const { subQueries, detectedLibraries, isSystemsOrGraphics } =
    decomposeResearchQuery(query);

  const [ctx7Settled, exaSettled, ghSettled, sysSettled, localSettled] =
    await Promise.allSettled([
      fetchContext7Channel(query, detectedLibraries, {
        dbPath: options.dbPath,
        envPath: options.envPath,
        fetchImpl: fetchFn,
      }),
      fetchExaChannel(query, fetchFn, options.envPath, maxPerChannel),
      fetchGitHubChannel(query, fetchFn, options.envPath, maxPerChannel),
      fetchSystemsUpstreamChannel(query, isSystemsOrGraphics, fetchFn),
      Promise.resolve(scanLocalMonorepoChannel(query, srcRoot)),
    ]);

  const channelStatuses: Record<string, string> = {};
  const collected: ResearchEvidenceItem[] = [];

  const harvest = (
    name: string,
    settled: PromiseSettledResult<ResearchEvidenceItem[]>,
  ) => {
    if (settled.status === "fulfilled") {
      collected.push(...settled.value);
      channelStatuses[name] = `OK (${settled.value.length} items)`;
    } else {
      const msg =
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
      channelStatuses[name] = `DEGRADED (${msg})`;
    }
  };

  harvest("context7_official_docs", ctx7Settled);
  harvest("exa_neural_web", exaSettled);
  harvest("github_live_api", ghSettled);
  harvest("systems_kernel_freedesktop", sysSettled);
  harvest("local_monorepo_grounding", localSettled);

  const evidence = deduplicateAndRankEvidence(collected);
  const slug = slugifyQuery(query);
  const durationMs = (Bun.nanoseconds() - t0) / 1e6;

  const dossierMarkdown = renderResearchDossierMarkdown({
    query,
    slug,
    subQueries,
    detectedLibraries: detectedLibraries.map((d) => d.libraryName),
    evidence,
    channelStatuses,
    durationMs,
  });

  let savedPath: string | null = null;
  if (saveReport) {
    const filePath = resolve(join(outDir, `${slug}.md`));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, dossierMarkdown, "utf8");
    savedPath = filePath;

    const db = openKnowledgeDatabase(options.dbPath);
    const tier1Count = evidence.filter((e) => e.tierRank === 1).length;
    const tier2Count = evidence.filter((e) => e.tierRank === 2).length;
    const tier3Count = evidence.filter((e) => e.tierRank === 3).length;
    db.prepare(
      `INSERT INTO research_dossiers (
        slug, query_text, content_blake3, dossier_path, source_count,
        tier1_count, tier2_count, tier3_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        query_text = excluded.query_text,
        content_blake3 = excluded.content_blake3,
        dossier_path = excluded.dossier_path,
        source_count = excluded.source_count,
        tier1_count = excluded.tier1_count,
        tier2_count = excluded.tier2_count,
        tier3_count = excluded.tier3_count,
        created_at = excluded.created_at`,
    ).run(
      slug,
      redactSecretsFromText(query),
      blake3Hex(dossierMarkdown),
      filePath,
      evidence.length,
      tier1Count,
      tier2Count,
      tier3Count,
      new Date().toISOString(),
    );
  }

  return {
    query,
    slug,
    subQueries,
    detectedLibraries: detectedLibraries.map((d) => d.libraryName),
    evidence,
    channelStatuses,
    dossierMarkdown,
    savedPath,
    durationMs,
  };
}
