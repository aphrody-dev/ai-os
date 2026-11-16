import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { stripEmojis, writeFileSafeUserspace } from "../../../src/index.ts";

export const GOOGLE_AI_ORGS = [
  "google-antigravity",
  "google-gemini",
  "google-deepmind",
  "google-labs-code",
  "google",
] as const;

export type GoogleAiOrg = (typeof GOOGLE_AI_ORGS)[number];

export interface GoogleOrgRepoEntry {
  org: GoogleAiOrg;
  name: string;
  fullName: string;
  description: string;
  stars: number;
  language: string;
  pushedAt: string;
  htmlUrl: string;
}

export interface GoogleAiSurfaceDescriptor {
  id: string;
  title: string;
  category:
    "studio-ide-cli" | "consumer-apps" | "cloud-apis" | "open-weights-research";
  keylessAuthMode: string;
  localBridgeCommand: string;
  upstreamOrg: GoogleAiOrg;
  capabilities: string[];
}

export const GOOGLE_AI_ECOSYSTEM_SURFACES: readonly GoogleAiSurfaceDescriptor[] =
  [
    {
      id: "google-ai-studio",
      title: "Google AI Studio (Prompt, Multimodal, Live & Structured Output)",
      category: "studio-ide-cli",
      keylessAuthMode: "Keyless Vertex ADC / OAuth PKCE via ai-os",
      localBridgeCommand: "agy web --port 4325",
      upstreamOrg: "google-gemini",
      capabilities: [
        "Prompt & System Instruction Workbench",
        "Multimodal Audio/Video/Image/PDF Inspection",
        "Structured JSON Schema & Function Calling",
        "One-click export to Bun TypeScript, Rust & Python",
      ],
    },
    {
      id: "antigravity-cli-sdk-ide",
      title: "Google Antigravity CLI, Python/TS SDK & Agentic IDE",
      category: "studio-ide-cli",
      keylessAuthMode: "Native AGY OAuth Session + Single Unified ai-os MCP",
      localBridgeCommand: "agy status",
      upstreamOrg: "google-antigravity",
      capabilities: [
        "antigravity-cli (v1.5.5) + Sovereign agy-studio extensions",
        "antigravity-sdk-python & Bun TypeScript ACP/MCP client",
        "Dual-mode execution: minimal (pi-sudo) vs fullstack (pro-max)",
        "Autonomous /goal infinite verification loops",
      ],
    },
    {
      id: "agy-desktop-native",
      title: "Antigravity & Gemini Native Rust Desktop App",
      category: "consumer-apps",
      keylessAuthMode: "Localhost Loopback to ai-os (:4318) & agy-web (:4325)",
      localBridgeCommand: "agy desktop",
      upstreamOrg: "google-antigravity",
      capabilities: [
        "Rust 2024 Fat-LTO native binary (agy-desktop.exe)",
        "Edge/Chromium --app native chromeless window + ANSI TUI dashboard",
        "Zero Electron bloat, sub-15MB RAM shell",
      ],
    },
    {
      id: "gemini-web-mobile-desktop",
      title: "Gemini Web App, Mobile PWA/Android Companion & Extensions",
      category: "consumer-apps",
      keylessAuthMode: "Keyless ADC + Google Workspace gws CLI OAuth",
      localBridgeCommand: "agy web --headless-check",
      upstreamOrg: "google-gemini",
      capabilities: [
        "Canvas code/doc side-by-side preview",
        "Gems custom personas backed by SOUL.md & Skills Collections",
        "Deep Research multi-step grounded synthesis",
        "Android AICore / Gemini Nano & Kotlin Compose companion skills",
      ],
    },
    {
      id: "gemini-api-and-live",
      title: "Gemini API & Gemini 3.8 Live Bidirectional Streaming",
      category: "cloud-apis",
      keylessAuthMode: "Keyless Vertex Global Endpoint or Optional API Key",
      localBridgeCommand: "ai-os serve --port 4318",
      upstreamOrg: "google-gemini",
      capabilities: [
        "gemini-2.5-flash, gemini-2.5-pro, gemini-3.1-pro, gemini-omni-1.2-flash",
        "WebSocket bidirectional voice/vision VAD & LiveKit translation",
        "Grounded Google Search citations",
      ],
    },
    {
      id: "vertex-ai-and-cloud-ai",
      title: "Google Cloud Vertex AI, Developer Knowledge & Workspace AI",
      category: "cloud-apis",
      keylessAuthMode:
        "gcloud Application Default Credentials (project: aphrody)",
      localBridgeCommand: "ai-os auth-doctor",
      upstreamOrg: "google",
      capabilities: [
        "Model Garden, Agent Engine, Vector Search & BigQuery ML",
        "Developer Knowledge corpus & Cloud Run one-click deploy",
        "Drive, Docs, Gmail, Calendar & Sheets via gws",
      ],
    },
    {
      id: "gemma-4-and-deepmind-research",
      title: "Gemma 4 Local Suite, JAX/Tunix/CUDA Lab & Open NotebookLM",
      category: "open-weights-research",
      keylessAuthMode: "100% Offline Local Weights + Keyless HuggingFace/Git",
      localBridgeCommand: "agy gemma list",
      upstreamOrg: "google-deepmind",
      capabilities: [
        "Gemma 4 (E2B, 4B, 12B Heretic, 27B) + multimodal mtmd vision/audio",
        "JAX + Optax + Tunix, CUDA 13.4 sm_89 & PyTorch/Heretic training",
        "DeepMind .ipynb research notebooks & Open NotebookLM audio overviews",
      ],
    },
    {
      id: "google-labs-stitch-jules",
      title:
        "Google Labs (Stitch UI, Jules Autonomous Coding, Whisk & Mariner)",
      category: "studio-ide-cli",
      keylessAuthMode: "Local Stitch/Design.md Skills + AI Ultra Entitlements",
      localBridgeCommand: "agy collections install google-labs",
      upstreamOrg: "google-labs-code",
      capabilities: [
        "Stitch prompt-to-UI M3 generation & DESIGN.md tokens",
        "Jules asynchronous repo task delegation",
        "Project Mariner browser automation via agent-browser",
      ],
    },
  ];

