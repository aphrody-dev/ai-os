import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getSovereignEnv } from "../env.ts";
import { syncBrainMemoriesAndSessions } from "../nexus/brain-memory.ts";
import {
  redactSecretsFromText,
  resolveCanonicalAdcPath,
} from "../nexus/security.ts";

export type TriadAgentId =
  "claude" | "codex" | "agy" | "gemini" | "pi-opencode" | "ai-os";

export interface BinaryInfo {
  id: string;
  label: string;
  executable: string;
  shimPath?: string;
  installed: boolean;
  version: string;
  configDir: string;
}

export interface ProviderAuthStatus {
  provider: string;
  label: string;
  ready: boolean;
  mechanism: string;
  envStatus: string;
  credentialStore: string;
  details: string;
}

export interface TriadRunRequest {
  prompt: string;
  systemPrompt?: string;
  agent?: TriadAgentId;
  model?: string;
  cwd?: string;
  outputFormat?: "text" | "json" | "stream-json";
  mcpConfigPath?: string;
  worktree?: string | boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  mode?: "accept-edits" | "auto" | "plan";
  review?: boolean;
  timeoutMs?: number;
}

export interface TriadRunResult {
  ok: boolean;
  agent: TriadAgentId | string;
  model: string;
  output: string;
  structured?: unknown;
  exitCode: number;
  durationMs: number;
  quotaLimited?: boolean;
  fallbackTrail?: string[];
  error?: string;
}

export interface CouncilConsensusReport {
  prompt: string;
  agents: TriadAgentId[];
  succeededCount: number;
  totalDurationMs: number;
  findings: Array<{
    agent: TriadAgentId;
    ok: boolean;
    durationMs: number;
    output: string;
    error?: string;
  }>;
  consensusSummary: string;
}

export interface UnifiedSyncReport {
  updatedFiles: string[];
  backupsCreated: string[];
  soulPaths: string[];
  brainIndexPath: string;
  importedMemories: number;
  indexedSessions: number;
}

const QUOTA_ERROR_RE =
  /(rate[ _-]?limit|429|quota|insufficient_quota|credit balance|too many requests|resource_exhausted|overloaded)/i;

export function redactSecret(value: string | undefined | null): string {
  if (!value || value.length === 0) return "UNSET";
  return `SET [redacted, len=${value.length}]`;
}

