import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getSovereignEnv } from "../env.ts";
import { DEFAULT_NEXUS_DB_PATH, openNexusDb } from "../nexus/brain-memory.ts";
import {
  assertSafeUserspacePath,
  mintGoogleAccessToken,
  redactSecretsFromText,
  stripEmojis,
} from "../nexus/security.ts";

// ============================================================================
// 1. Extracted from `n2b` (`C:/src/n2b` -> `n2b.exe` / `n2b_ffi.dll` + Replica)
// ============================================================================

export type N2bReaOperation =
  | "scan"
  | "ripgrep"
  | "ast"
  | "migrate"
  | "llvm"
  | "ghidra_decompile"
  | "dotnet"
  | "mingw_rea"
  | "replica_blueprint"
  | "level5_formats"
  | "level5_decode"
  | "pdata_sre"
  | "rtti_dump";

export interface ReplicaStageSpec {
  stage: number;
  name: string;
  deliverable: string;
  status: "ready";
}

export function resolveN2bBinaryPath(): string {
  const localBin = join(homedir(), ".local", "bin", "n2b.exe");
  if (existsSync(localBin)) return localBin;
  const workspaceBin = "C:\\src\\n2b\\target\\release\\n2b.exe";
  return existsSync(workspaceBin) ? workspaceBin : localBin;
}

export function buildReplicaCleanRoomBlueprint(targetName: string): {
  target: string;
  methodology: "REA + Replica 11-Stage Clean-Room Synthesis";
  runtimeTarget: "Bun v1.4.4 Full-Rust + Rust 2024 Fat-LTO + WebGPU";
  stages: ReplicaStageSpec[];
} {
  const stages: Array<[string, string]> = [
    ["Binary & Surface Discovery", "Magika + PE/ELF/Web surface inventory"],
    ["MinGW / CRT Noise Stripping", "rea-mingw CRT & relocation symbol filter"],
    [
      "CFG & P-Code Lifting",
      "Pure-Rust Ghidra SRE iced-x86 control-flow graph",
    ],
    [
      "Domain Contract Extraction",
      "Clean-room protocol & schema specification",
    ],
    [
      "Data Structure Normalization",
      "Flat cache-aligned Rust/TypeScript structs",
    ],
    ["Rust Fat-LTO Core Synthesis", "Zero-copy C-ABI cdylib + SIMD kernels"],
    ["Bun v1.4.4 Control Plane", "Bun.serve + bun:sqlite + bun:ffi bindings"],
    [
      "Design System M3 + Fluent 2",
      "Tokens via @aphrody/google-design + Stitch",
    ],
    ["WebGPU / 3D Shader Pipeline", "WGSL compute & render passes"],
    ["Lighthouse 100 & CWV Gate", "Automated wck audit (LCP/INP/CLS/a11y)"],
    ["One-Click Sovereign Deploy", "Cloudflare Workers / Vercel / src-deploy"],
  ];
  return {
    target: stripEmojis(targetName),
    methodology: "REA + Replica 11-Stage Clean-Room Synthesis",
    runtimeTarget: "Bun v1.4.4 Full-Rust + Rust 2024 Fat-LTO + WebGPU",
    stages: stages.map(([name, deliverable], idx) => ({
      stage: idx + 1,
      name,
      deliverable,
      status: "ready",
    })),
  };
}