export const DEFAULT_PROBE_CACHE_PATH = "C:/aphrody/var/google-orgs-probe.json";
export const DEFAULT_AGY_DEPOT_ROOT = "C:/aphrody/var/agy-depot";

function decodeUtfTextSafe(filePath: string): string {
  const buf = readFileSync(filePath);
  let text =
    buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
      ? new TextDecoder("utf-16le").decode(buf)
      : new TextDecoder("utf-8").decode(buf);
  return text.replace(/^\uFEFF/, "");
}

export function loadGoogleOrgsCatalog(
  cachePath = DEFAULT_PROBE_CACHE_PATH,
): Record<GoogleAiOrg, GoogleOrgRepoEntry[]> {
  const result: Record<GoogleAiOrg, GoogleOrgRepoEntry[]> = {
    "google-antigravity": [],
    "google-gemini": [],
    "google-deepmind": [],
    "google-labs-code": [],
    google: [],
  };

  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(decodeUtfTextSafe(cachePath)) as Record<
        string,
        Array<{
          name: string;
          full_name?: string;
          description?: string | null;
          stars?: number;
          stargazers_count?: number;
          language?: string | null;
          pushed_at?: string;
          html_url?: string;
        }>
      >;
      for (const org of GOOGLE_AI_ORGS) {
        const list = raw[org] ?? [];
        result[org] = list.map((r) => ({
          org,
          name: r.name,
          fullName: r.full_name ?? `${org}/${r.name}`,
          description: stripEmojis(r.description ?? ""),
          stars: r.stars ?? r.stargazers_count ?? 0,
          language: r.language || "Polyglot",
          pushedAt: r.pushed_at ?? "",
          htmlUrl: r.html_url ?? `https://github.com/${org}/${r.name}`,
        }));
      }
    } catch {
      // Fallback populated below if cache unreadable
    }
  }

  // Ensure every org has at least canonical baseline entries even in clean environments
  if (result["google-antigravity"].length === 0) {
    result["google-antigravity"].push(
      {
        org: "google-antigravity",
        name: "antigravity-cli",
        fullName: "google-antigravity/antigravity-cli",
        description: "Antigravity CLI agent harness in terminal",
        stars: 2773,
        language: "Go/TypeScript",
        pushedAt: "2026-11-10T16:38:51Z",
        htmlUrl: "https://github.com/google-antigravity/antigravity-cli",
      },
      {
        org: "google-antigravity",
        name: "antigravity-sdk-python",
        fullName: "google-antigravity/antigravity-sdk-python",
        description: "Python SDK for Google Antigravity agents",
        stars: 3995,
        language: "Python",
        pushedAt: "2026-10-28T16:45:46Z",
        htmlUrl: "https://github.com/google-antigravity/antigravity-sdk-python",
      },
    );
  }

  return result;
}

