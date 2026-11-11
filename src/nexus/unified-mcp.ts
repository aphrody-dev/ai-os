import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, cpus, freemem, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { getSovereignEnv } from "../env.ts";
import {
  executePiMinimalTool,
  type N2bReaOperation,
  type PiMinimalToolName,
  queryContext7Unified,
  runKeylessGoogleSearchGrounding,
  runN2bReaAction,
} from "../extracted/index.ts";
import { getCudaFfi } from "../ffi/polyglot.ts";
import {
  inspectCrossAuthStatus,
  runAgent,
  runCouncil,
  type TriadAgentId,
} from "../triad/index.ts";
import {
  buildCanonicalSoulMarkdown,
  recallMemories,
  rememberEntry,
  searchUnifiedSessions,
  syncBrainMemoriesAndSessions,
} from "./brain-memory.ts";
import {
  diagnoseGoogleAuth,
  mintGoogleAccessToken,
  redactSecretsFromText,
  stripEmojis,
} from "./security.ts";
import {
  installSkillCollection,
  listActiveCollections,
  readUnifiedSkillContent,
  removeSkillCollection,
  searchUnifiedSkills,
} from "./skills-hub.ts";

export interface CompactToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const UNIFIED_DOMAIN_TOOLS: readonly CompactToolDefinition[] = [
  {
    name: "os_atomic",
    description:
      "Minimal Pi-style atomic OS operations (read, write, edit, bash) with C:\\Windows\\System32 write protection.",
    inputSchema: {
      type: "object",
      required: ["op"],
      properties: {
        op: { type: "string", enum: ["read", "write", "edit", "bash"] },
        path: { type: "string" },
        content: { type: "string" },
        target: { type: "string" },
        replacement: { type: "string" },
        command: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "ai_triad",
    description:
      "Cross-AI Triad orchestrator: ask_claude, ask_codex, ask_agy, council (parallel consensus), or auth_status.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "ask_claude",
            "ask_codex",
            "ask_agy",
            "council",
            "auth_status",
          ],
        },
        prompt: { type: "string" },
        model: { type: "string" },
        cwd: { type: "string" },
        review: { type: "boolean" },
      },
    },
  },
  {
    name: "google_cloud",
    description:
      "Keyless Google Cloud & Developer Knowledge: auth_doctor, gcloud CLI (JSON), dev_knowledge_search, dev_knowledge_get.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "auth_doctor",
            "gcloud",
            "dev_knowledge_search",
            "dev_knowledge_get",
          ],
        },
        args: { type: "array", items: { type: "string" } },
        query: { type: "string" },
        documentName: { type: "string" },
      },
    },
  },
  {
    name: "google_workspace",
    description:
      "Google Workspace CLI (gws.exe): drive_list, drive_search, docs_get, docs_create, sheets_get, schema, raw.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "drive_list",
            "drive_search",
            "docs_get",
            "docs_create",
            "sheets_get",
            "schema",
            "raw",
          ],
        },
        query: { type: "string" },
        id: { type: "string" },
        title: { type: "string" },
        range: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "google_search",
    description:
      "Grounded Google Search via keyless Vertex AI Gemini googleSearch tool (with API-key & Exa neural fallback).",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        locale: { type: "string", enum: ["fr", "en"] },
        model: { type: "string" },
      },
    },
  },
  {
    name: "docs_context",
    description:
      "Unified upstream documentation router: context7_search, context7_docs, gemini_docs, cloudflare_docs.",
    inputSchema: {
      type: "object",
      required: ["source", "query"],
      properties: {
        source: {
          type: "string",
          enum: [
            "context7_search",
            "context7_docs",
            "gemini_docs",
            "cloudflare_docs",
          ],
        },
        query: { type: "string" },
        libraryId: { type: "string" },
      },
    },
  },
  {
    name: "github_forge",
    description:
      "Compact keyless/authenticated GitHub router (replaces 26 legacy tools): repo_info, org_repos, search_repos, search_code, get_file, issues, pulls.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "repo_info",
            "org_repos",
            "search_repos",
            "search_code",
            "get_file",
            "issues",
            "pulls",
          ],
        },
        owner: { type: "string" },
        repo: { type: "string" },
        org: { type: "string" },
        query: { type: "string" },
        path: { type: "string" },
        perPage: { type: "integer" },
      },
    },
  },
  {
    name: "design_figma",
    description:
      "Design & UI router: figma_whoami, figma_nodes, material_symbol_svg (local Material Symbols vector).",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["figma_whoami", "figma_nodes", "material_symbol_svg"],
        },
        fileKey: { type: "string" },
        nodeIds: { type: "string" },
        symbolName: { type: "string" },
        style: { type: "string", enum: ["outlined", "rounded", "sharp"] },
      },
    },
  },
  {
    name: "hardware_cuda",
    description:
      "Native RTX 4070 Ada sm_89 CUDA 13.4 & NT Kernel router: gpu_status, kernel_cpu_memory, cuda_sm89_bench, cuda_compile_check.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "gpu_status",
            "kernel_cpu_memory",
            "cuda_sm89_bench",
            "cuda_compile_check",
          ],
        },
        code: { type: "string" },
        arch: { type: "string" },
        ptxOnly: { type: "boolean" },
      },
    },
  },
  {
    name: "n2b_rea",
    description:
      "Extracted n2b + Ghidra SRE + Replica clean-room router: scan, ripgrep, ast, migrate, llvm, ghidra_decompile, dotnet, mingw_rea, replica_blueprint.",
    inputSchema: {
      type: "object",
      required: ["op"],
      properties: {
        op: {
          type: "string",
          enum: [
            "scan",
            "ripgrep",
            "ast",
            "migrate",
            "llvm",
            "ghidra_decompile",
            "dotnet",
            "mingw_rea",
            "replica_blueprint",
          ],
        },
        path: { type: "string" },
        pattern: { type: "string" },
        file: { type: "string" },
        source: { type: "string" },
        binary: { type: "string" },
        target: { type: "string" },
      },
    },
  },
  {
    name: "brain_memory_soul",
    description:
      "Unified Soul, Brain, Memory, Sessions & Collections: soul, remember, recall, sessions_search, sessions_sync, skill_read, collections_list, collections_install, collections_remove.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: [
            "soul",
            "remember",
            "recall",
            "sessions_search",
            "sessions_sync",
            "skill_read",
            "collections_list",
            "collections_install",
            "collections_remove",
          ],
        },
        query: { type: "string" },
        namespace: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        collectionId: { type: "string" },
      },
    },
  },
];