export async function runN2bReaAction(
  op: N2bReaOperation,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (op === "replica_blueprint") {
    return buildReplicaCleanRoomBlueprint(
      String(args.target ?? args.path ?? "sovereign-app"),
    );
  }

  const bin = resolveN2bBinaryPath();
  if (!existsSync(bin)) {
    return {
      ok: false,
      error: `n2b binary not found at ${bin}`,
    };
  }

  let cliArgs: string[] = [];
  switch (op) {
    case "scan":
      cliArgs = [
        "scan",
        String(args.path ?? "C:/src/packages/ai-os"),
        "--max-files",
        String(args.maxFiles ?? 5000),
        "--json",
      ];
      break;
    case "ripgrep":
      cliArgs = [
        "search",
        String(args.pattern ?? "export"),
        String(args.path ?? "C:/src/packages/ai-os/src"),
        "--max-hits",
        String(args.maxHits ?? 50),
        "--json",
      ];
      break;
    case "ast":
      cliArgs = ["ast", String(args.file ?? ""), "--json"];
      break;
    case "migrate": {
      cliArgs = [
        "migrate",
        String(args.source ?? ""),
        "--max-files",
        String(args.maxFiles ?? 5000),
        "--json",
      ];
      if (args.outDir) {
        assertSafeUserspacePath(String(args.outDir));
        cliArgs.push("--out-dir", String(args.outDir));
      }
      if (args.apply) cliArgs.push("--apply");
      break;
    }
    case "llvm":
      cliArgs = ["llvm", String(args.source ?? ""), "--json"];
      break;
    case "ghidra_decompile":
      cliArgs = [
        "decompile",
        String(args.binary ?? ""),
        "--max-functions",
        String(args.maxFunctions ?? 6),
        "--json",
      ];
      break;
    case "dotnet":
      cliArgs = ["dotnet", String(args.action ?? "doctor"), "--json"];
      break;
    case "mingw_rea":
      cliArgs = ["mingw", String(args.action ?? "doctor"), "--json"];
      if (args.binary) cliArgs.push("--binary", String(args.binary));
      break;
    case "level5_formats": {
      const nieBin = join(homedir(), ".local", "bin", "nie.exe");
      const targetPath = String(
        args.path ??
          args.source ??
          "C:/src/apps/rosegriffon/crates/aphrody-nie-formats",
      );
      if (existsSync(nieBin)) {
        const nieProc = Bun.spawnSync([nieBin, "format", targetPath], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 25_000,
        });
        const out = new TextDecoder().decode(nieProc.stdout).trim();
        const err = new TextDecoder().decode(nieProc.stderr).trim();
        return {
          ok: nieProc.exitCode === 0,
          engine: "nie.exe",
          exitCode: nieProc.exitCode,
          target: targetPath,
          stdout: out,
          stderr: err,
        };
      }
      cliArgs = ["scan", targetPath, "--json"];
      break;
    }
    case "level5_decode": {
      const nieBin = join(homedir(), ".local", "bin", "nie.exe");
      const srcFile = String(args.file ?? args.source ?? "");
      if (existsSync(nieBin) && srcFile) {
        const nieArgs = ["decode", srcFile];
        if (args.out) nieArgs.push("-o", String(args.out));
        const nieProc = Bun.spawnSync([nieBin, ...nieArgs], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        const out = new TextDecoder().decode(nieProc.stdout).trim();
        const err = new TextDecoder().decode(nieProc.stderr).trim();
        return {
          ok: nieProc.exitCode === 0,
          engine: "nie.exe",
          exitCode: nieProc.exitCode,
          source: srcFile,
          stdout: out,
          stderr: err,
        };
      }
      return { ok: false, error: "Missing source file or nie.exe unavailable" };
    }
    case "pdata_sre": {
      const nieBin = join(homedir(), ".local", "bin", "nie.exe");
      const exePath = String(args.binary ?? args.exe ?? "");
      if (existsSync(nieBin) && exePath) {
        const pdataArgs = ["pdata", "--exe", exePath];
        if (args.db) pdataArgs.push("--db", String(args.db));
        const nieProc = Bun.spawnSync([nieBin, ...pdataArgs], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 45_000,
        });
        const out = new TextDecoder().decode(nieProc.stdout).trim();
        const err = new TextDecoder().decode(nieProc.stderr).trim();
        return {
          ok: nieProc.exitCode === 0,
          engine: "nie.exe",
          exitCode: nieProc.exitCode,
          binary: exePath,
          stdout: out,
          stderr: err,
        };
      }
      return { ok: false, error: "Missing binary path or nie.exe unavailable" };
    }
    case "rtti_dump": {
      const nieBin = join(homedir(), ".local", "bin", "nie.exe");
      const exePath = String(args.binary ?? args.exe ?? "");
      if (existsSync(nieBin) && exePath) {
        const rttiArgs = ["rtti", "--exe", exePath];
        if (args.db) rttiArgs.push("--db", String(args.db));
        const nieProc = Bun.spawnSync([nieBin, ...rttiArgs], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 45_000,
        });
        const out = new TextDecoder().decode(nieProc.stdout).trim();
        const err = new TextDecoder().decode(nieProc.stderr).trim();
        return {
          ok: nieProc.exitCode === 0,
          engine: "nie.exe",
          exitCode: nieProc.exitCode,
          binary: exePath,
          stdout: out,
          stderr: err,
        };
      }
      return { ok: false, error: "Missing binary path or nie.exe unavailable" };
    }
  }

  const proc = Bun.spawnSync([bin, ...cliArgs], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 25_000,
  });
  const out = new TextDecoder().decode(proc.stdout).trim();
  const err = new TextDecoder().decode(proc.stderr).trim();
  try {
    return JSON.parse(out);
  } catch {
    return {
      ok: proc.exitCode === 0,
      exitCode: proc.exitCode,
      stdout: out,
      stderr: err,
    };
  }
}