export function computePkceChallengeS256(codeVerifier: string): string {
  const hashB64 = Bun.CryptoHasher.hash("sha256", codeVerifier, "base64");
  return hashB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generatePkcePair(byteLength = 32): {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
} {
  const clamped = Math.max(32, Math.min(96, byteLength));
  const bytes = new Uint8Array(clamped);
  crypto.getRandomValues(bytes);
  const codeVerifier = toBase64Url(bytes);
  return {
    codeVerifier,
    codeChallenge: computePkceChallengeS256(codeVerifier),
    codeChallengeMethod: "S256",
  };
}

export function resolveCodexExecutable(home = homedir()): string {
  if (process.platform !== "win32") {
    const candidate = join(home, ".local", "bin", "codex");
    return existsSync(candidate) ? candidate : "codex";
  }
  const localAppData =
    process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const primary = join(
    localAppData,
    "Programs",
    "OpenAI",
    "Codex",
    "bin",
    "codex.exe",
  );
  if (existsSync(primary)) return primary;

  const vscodeExtRoot = join(home, ".vscode", "extensions");
  if (existsSync(vscodeExtRoot)) {
    try {
      const matches = readdirSync(vscodeExtRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("openai.chatgpt-"))
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const extDir of matches) {
        const candidate = join(
          vscodeExtRoot,
          extDir,
          "bin",
          "windows-x86_64",
          "codex.exe",
        );
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Ignore
    }
  }
  const shim = join(home, ".local", "bin", "codex.cmd");
  return existsSync(shim) ? shim : primary;
}

export function resolveBinaryCatalog(home = homedir()): Record<
  string,
  {
    label: string;
    executable: string;
    shimPath?: string;
    configDir: string;
    versionArgs: string[];
  }
> {
  const isWin = process.platform === "win32";
  const localBin = join(home, ".local", "bin");
  const localAppData =
    process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");

  return {
    claude: {
      label: "Anthropic Claude Code",
      executable: isWin
        ? join(localBin, "claude.exe")
        : join(localBin, "claude"),
      configDir: join(home, ".claude"),
      versionArgs: ["--version"],
    },
    codex: {
      label: "OpenAI Codex CLI (Rust)",
      executable: resolveCodexExecutable(home),
      shimPath: isWin ? join(localBin, "codex.cmd") : undefined,
      configDir: join(home, ".codex"),
      versionArgs: ["--version"],
    },
    agy: {
      label: "Google Antigravity CLI",
      executable: isWin
        ? join(localAppData, "agy", "bin", "agy.exe")
        : join(localBin, "agy"),
      shimPath: isWin ? join(localBin, "agy.cmd") : undefined,
      configDir: join(home, ".gemini", "antigravity-cli"),
      versionArgs: ["--version"],
    },
    gemini: {
      label: "Google Gemini CLI",
      executable: isWin
        ? join(home, ".bun", "bin", "gemini.exe")
        : join(home, ".bun", "bin", "gemini"),
      configDir: join(home, ".gemini"),
      versionArgs: ["--version"],
    },
    aios: {
      label: "Sovereign AI-OS (Sole AI & MCP Owner)",
      executable: isWin ? join(localBin, "ai-os.exe") : join(localBin, "ai-os"),
      configDir: isWin ? "C:\\src\\packages\\ai-os" : "/src/packages/ai-os",
      versionArgs: ["version"],
    },
    nie: {
      label: "Rose Griffon NIE RE & Engine CLI (Rust)",
      executable: isWin ? join(localBin, "nie.exe") : join(localBin, "nie"),
      configDir: isWin ? "C:\\src\\apps\\rosegriffon" : "/src/apps/rosegriffon",
      versionArgs: ["--version"],
    },
    ie: {
      label: "Rose Griffon Unified Bun CLI (ie/rg)",
      executable: isWin ? join(localBin, "ie.cmd") : join(localBin, "ie"),
      configDir: isWin ? "C:\\src\\apps\\rosegriffon" : "/src/apps/rosegriffon",
      versionArgs: ["--version"],
    },
  };
}

export function runCommandCapture(
  cmd: string[],
  options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const proc = Bun.spawnSync(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: options?.cwd,
      env: options?.env ?? (process.env as Record<string, string>),
      timeout: options?.timeoutMs ?? 15000,
    });
    const dec = new TextDecoder();
    return {
      exitCode: proc.exitCode,
      stdout: dec.decode(proc.stdout).trim(),
      stderr: dec.decode(proc.stderr).trim(),
    };
  } catch (err) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

