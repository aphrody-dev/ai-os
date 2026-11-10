import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSovereignEnv } from "../env.ts";

export type SentinelCategory =
  | "web-standards"
  | "unix-linux"
  | "windows-insiders"
  | "chrome-chromiumos"
  | "android-aosp"
  | "ai-protocols-engines";

export interface SentinelTargetSpec {
  id: string;
  category: SentinelCategory;
  name: string;
  endpoint: string;
  kind:
    | "github-commits"
    | "github-releases"
    | "github-tags"
    | "kernel-org"
    | "chrome-versionhistory"
    | "googlesource-tags"
    | "rss-xml";
  localMirrorPath?: string;
}

export interface SentinelCheckResult {
  id: string;
  category: SentinelCategory;
  name: string;
  endpoint: string;
  status: "live" | "cached" | "offline";
  latestVersion: string;
  publishedAt: string;
  detail: string;
  latencyMs: number;
  localParityNote?: string;
  checkedAt: string;
}

export interface SentinelState {
  generatedAt: string;
  bunVersion: string;
  dbPath: string;
  liveCount: number;
  cachedCount: number;
  offlineCount: number;
  bunParitySummary?: {
    bunVersion: string;
    overallNativeScore: number;
    overallPatchedScore: number;
    chromeCanaryVersion?: string;
  };
  appliedUpdates: Array<{ path: string; status: string }>;
  results: SentinelCheckResult[];
}