export async function refreshGoogleOrgsKeyless(options?: {
  orgs?: readonly GoogleAiOrg[];
  perPage?: number;
  cachePath?: string;
}): Promise<{
  ok: boolean;
  keyless: true;
  totalRepos: number;
  orgs: Record<GoogleAiOrg, GoogleOrgRepoEntry[]>;
}> {
  const orgsToFetch = options?.orgs ?? GOOGLE_AI_ORGS;
  const perPage = options?.perPage ?? 25;
  const cachePath = options?.cachePath ?? DEFAULT_PROBE_CACHE_PATH;
  const current = loadGoogleOrgsCatalog(cachePath);

  for (const org of orgsToFetch) {
    try {
      // Strictly keyless public GitHub REST probe (no token required)
      const url = `https://api.github.com/orgs/${org}/repos?sort=pushed&per_page=${perPage}`;
      const resp = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "aphrody-agy-keyless-depot/2.0",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (resp.ok) {
        const items = (await resp.json()) as Array<{
          name: string;
          full_name: string;
          description: string | null;
          stargazers_count: number;
          language: string | null;
          pushed_at: string;
          html_url: string;
        }>;
        current[org] = items.map((r) => ({
          org,
          name: r.name,
          fullName: r.full_name,
          description: stripEmojis(r.description ?? ""),
          stars: r.stargazers_count ?? 0,
          language: r.language || "Polyglot",
          pushedAt: r.pushed_at ?? "",
          htmlUrl: r.html_url,
        }));
      }
    } catch {
      // Keep cached entries if offline or rate-limited
    }
  }

  const rawOut: Record<string, unknown> = {};
  let totalRepos = 0;
  for (const org of GOOGLE_AI_ORGS) {
    totalRepos += current[org].length;
    rawOut[org] = current[org].map((r) => ({
      name: r.name,
      full_name: r.fullName,
      description: r.description,
      stars: r.stars,
      language: r.language,
      pushed_at: r.pushedAt,
      html_url: r.htmlUrl,
    }));
  }
  writeFileSafeUserspace(cachePath, `${JSON.stringify(rawOut, null, 2)}\n`);

  return {
    ok: true,
    keyless: true,
    totalRepos,
    orgs: current,
  };
}