export function discoverBinaries(home = homedir()): BinaryInfo[] {
  const catalog = resolveBinaryCatalog(home);
  return Object.entries(catalog).map(([id, spec]) => {
    const installed = existsSync(spec.executable);
    let version = "not-installed";
    if (installed) {
      const res = runCommandCapture([spec.executable, ...spec.versionArgs], {
        timeoutMs: 6000,
      });
      version =
        (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() ||
        `exit=${res.exitCode}`;
    }
    return {
      id,
      label: spec.label,
      executable: spec.executable,
      shimPath: spec.shimPath,
      installed,
      version,
      configDir: spec.configDir,
    };
  });
}

function inspectJsonKeysOnly(filePath: string): {
  exists: boolean;
  sizeBytes: number;
  topKeys: string[];
} {
  if (!existsSync(filePath))
    return { exists: false, sizeBytes: 0, topKeys: [] };
  try {
    const st = statSync(filePath);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    return { exists: true, sizeBytes: st.size, topKeys: Object.keys(parsed) };
  } catch {
    return { exists: true, sizeBytes: 0, topKeys: ["<protected>"] };
  }
}

export async function inspectCrossAuthStatus(options?: {
  home?: string;
  envFilePath?: string;
  skipCliProbes?: boolean;
}): Promise<ProviderAuthStatus[]> {
  const home = options?.home ?? homedir();
  const env = getSovereignEnv(options?.envFilePath);
  const { adcPath } = resolveCanonicalAdcPath(home);

  const claudeCredPath = join(home, ".claude", ".credentials.json");
  const claudeCred = inspectJsonKeysOnly(claudeCredPath);
  const anthropicKey = env.get("ANTHROPIC_API_KEY");

  const codexAuthPath = join(home, ".codex", "auth.json");
  const codexCred = inspectJsonKeysOnly(codexAuthPath);
  const openAiKey = env.get("OPENAI_API_KEY");

  const agyStatePath = join(
    home,
    ".gemini",
    "antigravity-cli",
    "jetski_state.pbtxt",
  );
  const adcInfo = inspectJsonKeysOnly(adcPath);
  const geminiKey = env.get("GEMINI_API_KEY") ?? env.get("GOOGLE_API_KEY");

  const ghToken = env.get("GITHUB_TOKEN") ?? env.get("GH_TOKEN");
  let ghCliAuthed = false;
  if (!options?.skipCliProbes) {
    ghCliAuthed =
      runCommandCapture(["gh", "auth", "status"], { timeoutMs: 3500 })
        .exitCode === 0;
  }

  return [
    {
      provider: "claude",
      label: "Anthropic Claude Code",
      ready: claudeCred.exists || Boolean(anthropicKey),
      mechanism: claudeCred.exists ? "OAuth2 Credentials" : "ANTHROPIC_API_KEY",
      envStatus: `ANTHROPIC_API_KEY=${redactSecret(anthropicKey)}`,
      credentialStore: claudeCred.exists
        ? `present (${claudeCred.topKeys.join(",")})`
        : "absent",
      details: claudeCred.exists
        ? `sections=[${claudeCred.topKeys.join(", ")}]`
        : "unconfigured",
    },
    {
      provider: "codex",
      label: "OpenAI Codex CLI",
      ready: codexCred.exists || Boolean(openAiKey),
      mechanism: codexCred.exists
        ? "OAuth2 PKCE / Device Auth"
        : "OPENAI_API_KEY",
      envStatus: `OPENAI_API_KEY=${redactSecret(openAiKey)}`,
      credentialStore: codexCred.exists ? "present" : "absent",
      details: codexCred.exists
        ? `keys=[${codexCred.topKeys.join(", ")}]`
        : "env-key-fallback",
    },
    {
      provider: "antigravity-gemini",
      label: "Google Antigravity, Gemini & Keyless ADC",
      ready: existsSync(agyStatePath) || adcInfo.exists || Boolean(geminiKey),
      mechanism: adcInfo.exists
        ? "Keyless Google ADC + Antigravity Session"
        : "GEMINI_API_KEY",
      envStatus: `GEMINI_API_KEY=${redactSecret(geminiKey)}`,
      credentialStore: `adc=${adcInfo.exists ? "present" : "absent"}, agy=${existsSync(agyStatePath) ? "present" : "absent"}`,
      details: `project=${env.get("GOOGLE_CLOUD_PROJECT") ?? "aphrody"}`,
    },
    {
      provider: "github",
      label: "GitHub Forge & Keyless Public Sync",
      ready: true,
      mechanism: ghCliAuthed
        ? "gh keyring OAuth + Keyless REST"
        : ghToken
          ? "GITHUB_TOKEN + Keyless REST"
          : "Keyless Public REST",
      envStatus: `GITHUB_TOKEN=${redactSecret(ghToken)}`,
      credentialStore: ghCliAuthed ? "gh-cli:authenticated" : "keyless-ready",
      details: "Public orgs sync works 100% keyless",
    },
  ];
}

export function buildAgentCommand(
  agent: "claude" | "codex" | "agy" | "gemini",
  req: TriadRunRequest,
  home = homedir(),
): string[] {
  const catalog = resolveBinaryCatalog(home);
  const fullPrompt = req.systemPrompt
    ? `${req.systemPrompt}\n\n${req.prompt}`
    : req.prompt;
  const fmt = req.outputFormat ?? "json";

  switch (agent) {
    case "claude": {
      const args = [
        catalog.claude!.executable,
        "-p",
        fullPrompt,
        "--output-format",
        fmt,
      ];
      if (req.model) args.push("--model", req.model);
      if (req.mcpConfigPath) args.push("--mcp-config", req.mcpConfigPath);
      if (req.effort) args.push("--effort", req.effort);
      if (req.worktree) {
        args.push("--worktree");
        if (typeof req.worktree === "string") args.push(req.worktree);
      }
      return args;
    }
    case "codex": {
      const args = [catalog.codex!.executable];
      if (req.review) {
        args.push("exec", "review");
      } else {
        args.push("exec", fullPrompt, "--json", "--skip-git-repo-check");
      }
      if (req.model) args.push("-m", req.model);
      if (req.cwd) args.push("-C", req.cwd);
      return args;
    }
    case "agy": {
      const args = [
        catalog.agy!.executable,
        "-p",
        fullPrompt,
        "--output-format",
        fmt,
        "--mode",
        req.mode ?? "accept-edits",
      ];
      if (req.model) args.push("--model", req.model);
      if (req.effort) args.push("--effort", req.effort);
      return args;
    }
    case "gemini": {
      const args = [catalog.gemini!.executable, "-p", fullPrompt, "-o", fmt];
      if (req.model) args.push("-m", req.model);
      return args;
    }
  }
}

export async function runCliSubprocess(
  agent: "claude" | "codex" | "agy" | "gemini",
  req: TriadRunRequest,
  home = homedir(),
): Promise<TriadRunResult> {
  const started = Date.now();
  const cmd = buildAgentCommand(agent, req, home);
  const exe = cmd[0]!;
  if (!existsSync(exe)) {
    return {
      ok: false,
      agent,
      model: req.model ?? agent,
      output: "",
      exitCode: 127,
      durationMs: Date.now() - started,
      error: `Executable not found: ${exe}`,
    };
  }

  getSovereignEnv();
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: req.cwd ?? process.cwd(),
    env: process.env as Record<string, string>,
  });

  const timeoutMs = req.timeoutMs ?? 90_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).bytes(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const dec = new TextDecoder();
  const rawOut = dec.decode(stdoutBytes).trim();
  const rawErr = dec.decode(stderrBytes).trim();
  const quotaLimited = QUOTA_ERROR_RE.test(`${rawOut}\n${rawErr}`);

  let text = rawOut;
  let structured: unknown;
  if (rawOut.startsWith("{")) {
    try {
      const parsed = JSON.parse(rawOut) as Record<string, unknown>;
      structured = parsed;
      text = String(
        parsed.result ??
          parsed.response ??
          parsed.output ??
          parsed.text ??
          rawOut,
      );
    } catch {
      // NDJSON fallback
    }
  }

  const ok = !timedOut && exitCode === 0 && text.length > 0;
  return {
    ok,
    agent,
    model: req.model ?? `${agent}-default`,
    output: redactSecretsFromText(text),
    structured,
    exitCode: timedOut ? 124 : exitCode,
    durationMs: Date.now() - started,
    quotaLimited,
    error: ok
      ? undefined
      : timedOut
        ? `Timed out after ${timeoutMs}ms`
        : redactSecretsFromText(rawErr || `Exited with code ${exitCode}`),
  };
}