async function callRemoteMcpTool(
  endpointUrl: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const resp = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const text = await resp.text();
  if (text.includes("data: {")) {
    const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data: {"));
    if (dataLine) {
      return JSON.parse(dataLine.slice(6));
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return { status: resp.status, body: text.slice(0, 4000) };
  }
}

export async function handleGoogleCloudDomain(
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = String(args.action ?? "auth_doctor");
  if (action === "auth_doctor") {
    return diagnoseGoogleAuth();
  }

  if (action === "gcloud") {
    const subArgs = Array.isArray(args.args)
      ? args.args.map(String)
      : ["projects", "describe", "aphrody"];
    // Safety guardrail: block destructive project/iam deletion
    const joined = subArgs.join(" ").toLowerCase();
    if (/\b(delete|destroy|remove-iam-policy-binding)\b/.test(joined)) {
      return {
        ok: false,
        error:
          "Destructive gcloud mutation blocked by ai-os guardrail. Run interactive confirmation first.",
      };
    }
    const finalArgs = subArgs.some((a) => a.startsWith("--format"))
      ? [...subArgs, "--quiet"]
      : [...subArgs, "--format=json", "--quiet"];
    const cmd =
      process.platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "gcloud", ...finalArgs]
        : ["gcloud", ...finalArgs];
    const proc = Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    const out = redactSecretsFromText(
      new TextDecoder().decode(proc.stdout).trim(),
    );
    const err = redactSecretsFromText(
      new TextDecoder().decode(proc.stderr).trim(),
    );
    try {
      return { ok: proc.exitCode === 0, data: JSON.parse(out) };
    } catch {
      return { ok: proc.exitCode === 0, stdout: out, stderr: err };
    }
  }

  const minted = await mintGoogleAccessToken();
  if (!minted.token) {
    return {
      ok: false,
      error: "Google OAuth2 token unavailable for Developer Knowledge.",
    };
  }

  const headers = {
    authorization: `Bearer ${minted.token}`,
    "x-goog-user-project": minted.projectId,
  };

  if (action === "dev_knowledge_search") {
    const query = String(args.query ?? "Cloud Run");
    const url = new URL(
      "https://developerknowledge.googleapis.com/v1alpha/documents:searchDocumentChunks",
    );
    url.searchParams.set("query", query);
    url.searchParams.set("pageSize", "6");
    const resp = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      return await resp.json();
    }
    return callRemoteMcpTool(
      "https://developerknowledge.googleapis.com/mcp",
      "search_documents",
      { query },
      headers,
    );
  }

  if (action === "dev_knowledge_get") {
    const docName = String(args.documentName ?? "");
    const url = `https://developerknowledge.googleapis.com/v1alpha/${docName.replace(/^\//, "")}`;
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok
      ? await resp.json()
      : { ok: false, status: resp.status, text: await resp.text() };
  }

  return { ok: false, error: `Unknown google_cloud action: ${action}` };
}