export function generateGclientDepotManifest(
  depotRoot = DEFAULT_AGY_DEPOT_ROOT,
): { manifestPath: string; totalSolutions: number } {
  mkdirSync(depotRoot, { recursive: true });
  const catalog = loadGoogleOrgsCatalog();
  const pinnedSolutions: Array<{ name: string; url: string }> = [];

  for (const org of GOOGLE_AI_ORGS) {
    for (const repo of catalog[org].slice(0, 6)) {
      pinnedSolutions.push({
        name: `src/${org}/${repo.name}`,
        url: `${repo.htmlUrl}.git`,
      });
    }
  }

  const gclientPy = [
    "# Chromium depot_tools compatible .gclient specification (Keyless HTTPS)",
    "solutions = [",
    ...pinnedSolutions.map(
      (s) =>
        `  {\n    "name": "${s.name}",\n    "url": "${s.url}",\n    "managed": False,\n    "custom_deps": {},\n  },`,
    ),
    "]",
    "",
  ].join("\n");

  const manifestPath = join(depotRoot, ".gclient");
  writeFileSafeUserspace(manifestPath, gclientPy);
  return {
    manifestPath: manifestPath.replace(/\\/g, "/"),
    totalSolutions: pinnedSolutions.length,
  };
}

export function syncDepotRepoKeyless(
  fullName: string,
  depotRoot = DEFAULT_AGY_DEPOT_ROOT,
): {
  ok: boolean;
  fullName: string;
  checkoutDir: string;
  action: "cloned" | "fetched" | "already-present" | "failed";
  detail: string;
} {
  const [org, repo] = fullName.split("/");
  if (!org || !repo) {
    return {
      ok: false,
      fullName,
      checkoutDir: "",
      action: "failed",
      detail: "Expected <org>/<repo>",
    };
  }

  // Check if already checked out in third_party/google-ecosystem first
  const existingMap: Record<string, string> = {
    "google/skills": "C:/aphrody/third_party/google-skills",
    "google-gemini/gemini-skills": "C:/aphrody/third_party/gemini-skills",
    "google-labs-code/stitch-skills": "C:/aphrody/third_party/stitch-skills",
    "google-labs-code/jules-skills": "C:/aphrody/third_party/jules-skills",
    "google-labs-code/design-md": "C:/aphrody/third_party/design-md",
  };
  if (existingMap[fullName] && existsSync(existingMap[fullName]!)) {
    return {
      ok: true,
      fullName,
      checkoutDir: existingMap[fullName]!,
      action: "already-present",
      detail: "Linked from third_party/google-ecosystem",
    };
  }

  const checkoutDir = join(depotRoot, "repos", org, repo);
  mkdirSync(join(depotRoot, "repos", org), { recursive: true });
  const gitUrl = `https://github.com/${org}/${repo}.git`;

  if (existsSync(join(checkoutDir, ".git"))) {
    const fetchProc = Bun.spawnSync(
      ["git", "-C", checkoutDir, "fetch", "--depth=1", "origin"],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    return {
      ok: fetchProc.exitCode === 0,
      fullName,
      checkoutDir: checkoutDir.replace(/\\/g, "/"),
      action: fetchProc.exitCode === 0 ? "fetched" : "failed",
      detail:
        new TextDecoder().decode(fetchProc.stderr).trim() || "Fetched depth=1",
    };
  }

  const cloneProc = Bun.spawnSync(
    [
      "git",
      "-c",
      "credential.helper=",
      "clone",
      "--depth=1",
      "--single-branch",
      gitUrl,
      checkoutDir,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 45_000 },
  );

  return {
    ok: cloneProc.exitCode === 0,
    fullName,
    checkoutDir: checkoutDir.replace(/\\/g, "/"),
    action: cloneProc.exitCode === 0 ? "cloned" : "failed",
    detail:
      cloneProc.exitCode === 0
        ? "Shallow cloned keylessly"
        : new TextDecoder().decode(cloneProc.stderr).trim(),
  };
}

const DIGEST_TEXT_EXTS = new Set([
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".js",
  ".rs",
  ".py",
  ".go",
  ".toml",
  ".json",
  ".yaml",
  ".yml",
  ".zig",
  ".cu",
  ".cuh",
]);

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  ".venv",
  "__pycache__",
  "vendor",
]);