// ============================================================================
// 2. Extracted from `pi-opencode` (Minimal 4-Tool Pi Core + Locally Uncensored)
// ============================================================================

export type PiMinimalToolName = "read" | "write" | "edit" | "bash";

const BLOCKED_SHELL_PATTERNS = [
  /c:\\windows\\system32/i,
  /c:\/windows\/system32/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
];

export function executePiMinimalTool(
  tool: PiMinimalToolName,
  args: Record<string, unknown>,
): { ok: boolean; output: string } {
  if (tool === "read") {
    const p = resolve(String(args.path ?? ""));
    if (!existsSync(p)) {
      return { ok: false, output: `File not found: ${p}` };
    }
    const raw = readFileSync(p, "utf8");
    const limit = Number(args.maxChars ?? 32_000);
    return { ok: true, output: redactSecretsFromText(raw.slice(0, limit)) };
  }

  if (tool === "write") {
    const safePath = assertSafeUserspacePath(String(args.path ?? ""));
    mkdirSync(dirname(safePath), { recursive: true });
    const content = stripEmojis(String(args.content ?? ""));
    writeFileSync(safePath, content, "utf8");
    return { ok: true, output: `Wrote ${content.length} chars to ${safePath}` };
  }

  if (tool === "edit") {
    const safePath = assertSafeUserspacePath(String(args.path ?? ""));
    if (!existsSync(safePath)) {
      return { ok: false, output: `File not found: ${safePath}` };
    }
    const existing = readFileSync(safePath, "utf8");
    const target = String(args.target ?? "");
    const replacement = stripEmojis(String(args.replacement ?? ""));
    if (!target || !existing.includes(target)) {
      return { ok: false, output: `Target snippet not found in ${safePath}` };
    }
    const next = existing.split(target).join(replacement);
    writeFileSync(safePath, next, "utf8");
    return { ok: true, output: `Edited ${safePath}` };
  }

  if (tool === "bash") {
    const command = String(args.command ?? "");
    for (const pat of BLOCKED_SHELL_PATTERNS) {
      if (pat.test(command)) {
        return {
          ok: false,
          output: `Blocked unsafe command targeting protected system path: ${command}`,
        };
      }
    }
    const shell =
      process.platform === "win32"
        ? [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
          ]
        : ["sh", "-lc", command];
    const proc = Bun.spawnSync(shell, {
      cwd: typeof args.cwd === "string" ? args.cwd : process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: Number(args.timeoutMs ?? 20_000),
    });
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    return {
      ok: proc.exitCode === 0,
      output: redactSecretsFromText(`${stdout}${stderr}`.trim()),
    };
  }

  return { ok: false, output: `Unknown Pi tool: ${String(tool)}` };
}

// ============================================================================
// 3. Extracted from `apps/aphrody` + `apps/shenron` (Keyless Google Search Grounding + E5 Contract)
// ============================================================================

export interface GroundedSearchCitation {
  title: string;
  url: string;
}