export async function runAgent(
  agent: TriadAgentId,
  req: TriadRunRequest,
): Promise<TriadRunResult> {
  if (
    agent === "claude" ||
    agent === "codex" ||
    agent === "agy" ||
    agent === "gemini"
  ) {
    return runCliSubprocess(agent, req);
  }
  const started = Date.now();
  const url =
    agent === "ai-os"
      ? "http://127.0.0.1:4318/v1/chat/completions"
      : "http://127.0.0.1:8787/v1/chat/completions";
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model ?? "ai-os/sovereign-local",
        messages: [{ role: "user", content: req.prompt }],
      }),
      signal: AbortSignal.timeout(req.timeoutMs ?? 15000),
    });
    if (!resp.ok) {
      return {
        ok: false,
        agent,
        model: req.model ?? agent,
        output: "",
        exitCode: resp.status,
        durationMs: Date.now() - started,
        quotaLimited: resp.status === 429,
        error: `HTTP ${resp.status}`,
      };
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return {
      ok: true,
      agent,
      model: req.model ?? agent,
      output: redactSecretsFromText(data.choices?.[0]?.message?.content ?? ""),
      exitCode: 0,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      agent,
      model: req.model ?? agent,
      output: "",
      exitCode: 503,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function routeTask(
  req: TriadRunRequest,
  options?: {
    chain?: readonly string[];
    executor?: (backend: string, r: TriadRunRequest) => Promise<TriadRunResult>;
  },
): Promise<TriadRunResult> {
  const chain = Array.from(
    new Set(
      options?.chain ??
        (req.agent
          ? [req.agent, "agy", "claude", "codex", "ai-os"]
          : ["agy", "claude", "codex", "ai-os"]),
    ),
  );
  const trail: string[] = [];
  const exec =
    options?.executor ??
    ((b: string, r: TriadRunRequest) => runAgent(b as TriadAgentId, r));
  let last: TriadRunResult | undefined;
  for (const backend of chain) {
    const res = await exec(backend, req);
    if (res.ok) {
      trail.push(`${backend}:ok`);
      return { ...res, fallbackTrail: trail };
    }
    trail.push(
      `${backend}:${res.quotaLimited ? "quota-429" : `err-${res.exitCode}`}`,
    );
    last = res;
  }
  return {
    ...(last ?? {
      ok: false,
      agent: "none",
      model: "none",
      output: "",
      exitCode: 503,
      durationMs: 0,
    }),
    fallbackTrail: trail,
  };
}

export async function runCouncil(
  prompt: string,
  agents: TriadAgentId[] = ["codex", "agy", "claude"],
  options?: {
    cwd?: string;
    timeoutMs?: number;
    executor?: (
      agent: TriadAgentId,
      req: TriadRunRequest,
    ) => Promise<TriadRunResult>;
  },
): Promise<CouncilConsensusReport> {
  const started = Date.now();
  const exec = options?.executor ?? runAgent;
  const findings = await Promise.all(
    agents.map(async (agent) => {
      const res = await exec(agent, {
        prompt,
        cwd: options?.cwd,
        timeoutMs: options?.timeoutMs ?? 60_000,
      });
      return {
        agent,
        ok: res.ok,
        durationMs: res.durationMs,
        output: res.output,
        error: res.error,
      };
    }),
  );
  const succeeded = findings.filter((f) => f.ok).length;
  const lines = [
    `# Triad Council Consensus (${succeeded}/${findings.length} agents responded)`,
    "",
    ...findings.flatMap((f) => [
      `## [${f.agent.toUpperCase()}] (${f.ok ? "OK" : "FAILED"}, ${f.durationMs}ms)`,
      f.ok ? f.output : `Error: ${f.error ?? "unknown"}`,
      "",
    ]),
  ];
  return {
    prompt,
    agents,
    succeededCount: succeeded,
    totalDurationMs: Date.now() - started,
    findings,
    consensusSummary: lines.join("\n").trim(),
  };
}

function backupOnce(filePath: string, backups: string[]): void {
  if (!existsSync(filePath)) return;
  const bak = `${filePath}.aios.bak`;
  if (!existsSync(bak)) {
    copyFileSync(filePath, bak);
    backups.push(bak);
  }
}

function stripLeadingComments(raw: string): {
  header: string;
  body: string;
} {
  const lines = raw.split(/\r?\n/);
  const headerLines: string[] = [];
  let idx = 0;
  while (idx < lines.length && lines[idx]!.trim().startsWith("//")) {
    headerLines.push(lines[idx]!);
    idx++;
  }
  return {
    header: headerLines.length > 0 ? `${headerLines.join("\n")}\n` : "",
    body: lines.slice(idx).join("\n"),
  };
}

const CODEX_START = "# >>> SOVEREIGN AI-TRIAD MANAGED START >>>";
const CODEX_END = "# <<< SOVEREIGN AI-TRIAD MANAGED END <<<";

/**
 * Configures `ai-os` (`C:/Users/aphro/.local/bin/ai-os.exe mcp-stdio`) as the SINGLE
 * context-optimized MCP server across Antigravity CLI/App, Gemini CLI, Claude Code,
 * Codex CLI, OpenCode, Pi, and Zed, while syncing canonical SOUL.md, Brain, and Sessions.
 */
export function syncUnifiedAgentHomes(options?: {
  home?: string;
  srcRoot?: string;
  mcpProfile?: "default" | "minimal";
}): UnifiedSyncReport {
  const home = options?.home ?? homedir();
  const srcRoot =
    options?.srcRoot ?? (process.platform === "win32" ? "C:\\src" : "/src");
  const mcpArgs =
    options?.mcpProfile === "minimal"
      ? ["mcp-stdio", "--profile", "minimal"]
      : ["mcp-stdio"];

  const updatedFiles: string[] = [];
  const backupsCreated: string[] = [];

  const brainSync = syncBrainMemoriesAndSessions({ home });
  const { adcPath } = resolveCanonicalAdcPath(home);
  const adcNorm = adcPath.replace(/\\/g, "/");

  // 1. Antigravity CLI, Antigravity Config & Gemini CLI -> SINGLE unified `ai-os` MCP
  const agyTargets = [
    join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
    join(home, ".gemini", "config", "mcp_config.json"),
    join(home, ".gemini", "settings.json"),
  ];

  for (const p of agyTargets) {
    mkdirSync(dirname(p), { recursive: true });
    backupOnce(p, backupsCreated);
    const existing = existsSync(p)
      ? (() => {
          try {
            return JSON.parse(readFileSync(p, "utf8")) as Record<
              string,
              unknown
            >;
          } catch {
            return {};
          }
        })()
      : {};
    existing.mcpServers = {
      "ai-os": {
        command: "C:/Users/aphro/.local/bin/ai-os.exe",
        args: mcpArgs,
        env: {
          GOOGLE_CLOUD_PROJECT: "aphrody",
          GOOGLE_APPLICATION_CREDENTIALS: adcNorm,
        },
      },
    };
    writeFileSync(p, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    updatedFiles.push(p);
  }

  // 2. Claude Code (~/.claude/mcp_sovereign.json & ~/.claude.json) -> SINGLE unified `ai-os` MCP
  const claudeMcpPath = join(home, ".claude", "mcp_sovereign.json");
  mkdirSync(dirname(claudeMcpPath), { recursive: true });
  const singleClaudeMcp = {
    "ai-os": {
      type: "stdio",
      command: "C:/Users/aphro/.local/bin/ai-os.exe",
      args: mcpArgs,
      env: {
        GOOGLE_CLOUD_PROJECT: "aphrody",
        GOOGLE_APPLICATION_CREDENTIALS: adcNorm,
      },
    },
  };
  writeFileSync(
    claudeMcpPath,
    `${JSON.stringify({ mcpServers: singleClaudeMcp }, null, 2)}\n`,
    "utf8",
  );
  updatedFiles.push(claudeMcpPath);

  const claudeRootPath = join(home, ".claude.json");
  if (existsSync(claudeRootPath)) {
    backupOnce(claudeRootPath, backupsCreated);
    try {
      const rootObj = JSON.parse(
        readFileSync(claudeRootPath, "utf8"),
      ) as Record<string, unknown>;
      rootObj.mcpServers = singleClaudeMcp;
      writeFileSync(
        claudeRootPath,
        `${JSON.stringify(rootObj, null, 2)}\n`,
        "utf8",
      );
      updatedFiles.push(claudeRootPath);
    } catch {
      // Ignore malformed file
    }
  }

  // 3. Codex (~/.codex/config.toml) -> SINGLE unified `ai_os` MCP
  const codexConfigPath = join(home, ".codex", "config.toml");
  mkdirSync(dirname(codexConfigPath), { recursive: true });
  backupOnce(codexConfigPath, backupsCreated);
  const existingCodex = existsSync(codexConfigPath)
    ? readFileSync(codexConfigPath, "utf8")
    : "";
  const codexBlock = `${CODEX_START}
[mcp_servers.ai_os]
command = "C:/Users/aphro/.local/bin/ai-os.exe"
args = ${JSON.stringify(mcpArgs)}

[model_providers.sovereign_aios]
name = "Sovereign AI-OS Unified Control Plane"
base_url = "http://127.0.0.1:4318/v1"
wire_api = "responses"

[model_providers.ring3_cuda]
name = "Ring-3 Sovereign CUDA sm_89 Daemon"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
${CODEX_END}`;

  const sIdx = existingCodex.indexOf(CODEX_START);
  const eIdx = existingCodex.indexOf(CODEX_END);
  const nextCodex =
    sIdx >= 0 && eIdx > sIdx
      ? [
          existingCodex.slice(0, sIdx).trimEnd(),
          codexBlock,
          existingCodex.slice(eIdx + CODEX_END.length).trimStart(),
        ]
          .filter(Boolean)
          .join("\n\n") + "\n"
      : existingCodex.trim()
        ? `${existingCodex.trim()}\n\n${codexBlock}\n`
        : `${codexBlock}\n`;
  writeFileSync(codexConfigPath, nextCodex, "utf8");
  updatedFiles.push(codexConfigPath);

  // 4. OpenCode (~/.config/opencode/opencode.jsonc) -> unified `ai_os` MCP
  const opencodePath = join(home, ".config", "opencode", "opencode.jsonc");
  if (existsSync(opencodePath)) {
    backupOnce(opencodePath, backupsCreated);
    try {
      const { header, body } = stripLeadingComments(
        readFileSync(opencodePath, "utf8"),
      );
      const oc = JSON.parse(body) as Record<string, unknown>;
      oc.mcp = {
        ai_os: {
          type: "local",
          command: ["C:/Users/aphro/.local/bin/ai-os.exe", ...mcpArgs],
          enabled: true,
        },
      };
      writeFileSync(
        opencodePath,
        `${header}${JSON.stringify(oc, null, 2)}\n`,
        "utf8",
      );
      updatedFiles.push(opencodePath);
    } catch {
      // Ignore
    }
  }

  // 5. Zed (%APPDATA%/Zed/settings.json) -> unified `ai-os` context server
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const zedPath = join(appData, "Zed", "settings.json");
  if (existsSync(zedPath)) {
    backupOnce(zedPath, backupsCreated);
    try {
      const { header, body } = stripLeadingComments(
        readFileSync(zedPath, "utf8"),
      );
      const zed = JSON.parse(body) as Record<string, unknown>;
      zed.context_servers = {
        "ai-os": {
          source: "custom",
          enabled: true,
          command: {
            path: "C:/Users/aphro/.local/bin/ai-os.exe",
            args: mcpArgs,
            env: {
              GOOGLE_CLOUD_PROJECT: "aphrody",
              GOOGLE_APPLICATION_CREDENTIALS: adcNorm,
            },
          },
        },
      };
      writeFileSync(
        zedPath,
        `${header}${JSON.stringify(zed, null, 2)}\n`,
        "utf8",
      );
      updatedFiles.push(zedPath);
    } catch {
      // Ignore
    }
  }

  // 6. Update root GEMINI.md & CLAUDE.md while preserving graphify instructions
  const rootGeminiMd = join(srcRoot, "GEMINI.md");
  writeFileSync(
    rootGeminiMd,
    `# C:\\src Sovereign Monorepo — Google Antigravity & Gemini Contract (\`GEMINI.md\`)

See [\`AGENTS.md\`](./AGENTS.md) and [\`.agents/SOUL.md\`](./.agents/SOUL.md) for the canonical operating contract.

## Canonical Workspace Layout & Single AI Ownership
- \`packages/ai-os\`: **Sole AI & MCP Owner** of the monorepo (\`ai-os.exe mcp-stdio\`), unifying AI-Triad, Skills, Brain, Memory, Sessions, Soul, Google Cloud (\`gcloud\`), Workspace (\`gws\`), Grounded Search, Context7, GitHub, Figma, CUDA \`sm_89\`, and \`n2b\` REA/Replica.
- \`packages/agy\`: Keyless Google AI Ecosystem hub (5-Org Depot + Gitingest, Gemma 4 JAX/CUDA/Torch lab, DeepMind Notebooks, Open NotebookLM, Google AI Ultra FinOps rentabilisation, Web App, and Dual Mode \`minimal\` vs \`fullstack\`).
- \`apps/\`: Production platforms (\`apps/aphrody\`, \`apps/shenron\`, \`apps/rosegriffon\`).
- \`crates/\`: Native Rust systems crates (\`crates/ring3-agent\`, \`crates/bench\`, \`crates/depot\`, \`crates/xtask\`).
- \`infra/\`: Go 1.27 + Cloudflare/OVH/GCP deployment & WireGuard/MASQUE mesh (\`infra/mesh-vn\`).

## Mandatory Verification & Rules
- Always run \`bun fmt\`, \`bun check\`, and \`bun test\`.
- Never modify \`C:\\Windows\\System32\`; userland binaries belong in \`C:\\Users\\aphro\\.local\\bin\`.
- Never print, log, or commit raw secrets from \`C:\\src\\.env\`. Zero emojis anywhere.
- Use \`graphify\` first when \`graphify-out/\` exists for architectural graph queries.
`,
    "utf8",
  );
  updatedFiles.push(rootGeminiMd);

  return {
    updatedFiles,
    backupsCreated,
    soulPaths: brainSync.soulPaths,
    brainIndexPath: brainSync.brainIndexPath,
    importedMemories: brainSync.importedMemories,
    indexedSessions: brainSync.indexedSessions,
  };
}