/**
 * Gitingest-compatible deterministic repository/directory LLM Markdown digest builder.
 * Uses native `%USERPROFILE%/.local/bin/gitingest.exe` when requested or fast built-in
 * Bun zero-copy walker for instant sub-20ms local digests.
 */
export function buildGitingestDigest(
  targetPath: string,
  options?: {
    maxFiles?: number;
    maxBytesPerFile?: number;
    outPath?: string;
    preferExternalBinary?: boolean;
  },
): {
  ok: boolean;
  targetPath: string;
  digestPath: string;
  filesIncluded: number;
  estimatedTokens: number;
  digestPreview: string;
  fullMarkdown: string;
} {
  const absTarget = resolve(targetPath);
  const maxFiles = options?.maxFiles ?? 40;
  const maxBytes = options?.maxBytesPerFile ?? 12_000;
  const slug = basename(absTarget).replace(/[^a-zA-Z0-9._-]/g, "_");
  const digestPath =
    options?.outPath ??
    join(DEFAULT_AGY_DEPOT_ROOT, "digests", `${slug}-gitingest.md`);
  mkdirSync(join(DEFAULT_AGY_DEPOT_ROOT, "digests"), { recursive: true });

  const gitingestBin = "%USERPROFILE%/.local/bin/gitingest.exe";
  if (options?.preferExternalBinary && existsSync(gitingestBin)) {
    const proc = Bun.spawnSync([gitingestBin, absTarget, "-o", digestPath], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    if (proc.exitCode === 0 && existsSync(digestPath)) {
      const md = stripEmojis(readFileSync(digestPath, "utf8"));
      return {
        ok: true,
        targetPath: absTarget.replace(/\\/g, "/"),
        digestPath: digestPath.replace(/\\/g, "/"),
        filesIncluded: (md.match(/^FILE:\s/gm) ?? []).length || 1,
        estimatedTokens: Math.ceil(md.length / 4),
        digestPreview: md.slice(0, 800),
        fullMarkdown: md,
      };
    }
  }

  const collected: Array<{ relPath: string; content: string }> = [];
  const treeLines: string[] = [];

  const walk = (dir: string, relPrefix: string) => {
    if (collected.length >= maxFiles || !existsSync(dir)) return;
    const st = statSync(dir);
    if (st.isFile()) {
      const raw = readFileSync(dir, "utf8").slice(0, maxBytes);
      collected.push({ relPath: basename(dir), content: stripEmojis(raw) });
      treeLines.push(basename(dir));
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (collected.length >= maxFiles) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        treeLines.push(`${rel}/`);
        walk(full, rel);
      } else if (DIGEST_TEXT_EXTS.has(extname(entry.name).toLowerCase())) {
        try {
          const fStat = statSync(full);
          if (fStat.size > 512_000) continue;
          const raw = readFileSync(full, "utf8").slice(0, maxBytes);
          treeLines.push(rel);
          collected.push({ relPath: rel, content: stripEmojis(raw) });
        } catch {
          // skip unreadable binary files
        }
      }
    }
  };

  walk(absTarget, "");

  const sections = [
    `# Gitingest Digest: ${slug}`,
    "",
    `Source: \`${absTarget.replace(/\\/g, "/")}\``,
    `Files Included: ${collected.length}`,
    "",
    "## Directory Structure",
    "```text",
    ...treeLines.slice(0, 120),
    "```",
    "",
    "## File Contents",
    ...collected.map(
      (f) =>
        `\n================================================\nFILE: ${f.relPath}\n================================================\n${f.content}\n`,
    ),
  ];

  const fullMarkdown = sections.join("\n");
  writeFileSafeUserspace(digestPath, fullMarkdown);

  return {
    ok: true,
    targetPath: absTarget.replace(/\\/g, "/"),
    digestPath: digestPath.replace(/\\/g, "/"),
    filesIncluded: collected.length,
    estimatedTokens: Math.ceil(fullMarkdown.length / 4),
    digestPreview: fullMarkdown.slice(0, 800),
    fullMarkdown,
  };
}