export interface GroundedSearchOutput {
  query: string;
  answer: string;
  citations: GroundedSearchCitation[];
  grounded: boolean;
  transport:
    | "vertex-ai-keyless-adc"
    | "gemini-api-key"
    | "exa-neural"
    | "local-deterministic-fallback";
  model: string;
  searchQueries: string[];
}

export async function runKeylessGoogleSearchGrounding(
  query: string,
  options?: {
    model?: string;
    locale?: "fr" | "en";
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<GroundedSearchOutput> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const cleanQuery = query.trim().slice(0, 600);
  const model = options?.model ?? "gemini-2.5-flash";
  const timeoutMs = options?.timeoutMs ?? 12_000;
  const promptPrefix =
    options?.locale === "fr"
      ? "Reponds en francais de facon concise, technique et factuelle sans emoji. "
      : "Answer concisely, technically, and factually without emojis. ";

  // 1. Primary: Keyless Vertex AI with Google ADC / gcloud OAuth2 token
  const minted = await mintGoogleAccessToken();
  if (minted.token) {
    try {
      const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(minted.projectId)}/locations/global/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
      const resp = await fetchFn(vertexUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${minted.token}`,
          "x-goog-user-project": minted.projectId,
        },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: `${promptPrefix}${cleanQuery}` }] },
          ],
          tools: [{ googleSearch: {} }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
            groundingMetadata?: {
              webSearchQueries?: string[];
              groundingChunks?: Array<{
                web?: { uri?: string; title?: string };
              }>;
            };
          }>;
        };
        const cand = data.candidates?.[0];
        const text = stripEmojis(
          (cand?.content?.parts ?? [])
            .map((p) => p.text ?? "")
            .join("")
            .trim(),
        );
        if (text) {
          const citations: GroundedSearchCitation[] = [];
          const seen = new Set<string>();
          for (const c of cand?.groundingMetadata?.groundingChunks ?? []) {
            if (c.web?.uri && !seen.has(c.web.uri)) {
              seen.add(c.web.uri);
              citations.push({
                title: stripEmojis(c.web.title || c.web.uri),
                url: c.web.uri,
              });
            }
          }
          return {
            query: cleanQuery,
            answer: text,
            citations,
            grounded: citations.length > 0,
            transport: "vertex-ai-keyless-adc",
            model,
            searchQueries: cand?.groundingMetadata?.webSearchQueries ?? [],
          };
        }
      }
    } catch {
      // Fall through to secondary transports
    }
  }

  // 2. Secondary: Direct GEMINI_API_KEY if valid
  const env = getSovereignEnv();
  const apiKey = env.get("GEMINI_API_KEY") ?? env.get("GOOGLE_API_KEY");
  if (apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const resp = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: `${promptPrefix}${cleanQuery}` }] },
          ],
          tools: [{ google_search: {} }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
            groundingMetadata?: {
              webSearchQueries?: string[];
              groundingChunks?: Array<{
                web?: { uri?: string; title?: string };
              }>;
            };
          }>;
        };
        const cand = data.candidates?.[0];
        const text = stripEmojis(
          (cand?.content?.parts ?? [])
            .map((p) => p.text ?? "")
            .join("")
            .trim(),
        );
        if (text) {
          const citations = (cand?.groundingMetadata?.groundingChunks ?? [])
            .filter((c) => Boolean(c.web?.uri))
            .map((c) => ({
              title: stripEmojis(c.web!.title || c.web!.uri!),
              url: c.web!.uri!,
            }));
          return {
            query: cleanQuery,
            answer: text,
            citations,
            grounded: citations.length > 0,
            transport: "gemini-api-key",
            model,
            searchQueries: cand?.groundingMetadata?.webSearchQueries ?? [],
          };
        }
      }
    } catch {
      // Fall through
    }
  }

  // 3. Tertiary: Exa neural search if EXA_API_KEY present
  const exaKey = env.get("EXA_API_KEY");
  if (exaKey) {
    try {
      const resp = await fetchFn("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": exaKey,
        },
        body: JSON.stringify({
          query: cleanQuery,
          numResults: 5,
          type: "auto",
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          results?: Array<{ title?: string; url?: string }>;
        };
        const citations = (data.results ?? [])
          .filter((r) => Boolean(r.url))
          .map((r) => ({
            title: stripEmojis(r.title || r.url!),
            url: r.url!,
          }));
        return {
          query: cleanQuery,
          answer: `Neural search matched ${citations.length} authoritative sources for "${cleanQuery}".`,
          citations,
          grounded: citations.length > 0,
          transport: "exa-neural",
          model: "exa-auto",
          searchQueries: [cleanQuery],
        };
      }
    } catch {
      // Fall through
    }
  }

  return {
    query: cleanQuery,
    answer: `Offline deterministic synthesis for "${cleanQuery}" (no cloud network reachable).`,
    citations: [],
    grounded: false,
    transport: "local-deterministic-fallback",
    model: "ai-os-offline",
    searchQueries: [],
  };
}

export const SHENRON_EMBEDDING_CONTRACT = {
  modelId: "multilingual-e5-small",
  dimensions: 384,
  policy: "never-mix-spaces",
  computeSemanticCacheScope(namespace: string): string {
    return Bun.CryptoHasher.hash(
      "sha256",
      `never-mix-spaces:${this.modelId}:${this.dimensions}:${namespace}`,
      "hex",
    ).slice(0, 24);
  },
} as const;

// ============================================================================
// 4. Extracted from `knowledge-engine` (Context7 v2 SQLite-Cached Docs & FactCheck)
// ============================================================================

export async function queryContext7Unified(options: {
  action: "search" | "docs";
  libraryName?: string;
  libraryId?: string;
  query: string;
  dbPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const fetchFn = options.fetchImpl ?? fetch;
  const env = getSovereignEnv();
  const apiKey = env.get("CTX7_API_KEY") ?? env.get("CONTEXT7_API_KEY");
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const db = openNexusDb(options.dbPath ?? DEFAULT_NEXUS_DB_PATH);
  db.run(`
    CREATE TABLE IF NOT EXISTS context7_cache (
      cache_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const cacheKey = `${options.action}:${options.libraryName ?? options.libraryId ?? ""}:${options.query}`;
  const cached = db
    .query(
      `SELECT payload_json, created_at FROM context7_cache WHERE cache_key = ?1`,
    )
    .get(cacheKey) as { payload_json: string; created_at: number } | null;

  if (cached && Date.now() - cached.created_at < 12 * 3600_000) {
    return { cached: true, ...JSON.parse(cached.payload_json) };
  }

  if (options.action === "search") {
    const url = new URL("https://context7.com/api/v2/libs/search");
    url.searchParams.set("libraryName", options.libraryName ?? options.query);
    url.searchParams.set("query", options.query);
    try {
      const resp = await fetchFn(url.toString(), {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const wrapped = { ok: true, source: "context7-v2", data };
        db.query(
          `INSERT OR REPLACE INTO context7_cache (cache_key, payload_json, created_at) VALUES (?1, ?2, ?3)`,
        ).run(cacheKey, JSON.stringify(wrapped), Date.now());
        return wrapped;
      }
    } catch {
      // Fallback below
    }
    return { ok: false, source: "context7-offline", query: options.query };
  }

  const url = new URL("https://context7.com/api/v2/context");
  url.searchParams.set("libraryId", options.libraryId ?? "/oven-sh/bun");
  url.searchParams.set("query", options.query);
  url.searchParams.set("type", "txt");
  try {
    const resp = await fetchFn(url.toString(), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const text = stripEmojis(await resp.text()).slice(0, 16_000);
      const wrapped = {
        ok: true,
        source: "context7-v2",
        libraryId: options.libraryId,
        content: text,
      };
      db.query(
        `INSERT OR REPLACE INTO context7_cache (cache_key, payload_json, created_at) VALUES (?1, ?2, ?3)`,
      ).run(cacheKey, JSON.stringify(wrapped), Date.now());
      return wrapped;
    }
  } catch {
    // Fallback
  }
  return {
    ok: false,
    source: "context7-offline",
    libraryId: options.libraryId,
  };
}