export const SENTINEL_TARGETS: readonly SentinelTargetSpec[] = [
  // 1. Web Standards
  {
    id: "whatwg-html",
    category: "web-standards",
    name: "WHATWG HTML Living Standard",
    endpoint: "https://api.github.com/repos/whatwg/html/commits?per_page=1",
    kind: "github-commits",
  },
  {
    id: "whatwg-dom",
    category: "web-standards",
    name: "WHATWG DOM Living Standard",
    endpoint: "https://api.github.com/repos/whatwg/dom/commits?per_page=1",
    kind: "github-commits",
  },
  {
    id: "whatwg-fetch",
    category: "web-standards",
    name: "WHATWG Fetch Living Standard",
    endpoint: "https://api.github.com/repos/whatwg/fetch/commits?per_page=1",
    kind: "github-commits",
  },
  {
    id: "w3c-gpuweb",
    category: "web-standards",
    name: "W3C WebGPU & WGSL Specification",
    endpoint: "https://api.github.com/repos/gpuweb/gpuweb/commits?per_page=1",
    kind: "github-commits",
    localMirrorPath: "C:/src/wgpu",
  },
  {
    id: "tc39-proposals",
    category: "web-standards",
    name: "TC39 ECMAScript Proposals",
    endpoint: "https://api.github.com/repos/tc39/proposals/commits?per_page=1",
    kind: "github-commits",
  },

  // 2. Unix & Linux Kernel
  {
    id: "linux-kernel-org",
    category: "unix-linux",
    name: "Linux Kernel Releases (kernel.org mainline / 7.4-rc* / stable)",
    endpoint: "https://www.kernel.org/releases.json",
    kind: "kernel-org",
    localMirrorPath: "C:/src/linux",
  },
  {
    id: "uutils-coreutils",
    category: "unix-linux",
    name: "Rust uutils/coreutils",
    endpoint: "https://api.github.com/repos/uutils/coreutils/releases/latest",
    kind: "github-releases",
    localMirrorPath: "C:/src/unix",
  },

  // 3. Windows 11 Insiders & Rust Windows SDK
  {
    id: "windows-insider-blog",
    category: "windows-insiders",
    name: "Windows 11 Insider Preview Flight Feed",
    endpoint: "https://blogs.windows.com/windows-insider/feed/",
    kind: "rss-xml",
  },
  {
    id: "microsoft-windows-rs",
    category: "windows-insiders",
    name: "Microsoft windows-rs / windows-sys",
    endpoint:
      "https://api.github.com/repos/microsoft/windows-rs/releases/latest",
    kind: "github-releases",
    localMirrorPath: "C:/src/microsoft",
  },

  // 4. Chrome Nightly / Canary & ChromiumOS
  {
    id: "chrome-win64-canary",
    category: "chrome-chromiumos",
    name: "Chrome Canary (win64)",
    endpoint:
      "https://versionhistory.googleapis.com/v1/chrome/platforms/win64/channels/canary/versions?pageSize=1",
    kind: "chrome-versionhistory",
    localMirrorPath: "C:/src/bun-parity",
  },
  {
    id: "chromiumos-dev",
    category: "chrome-chromiumos",
    name: "ChromiumOS Platform Milestone",
    endpoint:
      "https://versionhistory.googleapis.com/v1/chrome/platforms/chromeos/channels/dev/versions?pageSize=1",
    kind: "chrome-versionhistory",
    localMirrorPath: "C:/src/chromium",
  },

  // 5. AOSP Android 17 & Android 18
  {
    id: "aosp-platform-build",
    category: "android-aosp",
    name: "AOSP Android 17 (Baklava) & Android 18 Next-Gen Preview Tags",
    endpoint:
      "https://android.googlesource.com/platform/build/+refs/tags?format=JSON",
    kind: "googlesource-tags",
  },

  // 6. AI Protocols, Engines & Skills
  {
    id: "mcp-spec",
    category: "ai-protocols-engines",
    name: "Model Context Protocol (MCP)",
    endpoint:
      "https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/commits?per_page=1",
    kind: "github-commits",
  },
  {
    id: "a2a-spec",
    category: "ai-protocols-engines",
    name: "Agent2Agent Protocol (A2A)",
    endpoint: "https://api.github.com/repos/a2aproject/A2A/commits?per_page=1",
    kind: "github-commits",
  },
  {
    id: "acp-spec",
    category: "ai-protocols-engines",
    name: "Agent Client Protocol (ACP)",
    endpoint:
      "https://api.github.com/repos/agentclientprotocol/agent-client-protocol/commits?per_page=1",
    kind: "github-commits",
    localMirrorPath: "C:/src/zed",
  },
  {
    id: "oven-sh-bun",
    category: "ai-protocols-engines",
    name: "oven-sh/bun Full-Rust Runtime",
    endpoint: "https://api.github.com/repos/oven-sh/bun/releases/latest",
    kind: "github-releases",
    localMirrorPath: "C:/src/bun",
  },
  {
    id: "anomalyco-opencode",
    category: "ai-protocols-engines",
    name: "anomalyco/opencode",
    endpoint: "https://api.github.com/repos/anomalyco/opencode/releases/latest",
    kind: "github-releases",
    localMirrorPath: "C:/src/opencode",
  },
  {
    id: "earendil-pi",
    category: "ai-protocols-engines",
    name: "earendil-works/pi",
    endpoint:
      "https://api.github.com/repos/earendil-works/pi/commits?per_page=1",
    kind: "github-commits",
    localMirrorPath: "C:/src/pi",
  },
  {
    id: "vercel-labs-skills",
    category: "ai-protocols-engines",
    name: "vercel-labs/skills",
    endpoint:
      "https://api.github.com/repos/vercel-labs/skills/commits?per_page=1",
    kind: "github-commits",
    localMirrorPath: "C:/src/labs",
  },
  {
    id: "vercel-labs-agent-browser",
    category: "ai-protocols-engines",
    name: "vercel-labs/agent-browser",
    endpoint:
      "https://api.github.com/repos/vercel-labs/agent-browser/releases/latest",
    kind: "github-releases",
    localMirrorPath: "C:/src/agent-browser",
  },
  {
    id: "vercel-labs-agent-desktop",
    category: "ai-protocols-engines",
    name: "vercel-labs/agent-desktop",
    endpoint:
      "https://api.github.com/repos/vercel-labs/agent-desktop/releases/latest",
    kind: "github-releases",
    localMirrorPath: "C:/src/agent-desktop",
  },
  {
    id: "ggml-llamacpp",
    category: "ai-protocols-engines",
    name: "ggml-org/llama.cpp",
    endpoint: "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest",
    kind: "github-releases",
  },
  {
    id: "ollama-engine",
    category: "ai-protocols-engines",
    name: "ollama/ollama",
    endpoint: "https://api.github.com/repos/ollama/ollama/releases/latest",
    kind: "github-releases",
  },
  {
    id: "vllm-engine",
    category: "ai-protocols-engines",
    name: "vllm-project/vllm",
    endpoint: "https://api.github.com/repos/vllm-project/vllm/releases/latest",
    kind: "github-releases",
  },
  {
    id: "open-webui",
    category: "ai-protocols-engines",
    name: "open-webui/open-webui",
    endpoint:
      "https://api.github.com/repos/open-webui/open-webui/releases/latest",
    kind: "github-releases",
  },
];

function openSentinelDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS sentinel_snapshots (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      latest_version TEXT NOT NULL,
      published_at TEXT NOT NULL,
      detail TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      checked_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sentinel_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      latest_version TEXT NOT NULL,
      status TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
  `);
  return db;
}

function readBunParityMatrix(): {
  bunVersion: string;
  overallNativeScore: number;
  overallPatchedScore: number;
} | null {
  const p = "C:/src/bun-parity/parity-matrix.json";
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      bunVersion?: string;
      overallNativeScore?: number;
      overallPatchedScore?: number;
    };
    return {
      bunVersion: raw.bunVersion ?? Bun.version,
      overallNativeScore: raw.overallNativeScore ?? 0,
      overallPatchedScore: raw.overallPatchedScore ?? 100,
    };
  } catch {
    return null;
  }
}

async function fetchTargetLive(
  spec: SentinelTargetSpec,
  githubToken: string | undefined,
  timeoutMs: number,
): Promise<{ latestVersion: string; publishedAt: string; detail: string }> {
  const headers: Record<string, string> = {
    "user-agent": "ai-os-sovereign-sentinel/1.0 (Bun v1.4.4)",
    accept: "application/json, application/xml, text/xml, */*",
  };
  if (githubToken && spec.endpoint.includes("api.github.com")) {
    headers.authorization = `Bearer ${githubToken}`;
  }

  const res = await fetch(spec.endpoint, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  if (spec.kind === "github-commits") {
    const arr = (await res.json()) as Array<{
      sha?: string;
      commit?: { committer?: { date?: string }; message?: string };
    }>;
    const head = arr[0];
    const sha = head?.sha ? head.sha.slice(0, 10) : "unknown";
    const date = head?.commit?.committer?.date ?? new Date().toISOString();
    const firstLine =
      (head?.commit?.message ?? "").split(/\r?\n/)[0]?.slice(0, 100) ?? "";
    return { latestVersion: sha, publishedAt: date, detail: firstLine };
  }

  if (spec.kind === "github-releases") {
    const rel = (await res.json()) as {
      tag_name?: string;
      name?: string;
      published_at?: string;
    };
    if (!rel.tag_name) {
      throw new Error("No tag_name in release");
    }
    return {
      latestVersion: rel.tag_name,
      publishedAt: rel.published_at ?? new Date().toISOString(),
      detail: rel.name ?? rel.tag_name,
    };
  }

  if (spec.kind === "kernel-org") {
    const data = (await res.json()) as {
      latest_stable?: { version?: string };
      releases?: Array<{
        moniker?: string;
        version?: string;
        released?: { isodate?: string };
      }>;
    };
    const mainline = data.releases?.find((r) => r.moniker === "mainline");
    const stable = data.releases?.find((r) => r.moniker === "stable");
    const ver = mainline?.version ?? data.latest_stable?.version ?? "unknown";
    const pub =
      mainline?.released?.isodate ??
      stable?.released?.isodate ??
      new Date().toISOString();
    const detail = `mainline=${mainline?.version ?? "n/a"}, stable=${stable?.version ?? data.latest_stable?.version ?? "n/a"}`;
    return { latestVersion: ver, publishedAt: pub, detail };
  }

  if (spec.kind === "chrome-versionhistory") {
    const data = (await res.json()) as {
      versions?: Array<{ name?: string; version?: string }>;
    };
    const top = data.versions?.[0];
    const ver = top?.version ?? "unknown";
    return {
      latestVersion: ver,
      publishedAt: new Date().toISOString(),
      detail: top?.name ?? ver,
    };
  }

  if (spec.kind === "googlesource-tags") {
    const rawText = await res.text();
    const jsonText = rawText.startsWith(")]}'") ? rawText.slice(4) : rawText;
    const tagsObj = JSON.parse(jsonText) as Record<string, unknown>;
    const allTags = Object.keys(tagsObj);
    const releaseTags = allTags
      .filter((t) => /^android-(\d+)\.(\d+)\.(\d+)_r(\d+)$/.test(t))
      .sort((a, b) => {
        const ma = /^android-(\d+)\.(\d+)\.(\d+)_r(\d+)$/.exec(a)!;
        const mb = /^android-(\d+)\.(\d+)\.(\d+)_r(\d+)$/.exec(b)!;
        for (let i = 1; i <= 4; i++) {
          const diff = Number(ma[i]) - Number(mb[i]);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    const latest =
      releaseTags[releaseTags.length - 1] ??
      allTags[allTags.length - 1] ??
      "aosp-main";
    const recent16Plus = releaseTags
      .filter((t) => /^android-(1[6789]|2\d)\./.test(t))
      .slice(-4);
    const detail =
      recent16Plus.length > 0
        ? `Total AOSP tags=${allTags.length}; recent=${recent16Plus.join(", ")} (Android 17 Baklava active; Android 18 API preview tracked)`
        : `Total AOSP platform/build tags=${allTags.length}; latest=${latest}`;
    return {
      latestVersion: latest,
      publishedAt: new Date().toISOString(),
      detail,
    };
  }

  if (spec.kind === "rss-xml") {
    const xml = await res.text();
    const itemMatch = /<item>([\s\S]*?)<\/item>/i.exec(xml);
    const block = itemMatch?.[1] ?? xml;
    const titleMatch =
      /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i.exec(
        block,
      );
    const pubMatch = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(block);
    const title = (
      titleMatch?.[1] ??
      titleMatch?.[2] ??
      "Windows Insider Flight"
    ).trim();
    const buildNumMatch = /Build\s+(\d{5}(?:\.\d+)?)/i.exec(title);
    const ver = buildNumMatch?.[1]
      ? `Build ${buildNumMatch[1]}`
      : title.slice(0, 48);
    return {
      latestVersion: ver,
      publishedAt: pubMatch?.[1]?.trim() ?? new Date().toISOString(),
      detail: title.slice(0, 120),
    };
  }

  return {
    latestVersion: "unknown",
    publishedAt: new Date().toISOString(),
    detail: "unhandled feed kind",
  };
}

function renderSentinelMarkdown(state: SentinelState): string {
  const lines: string[] = [
    "# Sovereign Real-Time & Nightly Standards Sentinel Report",
    "",
    `Generated: \`${state.generatedAt}\` | Engine: \`oven-sh/bun v${state.bunVersion}\` | WAL DB: \`sentinel.sqlite\` | Live: **${state.liveCount}** | Cached: **${state.cachedCount}** | Offline: **${state.offlineCount}**`,
    "",
  ];

  if (state.bunParitySummary) {
    lines.push(
      "## Chrome Canary vs `C:\\src\\bun-parity` Live Alignment",
      "",
      `- **Live Chrome Win64 Canary**: \`${state.bunParitySummary.chromeCanaryVersion ?? "probed"}\``,
      `- **Local Sovereign Runtime**: \`Bun v${state.bunParitySummary.bunVersion}\` — Native Blink/Web Parity: **${state.bunParitySummary.overallNativeScore}%**, Patched Sovereign Parity: **${state.bunParitySummary.overallPatchedScore}%**`,
      "",
    );
  }

  const categories: Array<{ id: SentinelCategory; title: string }> = [
    {
      id: "web-standards",
      title: "1. Web Standards (WHATWG HTML/DOM/Fetch, W3C WebGPU/WGSL, TC39)",
    },
    {
      id: "unix-linux",
      title:
        "2. Unix & Linux Kernel (`kernel.org` 7.4-rc* / mainline & `uutils/coreutils`)",
    },
    {
      id: "windows-insiders",
      title: "3. Windows 11 Insiders & `microsoft/windows-rs` (`windows-sys`)",
    },
    {
      id: "chrome-chromiumos",
      title: "4. Chrome Canary & ChromiumOS Release Channels",
    },
    {
      id: "android-aosp",
      title: "5. AOSP Android 17 (Baklava) & Android 18 Next-Gen Preview",
    },
    {
      id: "ai-protocols-engines",
      title: "6. AI Protocols (MCP, A2A, ACP), Engines & Skills Ecosystem",
    },
  ];

  for (const cat of categories) {
    const items = state.results.filter((r) => r.category === cat.id);
    lines.push(`## ${cat.title}`, "");
    lines.push(
      "| Feed / Upstream | Status | Latest Version / Commit | Latency | Details & Local Parity |",
    );
    lines.push("| :--- | :--- | :--- | ---: | :--- |");
    for (const r of items) {
      const note = r.localParityNote ? ` (${r.localParityNote})` : "";
      lines.push(
        `| **${r.name}** | \`${r.status.toUpperCase()}\` | \`${r.latestVersion}\` | ${r.latencyMs}ms | ${r.detail.replace(/\|/g, "/")}${note} |`,
      );
    }
    lines.push("");
  }

  if (state.appliedUpdates.length > 0) {
    lines.push("## Applied Fast-Forward / Submodule Sync Operations", "");
    for (const u of state.appliedUpdates) {
      lines.push(`- \`${u.path}\`: ${u.status}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export interface RunSentinelOptions {
  outDir?: string;
  dbPath?: string;
  timeoutMs?: number;
  apply?: boolean;
  targetIds?: string[];
}

export async function runSentinelSync(
  options: RunSentinelOptions = {},
): Promise<SentinelState> {
  const outDir = resolve(options.outDir ?? "C:/src/ai-os");
  mkdirSync(outDir, { recursive: true });
  const dbPath = resolve(options.dbPath ?? join(outDir, "sentinel.sqlite"));
  const timeoutMs = options.timeoutMs ?? 8000;
  const env = getSovereignEnv();
  const githubToken = env.get("GITHUB_TOKEN") ?? env.get("GH_TOKEN");

  const db = openSentinelDb(dbPath);
  const bunParity = readBunParityMatrix();

  const selectedTargets = options.targetIds
    ? SENTINEL_TARGETS.filter((t) => options.targetIds!.includes(t.id))
    : SENTINEL_TARGETS;

  const selectCachedStmt = db.prepare<
    { latest_version: string; published_at: string; detail: string },
    [string]
  >(
    "SELECT latest_version, published_at, detail FROM sentinel_snapshots WHERE id = ?1",
  );

  const upsertStmt = db.prepare(`
    INSERT INTO sentinel_snapshots (id, category, name, endpoint, latest_version, published_at, detail, latency_ms, checked_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(id) DO UPDATE SET
      latest_version = excluded.latest_version,
      published_at = excluded.published_at,
      detail = excluded.detail,
      latency_ms = excluded.latency_ms,
      checked_at = excluded.checked_at
  `);

  const historyStmt = db.prepare(`
    INSERT INTO sentinel_history (id, latest_version, status, checked_at)
    VALUES (?1, ?2, ?3, ?4)
  `);

  const results = await Promise.all(
    selectedTargets.map(async (spec): Promise<SentinelCheckResult> => {
      const start = performance.now();
      const checkedAt = new Date().toISOString();
      let localParityNote: string | undefined;
      if (spec.localMirrorPath && existsSync(spec.localMirrorPath)) {
        localParityNote = `mirror: ${spec.localMirrorPath}`;
      }

      try {
        const live = await fetchTargetLive(spec, githubToken, timeoutMs);
        const latencyMs = Math.round((performance.now() - start) * 10) / 10;
        if (spec.id === "chrome-win64-canary" && bunParity) {
          localParityNote = `bun-parity v${bunParity.bunVersion}: ${bunParity.overallPatchedScore}% patched / ${bunParity.overallNativeScore}% native`;
        }
        upsertStmt.run(
          spec.id,
          spec.category,
          spec.name,
          spec.endpoint,
          live.latestVersion,
          live.publishedAt,
          live.detail,
          latencyMs,
          checkedAt,
        );
        historyStmt.run(spec.id, live.latestVersion, "live", checkedAt);
        return {
          id: spec.id,
          category: spec.category,
          name: spec.name,
          endpoint: spec.endpoint,
          status: "live",
          latestVersion: live.latestVersion,
          publishedAt: live.publishedAt,
          detail: live.detail,
          latencyMs,
          localParityNote,
          checkedAt,
        };
      } catch (err) {
        const latencyMs = Math.round((performance.now() - start) * 10) / 10;
        const cached = selectCachedStmt.get(spec.id);
        if (cached) {
          historyStmt.run(spec.id, cached.latest_version, "cached", checkedAt);
          return {
            id: spec.id,
            category: spec.category,
            name: spec.name,
            endpoint: spec.endpoint,
            status: "cached",
            latestVersion: cached.latest_version,
            publishedAt: cached.published_at,
            detail: `${cached.detail} [cached fallback]`,
            latencyMs,
            localParityNote,
            checkedAt,
          };
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        historyStmt.run(spec.id, "offline", "offline", checkedAt);
        return {
          id: spec.id,
          category: spec.category,
          name: spec.name,
          endpoint: spec.endpoint,
          status: "offline",
          latestVersion: "offline",
          publishedAt: checkedAt,
          detail: `Probe unavailable (${errMsg})`,
          latencyMs,
          localParityNote,
          checkedAt,
        };
      }
    }),
  );

  db.close();

  const appliedUpdates: Array<{ path: string; status: string }> = [];
  if (options.apply) {
    const syncDirs = [
      "C:/src/labs",
      "C:/src/agent-browser",
      "C:/src/agent-desktop",
    ];
    for (const dir of syncDirs) {
      if (!existsSync(join(dir, ".git"))) continue;
      const proc = Bun.spawnSync(
        ["git", "-C", dir, "fetch", "--all", "--prune", "--quiet"],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      appliedUpdates.push({
        path: dir,
        status:
          proc.exitCode === 0
            ? "git fetch --all --prune succeeded"
            : `exit ${proc.exitCode}`,
      });
      if (existsSync(join(dir, ".gitmodules"))) {
        const sub = Bun.spawnSync(
          ["git", "-C", dir, "submodule", "update", "--remote", "--merge"],
          { stdout: "pipe", stderr: "pipe" },
        );
        appliedUpdates.push({
          path: `${dir}/.gitmodules`,
          status:
            sub.exitCode === 0
              ? "submodules updated"
              : `submodule exit ${sub.exitCode}`,
        });
      }
    }
  }

  const canary = results.find((r) => r.id === "chrome-win64-canary");
  const state: SentinelState = {
    generatedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    dbPath: dbPath.replace(/\\/g, "/"),
    liveCount: results.filter((r) => r.status === "live").length,
    cachedCount: results.filter((r) => r.status === "cached").length,
    offlineCount: results.filter((r) => r.status === "offline").length,
    bunParitySummary: bunParity
      ? {
          ...bunParity,
          chromeCanaryVersion: canary?.latestVersion,
        }
      : undefined,
    appliedUpdates,
    results,
  };

  writeFileSync(
    join(outDir, "sentinel-state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(outDir, "SENTINEL_REPORT.md"),
    renderSentinelMarkdown(state),
    "utf8",
  );

  return state;
}

export function readCachedSentinelState(
  outDir = "C:/src/ai-os",
): SentinelState | null {
  const statePath = join(resolve(outDir), "sentinel-state.json");
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as SentinelState;
  } catch {
    return null;
  }
}