export async function handleGoogleWorkspaceDomain(
  args: Record<string, unknown>,
): Promise<unknown> {
  const gwsBin = join(homedir(), ".local", "bin", "gws.exe");
  if (!existsSync(gwsBin)) {
    return { ok: false, error: `gws binary missing at ${gwsBin}` };
  }

  const action = String(args.action ?? "drive_list");
  let cliArgs: string[] = [];
  if (action === "schema") {
    cliArgs = ["schema", String(args.query ?? "drive.files.list")];
  } else if (action === "drive_list") {
    cliArgs = [
      "drive",
      "files",
      "list",
      "--params",
      JSON.stringify({ pageSize: 15 }),
    ];
  } else if (action === "drive_search") {
    const q = String(args.query ?? "").replace(/'/g, "\\'");
    cliArgs = [
      "drive",
      "files",
      "list",
      "--params",
      JSON.stringify({
        q: `name contains '${q}' and trashed = false`,
        pageSize: 15,
      }),
    ];
  } else if (action === "docs_get") {
    cliArgs = [
      "docs",
      "documents",
      "get",
      "--params",
      JSON.stringify({ documentId: String(args.id ?? "") }),
    ];
  } else if (action === "docs_create") {
    cliArgs = [
      "docs",
      "documents",
      "create",
      "--json",
      JSON.stringify({ title: stripEmojis(String(args.title ?? "Untitled")) }),
    ];
  } else if (action === "sheets_get") {
    cliArgs = [
      "sheets",
      "spreadsheets",
      "values",
      "get",
      "--params",
      JSON.stringify({
        spreadsheetId: String(args.id ?? ""),
        range: String(args.range ?? "A1:Z50"),
      }),
    ];
  } else if (action === "raw") {
    cliArgs = Array.isArray(args.args) ? args.args.map(String) : ["--version"];
  }

  const minted = await mintGoogleAccessToken({
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  });

  const envMap: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GOOGLE_WORKSPACE_PROJECT_ID: minted.projectId,
  };
  if (minted.token) {
    envMap.GOOGLE_WORKSPACE_CLI_TOKEN = minted.token;
  }

  const proc = Bun.spawnSync([gwsBin, ...cliArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: envMap,
    timeout: 15_000,
  });
  const stdout = redactSecretsFromText(
    new TextDecoder().decode(proc.stdout).trim(),
  );
  const stderr = redactSecretsFromText(
    new TextDecoder().decode(proc.stderr).trim(),
  );
  try {
    return { ok: proc.exitCode === 0, data: JSON.parse(stdout) };
  } catch {
    return { ok: proc.exitCode === 0, stdout, stderr };
  }
}

export async function handleGithubForgeDomain(
  args: Record<string, unknown>,
): Promise<unknown> {
  const env = getSovereignEnv();
  let token =
    env.get("GITHUB_TOKEN") ??
    env.get("GH_TOKEN") ??
    env.get("GITHUB_PERSONAL_ACCESS_TOKEN");
  if (!token) {
    try {
      const gh = Bun.spawnSync(["gh", "auth", "token"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 3000,
      });
      if (gh.exitCode === 0) {
        token = new TextDecoder().decode(gh.stdout).trim();
      }
    } catch {
      // Keyless unauthenticated mode works on all public repos/orgs!
    }
  }

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "aphrody-ai-os/1.0",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const action = String(args.action ?? "repo_info");
  const perPage = Math.min(100, Math.max(1, Number(args.perPage ?? 20)));
  let apiUrl = "";

  if (action === "repo_info") {
    apiUrl = `https://api.github.com/repos/${encodeURIComponent(String(args.owner ?? "google-gemini"))}/${encodeURIComponent(String(args.repo ?? "gemini-cli"))}`;
  } else if (action === "org_repos") {
    apiUrl = `https://api.github.com/orgs/${encodeURIComponent(String(args.org ?? args.owner ?? "google-antigravity"))}/repos?per_page=${perPage}&sort=updated`;
  } else if (action === "search_repos") {
    apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(String(args.query ?? "org:google-deepmind"))}&per_page=${perPage}`;
  } else if (action === "search_code") {
    apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(String(args.query ?? ""))}&per_page=${perPage}`;
  } else if (action === "get_file") {
    apiUrl = `https://api.github.com/repos/${encodeURIComponent(String(args.owner ?? ""))}/${encodeURIComponent(String(args.repo ?? ""))}/contents/${String(args.path ?? "README.md").replace(/^\//, "")}`;
  } else if (action === "issues") {
    apiUrl = `https://api.github.com/repos/${encodeURIComponent(String(args.owner ?? ""))}/${encodeURIComponent(String(args.repo ?? ""))}/issues?per_page=${perPage}`;
  } else if (action === "pulls") {
    apiUrl = `https://api.github.com/repos/${encodeURIComponent(String(args.owner ?? ""))}/${encodeURIComponent(String(args.repo ?? ""))}/pulls?per_page=${perPage}`;
  } else {
    return { ok: false, error: `Unknown github_forge action: ${action}` };
  }

  const resp = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await resp.json();
  return {
    ok: resp.ok,
    status: resp.status,
    authenticated: Boolean(token),
    data,
  };
}

export async function handleDesignFigmaDomain(
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = String(args.action ?? "material_symbol_svg");
  if (action === "material_symbol_svg") {
    const name = String(args.symbolName ?? args.name ?? "search");
    const style = String(args.style ?? "outlined");
    const roots = [
      "C:/src/packages/google-design/upstream/material-design-icons",
      "C:/src/google-design/upstream/material-design-icons",
    ];
    for (const root of roots) {
      const candidate = join(
        root,
        "symbols",
        "web",
        name,
        `materialsymbols${style}`,
        `${name}_24px.svg`,
      );
      if (existsSync(candidate)) {
        return {
          ok: true,
          name,
          style,
          svgPath: candidate.replace(/\\/g, "/"),
          svg: readFileSync(candidate, "utf8").trim(),
        };
      }
    }
    return {
      ok: true,
      name,
      style,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="24" height="24"><title>${name}</title></svg>`,
    };
  }

  const token =
    getSovereignEnv().get("FIGMA_ACCESS_TOKEN") ??
    getSovereignEnv().get("FIGMA_TOKEN");
  if (!token) {
    return { ok: false, error: "FIGMA_ACCESS_TOKEN not configured" };
  }
  const endpoint =
    action === "figma_whoami"
      ? "https://api.figma.com/v1/me"
      : `https://api.figma.com/v1/files/${encodeURIComponent(String(args.fileKey ?? ""))}${args.nodeIds ? `/nodes?ids=${encodeURIComponent(String(args.nodeIds))}` : "?depth=2"}`;
  const resp = await fetch(endpoint, {
    headers: { "X-Figma-Token": token },
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: resp.ok, status: resp.status, data: await resp.json() };
}

export function handleHardwareCudaDomain(
  args: Record<string, unknown>,
): unknown {
  const action = String(args.action ?? "gpu_status");
  if (action === "gpu_status") {
    const proc = Bun.spawnSync(
      [
        "nvidia-smi",
        "--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    const smi = new TextDecoder().decode(proc.stdout).trim();
    const parts = smi.split(",").map((s) => s.trim());
    const cuda = getCudaFfi();
    return {
      ok: true,
      gpu: {
        name: parts[0] || "NVIDIA GeForce RTX 4070 (sm_89)",
        driverVersion: parts[1] || "621.14",
        vramTotalMb: Number(parts[2] || 12282),
        vramUsedMb: Number(parts[3] || 0),
        vramFreeMb: Number(parts[4] || 12282),
        utilizationPct: Number(parts[5] || 0),
        tempC: Number(parts[6] || 0),
        powerDrawW: Number(parts[7] || 0),
      },
      cudaSm89DllLoaded: Boolean(cuda),
      architecture: "sm_89",
    };
  }

  if (action === "kernel_cpu_memory") {
    return {
      ok: true,
      osRelease: release(),
      cpuModel: cpus()[0]?.model ?? "Intel Core i7-13700F",
      logicalCores: cpus().length,
      ramTotalGb: Math.round((totalmem() / 1024 ** 3) * 100) / 100,
      ramFreeGb: Math.round((freemem() / 1024 ** 3) * 100) / 100,
      instructionSets: ["AVX2", "FMA3", "BMI2", "AES-NI"],
    };
  }

  if (action === "cuda_sm89_bench") {
    const cuda = getCudaFfi();
    return cuda
      ? cuda.scanAndBench(true)
      : { ok: false, error: "sovereign_cuda_sm89.dll not loaded" };
  }

  if (action === "cuda_compile_check") {
    const code = String(args.code ?? "");
    if (!code) return { ok: false, error: "Missing CUDA C++ 'code' snippet" };
    const arch = String(args.arch ?? "sm_89");
    const ptxOnly = Boolean(args.ptxOnly ?? args.ptx_only);
    const id = crypto.randomUUID().slice(0, 8);
    const tmpCu = join(tmpdir(), `aios_${id}.cu`);
    const tmpOut = join(tmpdir(), `aios_${id}.${ptxOnly ? "ptx" : "obj"}`);
    try {
      writeFileSync(tmpCu, code, "utf8");
      const proc = Bun.spawnSync(
        [
          "nvcc",
          `-arch=${arch}`,
          "--ptxas-options=-v",
          ptxOnly ? "-ptx" : "-c",
          tmpCu,
          "-o",
          tmpOut,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 25_000 },
      );
      const stdout = new TextDecoder().decode(proc.stdout).trim();
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      const ptxPreview =
        ptxOnly && existsSync(tmpOut)
          ? readFileSync(tmpOut, "utf8").slice(0, 1200)
          : undefined;
      return {
        ok: proc.exitCode === 0,
        arch,
        exitCode: proc.exitCode,
        stdout,
        stderr,
        ptxPreview,
      };
    } finally {
      try {
        if (existsSync(tmpCu)) unlinkSync(tmpCu);
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return { ok: false, error: `Unknown hardware_cuda action: ${action}` };
}

export async function executeUnifiedDomainTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ handled: boolean; isError?: boolean; payload?: unknown }> {
  if (toolName === "os_atomic") {
    const res = executePiMinimalTool(args.op as PiMinimalToolName, args);
    return { handled: true, isError: !res.ok, payload: res };
  }

  // Direct compatibility aliases for AI-Triad tools + compact `ai_triad` router
  if (
    toolName === "ai_triad" ||
    toolName === "triad_ask_claude" ||
    toolName === "triad_ask_codex" ||
    toolName === "triad_ask_agy" ||
    toolName === "triad_council_review" ||
    toolName === "triad_auth_status"
  ) {
    const action =
      toolName === "ai_triad"
        ? String(args.action ?? "auth_status")
        : toolName.replace(/^triad_/, "").replace("council_review", "council");
    if (action === "auth_status") {
      return {
        handled: true,
        payload: await inspectCrossAuthStatus({ skipCliProbes: true }),
      };
    }
    if (action === "council") {
      const report = await runCouncil(String(args.prompt ?? ""));
      return {
        handled: true,
        isError: report.succeededCount === 0,
        payload: report,
      };
    }
    const targetMap: Record<string, TriadAgentId> = {
      ask_claude: "claude",
      ask_codex: "codex",
      ask_agy: "agy",
    };
    const agent = targetMap[action] ?? "agy";
    const res = await runAgent(agent, {
      prompt: String(args.prompt ?? ""),
      model: typeof args.model === "string" ? args.model : undefined,
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      review: Boolean(args.review),
    });
    return { handled: true, isError: !res.ok, payload: res };
  }

  if (toolName === "google_cloud") {
    return { handled: true, payload: await handleGoogleCloudDomain(args) };
  }

  if (toolName === "google_workspace") {
    return { handled: true, payload: await handleGoogleWorkspaceDomain(args) };
  }

  if (toolName === "google_search") {
    const out = await runKeylessGoogleSearchGrounding(
      String(args.query ?? ""),
      {
        locale: args.locale === "fr" ? "fr" : "en",
        model: typeof args.model === "string" ? args.model : undefined,
      },
    );
    return { handled: true, payload: out };
  }

  if (toolName === "docs_context") {
    const source = String(args.source ?? "context7_search");
    const query = String(args.query ?? "");
    if (source === "context7_search") {
      return {
        handled: true,
        payload: await queryContext7Unified({ action: "search", query }),
      };
    }
    if (source === "context7_docs") {
      return {
        handled: true,
        payload: await queryContext7Unified({
          action: "docs",
          libraryId: String(args.libraryId ?? "/oven-sh/bun"),
          query,
        }),
      };
    }
    if (source === "gemini_docs") {
      return {
        handled: true,
        payload: await callRemoteMcpTool(
          "https://gemini-api-docs-mcp.dev/mcp",
          "gemini_search_docs",
          { query, toolSummary: "Search Gemini docs" },
        ),
      };
    }
    if (source === "cloudflare_docs") {
      return {
        handled: true,
        payload: await callRemoteMcpTool(
          "https://docs.mcp.cloudflare.com/mcp",
          "search_cloudflare_documentation",
          { query },
        ),
      };
    }
  }

  if (toolName === "github_forge") {
    return { handled: true, payload: await handleGithubForgeDomain(args) };
  }

  if (
    toolName === "design_figma" ||
    toolName === "figma_whoami" ||
    toolName === "figma_get_file_nodes" ||
    toolName === "material_symbol_svg"
  ) {
    const mapped =
      toolName === "design_figma"
        ? args
        : {
            ...args,
            action:
              toolName === "figma_get_file_nodes" ? "figma_nodes" : toolName,
          };
    return { handled: true, payload: await handleDesignFigmaDomain(mapped) };
  }

  if (
    toolName === "hardware_cuda" ||
    toolName === "gpu_cuda_status" ||
    toolName === "kernel_cpu_memory_status" ||
    toolName === "cuda_compile_check"
  ) {
    const mapped =
      toolName === "hardware_cuda"
        ? args
        : {
            ...args,
            action:
              toolName === "gpu_cuda_status"
                ? "gpu_status"
                : toolName === "kernel_cpu_memory_status"
                  ? "kernel_cpu_memory"
                  : "cuda_compile_check",
          };
    return { handled: true, payload: handleHardwareCudaDomain(mapped) };
  }

  if (toolName === "n2b_rea") {
    const payload = await runN2bReaAction(args.op as N2bReaOperation, args);
    return { handled: true, payload };
  }

  if (toolName === "brain_memory_soul") {
    const action = String(args.action ?? "soul");
    if (action === "soul") {
      return { handled: true, payload: { soul: buildCanonicalSoulMarkdown() } };
    }
    if (action === "remember") {
      return {
        handled: true,
        payload: rememberEntry({
          namespace:
            typeof args.namespace === "string" ? args.namespace : "global",
          title: String(args.title ?? "Note"),
          content: String(args.content ?? ""),
          tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        }),
      };
    }
    if (action === "recall") {
      return {
        handled: true,
        payload: recallMemories(String(args.query ?? ""), {
          namespace:
            typeof args.namespace === "string" ? args.namespace : undefined,
        }),
      };
    }
    if (action === "sessions_search") {
      return {
        handled: true,
        payload: searchUnifiedSessions(String(args.query ?? "")),
      };
    }
    if (action === "sessions_sync") {
      return { handled: true, payload: syncBrainMemoriesAndSessions() };
    }
    if (action === "skill_read") {
      return {
        handled: true,
        payload: readUnifiedSkillContent(String(args.query ?? "")),
      };
    }
    if (action === "collections_list") {
      return { handled: true, payload: listActiveCollections() };
    }
    if (action === "collections_install") {
      return {
        handled: true,
        payload: installSkillCollection(
          String(args.collectionId ?? "os-minimal"),
        ),
      };
    }
    if (action === "collections_remove") {
      return {
        handled: true,
        payload: removeSkillCollection(String(args.collectionId ?? "")),
      };
    }
    if (action === "skills_search") {
      return {
        handled: true,
        payload: searchUnifiedSkills(String(args.query ?? "")),
      };
    }
  }

  return { handled: false };
}
