import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getLibraryDocs, searchLibraries } from "../context7/client.ts";
import { openKnowledgeDatabase } from "../db/sqlite.ts";
import {
  getSecretKeyValue,
  redactSecretsFromText,
  scanTextForEmojis,
  scanTextForSecretLeaks,
} from "../env/safe-env.ts";
import { blake3Hex } from "../ffi/blake3.ts";

export type ClaimVerdictStatus =
  "VERIFIED" | "CONTRADICTED" | "UNVERIFIED_NEEDS_CITATION";

export interface ClaimDiagnostic {
  category:
    | "filesystem_path"
    | "local_binary"
    | "manifest_version"
    | "upstream_repo"
    | "context7_api_symbol"
    | "safety_secret_hygiene"
    | "safety_system32"
    | "safety_zero_emoji";
  claim: string;
  status: ClaimVerdictStatus;
  line: number;
  citation: string;
  detail: string;
}

export interface FactCheckVerdict {
  target: string;
  isFileTarget: boolean;
  verdict: ClaimVerdictStatus;
  confidence: number;
  summary: string;
  totals: {
    claimsChecked: number;
    verified: number;
    contradicted: number;
    unverified: number;
  };
  diagnostics: ClaimDiagnostic[];
  checkedAt: string;
  durationMs: number;
}

export interface FactCheckOptions {
  srcRoot?: string;
  localBinDir?: string;
  envPath?: string;
  dbPath?: string;
  fetchImpl?: typeof fetch;
  skipNetwork?: boolean;
}

const PLANNED_BLUEPRINT_MARKERS =
  /\b(blueprint|planned|proposed|target\s+architecture|implementation\s+planning|example|clean-room\s+rewrite)\b/i;

const KNOWN_GITHUB_OWNERS = new Set([
  "oven-sh",
  "microsoft",
  "dotnet",
  "hyperlight-dev",
  "tokio-rs",
  "cloudflare",
  "vercel",
  "vercel-labs",
  "anthropics",
  "openai",
  "google",
  "google-gemini",
  "modelcontextprotocol",
  "zed-industries",
  "DioxusLabs",
  "gfx-rs",
  "rust-lang",
  "caddyserver",
  "whatwg",
  "torvalds",
  "aphrody-labs",
]);

function normalizeTargetFileCandidate(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith("file:///")) {
    const stripped = decodeURIComponent(trimmed.slice(8)).replace(/\//g, "\\");
    if (existsSync(stripped)) return resolve(stripped);
  }
  if (
    trimmed.length < 260 &&
    !trimmed.includes("\n") &&
    (existsSync(trimmed) || /^[A-Za-z]:[/\\]/.test(trimmed))
  ) {
    if (existsSync(trimmed)) return resolve(trimmed);
  }
  return null;
}

function extractLineNumberForMatch(lines: string[], needle: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(needle)) {
      return i + 1;
    }
  }
  return 1;
}

function checkSafetyInvariants(
  text: string,
  targetLabel: string,
  envPath?: string,
): ClaimDiagnostic[] {
  const diags: ClaimDiagnostic[] = [];

  // 1. Secret hygiene
  const leaks = scanTextForSecretLeaks(text, envPath);
  if (leaks.length === 0) {
    diags.push({
      category: "safety_secret_hygiene",
      claim: "Zero raw secret values from C:\\aphrody\\.env or bearer tokens",
      status: "VERIFIED",
      line: 1,
      citation: `file:///${(envPath ?? "C:/aphrody/.env").replace(/\\/g, "/")}`,
      detail:
        "Verified 0 raw secret literals or unredacted API tokens present.",
    });
  } else {
    for (const leak of leaks.slice(0, 5)) {
      diags.push({
        category: "safety_secret_hygiene",
        claim: `Secret hygiene violation (${leak.keyOrPattern})`,
        status: "CONTRADICTED",
        line: leak.line,
        citation: targetLabel,
        detail: `Detected unredacted ${leak.kind} (${leak.keyOrPattern}) at line ${leak.line}.`,
      });
    }
  }

  // 2. C:\Windows\System32 mutation check
  const lines = text.split(/\r?\n/);
  let sys32MutationLine = 0;
  const destructiveSys32Pattern =
    /\b(rm|del|Remove-Item|Move-Item|Copy-Item|Set-Content|Out-File|writeFileSync)\b[^\r\n]*c:[/\\]windows[/\\]system32/i;
  for (let i = 0; i < lines.length; i++) {
    if (destructiveSys32Pattern.test(lines[i]!)) {
      sys32MutationLine = i + 1;
      break;
    }
  }
  if (sys32MutationLine > 0) {
    diags.push({
      category: "safety_system32",
      claim: "Sacred C:\\Windows\\System32 userspace non-mutation",
      status: "CONTRADICTED",
      line: sys32MutationLine,
      citation: targetLabel,
      detail: `Destructive write/delete command targeting C:\\Windows\\System32 detected at line ${sys32MutationLine}.`,
    });
  } else {
    diags.push({
      category: "safety_system32",
      claim: "Sacred C:\\Windows\\System32 userspace non-mutation",
      status: "VERIFIED",
      line: 1,
      citation: "file:///C:/aphrody/.agents/scripts/pre-tool-guard.ts",
      detail: "Zero destructive mutations targeting C:\\Windows\\System32.",
    });
  }

  // 3. Zero-emoji policy
  const emojis = scanTextForEmojis(text);
  if (emojis.length === 0) {
    diags.push({
      category: "safety_zero_emoji",
      claim: "Strict zero-emoji invariant",
      status: "VERIFIED",
      line: 1,
      citation: targetLabel,
      detail: "Verified 0 emoji codepoints across entire content.",
    });
  } else {
    const first = emojis[0]!;
    diags.push({
      category: "safety_zero_emoji",
      claim: "Strict zero-emoji invariant",
      status: "CONTRADICTED",
      line: first.line,
      citation: targetLabel,
      detail: `Found ${emojis.length} emoji codepoint(s); first=${first.codePointHex} at line ${first.line}, col ${first.column}.`,
    });
  }

  return diags;
}

function checkFilesystemAndBinaryClaims(
  text: string,
  lines: string[],
  srcRoot: string,
  localBinDir: string,
  isBlueprintDoc: boolean,
): ClaimDiagnostic[] {
  const diags: ClaimDiagnostic[] = [];
  const seenPaths = new Set<string>();

  // 1. Explicit file:///C:/... links
  const fileUrlRegex = /file:\/\/\/([A-Za-z]:\/[^\s)"'`#>\]]+)/g;
  let m: RegExpExecArray | null = fileUrlRegex.exec(text);
  while (m !== null) {
    const rawPath = decodeURIComponent(m[1]!).replace(/\//g, "\\");
    const normKey = rawPath.toLowerCase();
    if (!seenPaths.has(normKey)) {
      seenPaths.add(normKey);
      const line = extractLineNumberForMatch(lines, m[0]);
      const exists = existsSync(rawPath);
      diags.push({
        category: "filesystem_path",
        claim: m[0],
        status: exists
          ? "VERIFIED"
          : isBlueprintDoc && rawPath.includes("<")
            ? "UNVERIFIED_NEEDS_CITATION"
            : "CONTRADICTED",
        line,
        citation: `file:///${rawPath.replace(/\\/g, "/")}`,
        detail: exists
          ? `Verified path exists on disk: ${rawPath}`
          : `Referenced file:/// path does not exist on disk: ${rawPath}`,
      });
    }
    m = fileUrlRegex.exec(text);
  }

  // 2. Direct C:\aphrody\... paths
  const winSrcRegex = /\b(C:\\aphrody\\[A-Za-z0-9_.\-\\/]+)\b/g;
  m = winSrcRegex.exec(text);
  while (m !== null) {
    const rawCandidate = m[1]!.replace(/[/]+/g, "\\").replace(/[.,;:]+$/, "");
    if (rawCandidate.includes("*") || rawCandidate.includes("<")) {
      m = winSrcRegex.exec(text);
      continue;
    }
    const normKey = rawCandidate.toLowerCase();
    if (!seenPaths.has(normKey)) {
      seenPaths.add(normKey);
      const line = extractLineNumberForMatch(lines, m[1]!);
      const exists = existsSync(rawCandidate);
      diags.push({
        category: "filesystem_path",
        claim: rawCandidate,
        status: exists
          ? "VERIFIED"
          : isBlueprintDoc
            ? "UNVERIFIED_NEEDS_CITATION"
            : "CONTRADICTED",
        line,
        citation: `file:///${rawCandidate.replace(/\\/g, "/")}`,
        detail: exists
          ? `Verified workspace path exists: ${rawCandidate}`
          : isBlueprintDoc
            ? `Planned blueprint path not yet materialized on disk: ${rawCandidate}`
            : `Workspace path missing on disk: ${rawCandidate}`,
      });
    }
    m = winSrcRegex.exec(text);
  }

  // 3. Exported CLI binaries / DLLs in ~/.local/bin
  const binRegex = /`([a-zA-Z0-9_-]+\.(?:exe|dll|cmd))`/g;
  const seenBins = new Set<string>();
  const systemDllAllowlist = new Set([
    "ucrtbase.dll",
    "ntdll.dll",
    "kernelbase.dll",
    "kernel32.dll",
    "msvcrt.dll",
    "cygwin1.dll",
    "msys-2.0.dll",
    "d3d12.dll",
    "dxcore.dll",
    "dxgi.dll",
    "opencl.dll",
    "vulkan-1.dll",
    "nvcuda.dll",
    "nvapi64.dll",
    "ntoskrnl.exe",
    "midlrt.exe",
    "cl.exe",
    "lld-link.exe",
    "nvidia-smi.exe",
    "nvcc.exe",
  ]);

  m = binRegex.exec(text);
  while (m !== null) {
    const binName = m[1]!;
    const lower = binName.toLowerCase();
    if (!seenBins.has(lower) && !systemDllAllowlist.has(lower)) {
      seenBins.add(lower);
      const candidateLocal = join(localBinDir, binName);
      const line = extractLineNumberForMatch(lines, binName);
      if (existsSync(candidateLocal)) {
        diags.push({
          category: "local_binary",
          claim: binName,
          status: "VERIFIED",
          line,
          citation: `file:///${candidateLocal.replace(/\\/g, "/")}`,
          detail: `Verified installed userland binary/library in ${candidateLocal}`,
        });
      } else {
        const whichResolved = Bun.which(binName.replace(/\.(exe|cmd)$/i, ""));
        if (whichResolved) {
          diags.push({
            category: "local_binary",
            claim: binName,
            status: "VERIFIED",
            line,
            citation: `file:///${whichResolved.replace(/\\/g, "/")}`,
            detail: `Resolved executable on PATH: ${whichResolved}`,
          });
        } else {
          diags.push({
            category: "local_binary",
            claim: binName,
            status: isBlueprintDoc
              ? "UNVERIFIED_NEEDS_CITATION"
              : "CONTRADICTED",
            line,
            citation: `file:///${localBinDir.replace(/\\/g, "/")}`,
            detail: `Binary/library ${binName} not found in ${localBinDir} or PATH.`,
          });
        }
      }
    }
    m = binRegex.exec(text);
  }

  // 4. Local toolchain & manifest version verification against src.lock.json / go.mod / Cargo.toml / package.json
  const lockPath = join(srcRoot, "src.lock.json");
  if (existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(readFileSync(lockPath, "utf8")) as {
        toolchains?: Record<string, string>;
      };
      const tc = lockData.toolchains ?? {};
      if (/\bBun\s+v?1\.4\.4\b/i.test(text) && tc.bun) {
        const matches =
          tc.bun.includes("1.4.4") || Bun.version.includes("1.4.4");
        diags.push({
          category: "manifest_version",
          claim: "Bun v1.4.4 runtime version",
          status: matches ? "VERIFIED" : "CONTRADICTED",
          line: extractLineNumberForMatch(lines, "1.4.4"),
          citation: `file:///${lockPath.replace(/\\/g, "/")}`,
          detail: `Verified Bun runtime=${Bun.version}, src.lock.json=${tc.bun}`,
        });
      }
      if (/\bGo\s+1\.27\b/i.test(text) && tc.go) {
        const matches = tc.go.includes("1.27");
        diags.push({
          category: "manifest_version",
          claim: "Go 1.27 toolchain version",
          status: matches ? "VERIFIED" : "CONTRADICTED",
          line: extractLineNumberForMatch(lines, "Go 1.27"),
          citation: `file:///${lockPath.replace(/\\/g, "/")}`,
          detail: `Verified Go toolchain in src.lock.json: "${tc.go}"`,
        });
      }
    } catch {
      // Ignore
    }
  }

  return diags;
}

async function checkUpstreamReposAndContext7(
  text: string,
  lines: string[],
  options: FactCheckOptions,
): Promise<ClaimDiagnostic[]> {
  if (options.skipNetwork) {
    return [];
  }

  const diags: ClaimDiagnostic[] = [];
  const fetchFn = options.fetchImpl ?? fetch;
  const ghToken = getSecretKeyValue("GITHUB_TOKEN", options.envPath);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "sovereign-knowledge-engine-factcheck/1.0",
  };
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }

  // Extract `owner/repo` claims matching well-known GitHub organizations or explicit github.com URLs
  const repoSet = new Set<string>();
  const explicitGhRegex = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;
  let m: RegExpExecArray | null = explicitGhRegex.exec(text);
  while (m !== null) {
    const cleaned = m[1]!.replace(/\.git$/i, "").replace(/[.,;:)]+$/, "");
    if (!cleaned.includes("*")) repoSet.add(cleaned);
    m = explicitGhRegex.exec(text);
  }

  const backtickRepoRegex = /`([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)`/g;
  m = backtickRepoRegex.exec(text);
  while (m !== null) {
    const owner = m[1]!;
    const repo = m[2]!;
    if (KNOWN_GITHUB_OWNERS.has(owner) && !repo.includes("*")) {
      repoSet.add(`${owner}/${repo}`);
    }
    m = backtickRepoRegex.exec(text);
  }

  const candidateRepos = Array.from(repoSet).slice(0, 8);
  await Promise.allSettled(
    candidateRepos.map(async (fullRepo) => {
      const line = extractLineNumberForMatch(lines, fullRepo);
      try {
        const res = await fetchFn(`https://api.github.com/repos/${fullRepo}`, {
          headers,
        });
        if (res.status === 404) {
          // Local/private org repos like aphrody-labs/* may be private or local-first
          if (fullRepo.startsWith("aphrody-labs/")) {
            diags.push({
              category: "upstream_repo",
              claim: `GitHub repo ${fullRepo}`,
              status: "UNVERIFIED_NEEDS_CITATION",
              line,
              citation: `https://github.com/${fullRepo}`,
              detail: `Private or local-first repository ${fullRepo} returned HTTP 404 with current token scope.`,
            });
            return;
          }
          diags.push({
            category: "upstream_repo",
            claim: `GitHub repo ${fullRepo}`,
            status: "CONTRADICTED",
            line,
            citation: `https://github.com/${fullRepo}`,
            detail: `GitHub API returned 404 Not Found for ${fullRepo}.`,
          });
          return;
        }
        if (!res.ok) {
          diags.push({
            category: "upstream_repo",
            claim: `GitHub repo ${fullRepo}`,
            status: "UNVERIFIED_NEEDS_CITATION",
            line,
            citation: `https://api.github.com/repos/${fullRepo}`,
            detail: `GitHub API returned HTTP ${res.status} while checking ${fullRepo}.`,
          });
          return;
        }
        const meta = (await res.json()) as {
          full_name?: string;
          default_branch?: string;
          archived?: boolean;
          html_url?: string;
        };
        diags.push({
          category: "upstream_repo",
          claim: `GitHub repo ${fullRepo}`,
          status: "VERIFIED",
          line,
          citation: meta.html_url ?? `https://github.com/${fullRepo}`,
          detail: `Verified upstream repo ${meta.full_name ?? fullRepo} (default_branch=${meta.default_branch ?? "main"}, archived=${Boolean(meta.archived)}).`,
        });
      } catch (err) {
        diags.push({
          category: "upstream_repo",
          claim: `GitHub repo ${fullRepo}`,
          status: "UNVERIFIED_NEEDS_CITATION",
          line,
          citation: `https://github.com/${fullRepo}`,
          detail: `Network probe skipped/failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
  );

  // Context7 API symbol accuracy check for Bun / WebGPU / Cloudflare claims
  const symbolChecks: Array<{
    regex: RegExp;
    libraryId: string;
    libraryName: string;
    symbolQuery: string;
    symbolToken: string;
  }> = [
    {
      regex: /\bbun:ffi\b|\bdlopen\b/,
      libraryId: "/oven-sh/bun",
      libraryName: "bun",
      symbolQuery: "bun:ffi dlopen FFIType",
      symbolToken: "dlopen",
    },
    {
      regex: /\bbun:sqlite\b/,
      libraryId: "/oven-sh/bun",
      libraryName: "bun",
      symbolQuery: "bun:sqlite Database WAL",
      symbolToken: "bun:sqlite",
    },
    {
      regex: /\bWebGPU\b.*\bsubgroups\b|\bwgpu\b/i,
      libraryId: "",
      libraryName: "wgpu",
      symbolQuery: "WebGPU subgroups RenderPipeline ComputePipeline",
      symbolToken: "Pipeline",
    },
  ];

  for (const sym of symbolChecks) {
    if (!sym.regex.test(text)) continue;
    const line = extractLineNumberForMatch(
      lines,
      text.match(sym.regex)?.[0] ?? sym.symbolToken,
    );
    try {
      let libId = sym.libraryId;
      if (!libId) {
        const searched = await searchLibraries(
          sym.libraryName,
          sym.symbolQuery,
          {
            dbPath: options.dbPath,
            envPath: options.envPath,
            fetchImpl: fetchFn,
          },
        );
        libId = searched.results[0]?.id ?? "";
      }
      if (!libId) continue;

      const docs = await getLibraryDocs(libId, sym.symbolQuery, 1500, {
        dbPath: options.dbPath,
        envPath: options.envPath,
        fetchImpl: fetchFn,
      });
      const matched = docs.rawText
        .toLowerCase()
        .includes(sym.symbolToken.toLowerCase());
      const topCitation =
        docs.chunks[0]?.sourceUrl ?? `https://context7.com${libId}`;
      diags.push({
        category: "context7_api_symbol",
        claim: `Context7 API symbol verification (${libId}: ${sym.symbolToken})`,
        status: matched ? "VERIFIED" : "UNVERIFIED_NEEDS_CITATION",
        line,
        citation: topCitation,
        detail: matched
          ? `Verified API symbol "${sym.symbolToken}" against official Context7 docs (${libId}).`
          : `Fetched Context7 docs (${libId}), symbol "${sym.symbolToken}" requires manual version pin check.`,
      });
    } catch {
      // Non-fatal if Context7 rate-limited or offline
    }
  }

  return diags;
}

/**
 * Deterministic Multi-Evidence Fact Checker (`ske factcheck <claim-or-file>`).
 * Verifies filesystem paths, `.local/bin` binaries, lockfile/manifest versions,
 * GitHub repository metadata, Context7 API symbols, and safety/secret/emoji invariants.
 */
export async function runFactCheck(
  claimOrFile: string,
  options: FactCheckOptions = {},
): Promise<FactCheckVerdict> {
  const t0 = Bun.nanoseconds();
  const srcRoot =
    options.srcRoot ?? (process.platform === "win32" ? "C:\\aphrody" : "/src");
  const localBinDir = options.localBinDir ?? join(homedir(), ".local", "bin");

  const resolvedFile = normalizeTargetFileCandidate(claimOrFile);
  const isFileTarget = resolvedFile !== null;
  const targetLabel = isFileTarget
    ? `file:///${resolvedFile.replace(/\\/g, "/")}`
    : claimOrFile.trim();

  const content = isFileTarget
    ? readFileSync(resolvedFile, "utf8")
    : claimOrFile;
  const lines = content.split(/\r?\n/);
  const isBlueprintDoc =
    PLANNED_BLUEPRINT_MARKERS.test(content.slice(0, 1500)) ||
    (resolvedFile?.toLowerCase().endsWith("_plan.md") ?? false);

  const safetyDiags = checkSafetyInvariants(
    content,
    targetLabel,
    options.envPath,
  );
  const fsDiags = checkFilesystemAndBinaryClaims(
    content,
    lines,
    srcRoot,
    localBinDir,
    isBlueprintDoc,
  );
  const upstreamDiags = await checkUpstreamReposAndContext7(
    content,
    lines,
    options,
  );

  const diagnostics = [...safetyDiags, ...fsDiags, ...upstreamDiags];

  const verified = diagnostics.filter((d) => d.status === "VERIFIED").length;
  const contradicted = diagnostics.filter(
    (d) => d.status === "CONTRADICTED",
  ).length;
  const unverified = diagnostics.filter(
    (d) => d.status === "UNVERIFIED_NEEDS_CITATION",
  ).length;
  const total = diagnostics.length;

  let verdict: ClaimVerdictStatus = "VERIFIED";
  if (contradicted > 0) {
    verdict = "CONTRADICTED";
  } else if (verified === 0 || (unverified > 0 && verified < unverified)) {
    verdict = "UNVERIFIED_NEEDS_CITATION";
  }

  const rawScore =
    total === 0
      ? 50
      : Math.round(
          ((verified * 1.0 + unverified * 0.65 - contradicted * 1.25) / total) *
            100,
        );
  const confidence = Math.max(0, Math.min(100, rawScore));
  const durationMs = (Bun.nanoseconds() - t0) / 1e6;
  const checkedAt = new Date().toISOString();

  const summary = redactSecretsFromText(
    `[${verdict}] confidence=${confidence}/100 across ${total} claims (${verified} verified, ${contradicted} contradicted, ${unverified} needs-citation) in ${durationMs.toFixed(1)}ms.`,
  );

  const result: FactCheckVerdict = {
    target: redactSecretsFromText(targetLabel),
    isFileTarget,
    verdict,
    confidence,
    summary,
    totals: {
      claimsChecked: total,
      verified,
      contradicted,
      unverified,
    },
    diagnostics: diagnostics.map((d) => ({
      ...d,
      claim: redactSecretsFromText(d.claim),
      detail: redactSecretsFromText(d.detail),
    })),
    checkedAt,
    durationMs,
  };

  try {
    const db = openKnowledgeDatabase(options.dbPath);
    const targetHash = blake3Hex(`${targetLabel}\n${blake3Hex(content)}`);
    db.prepare(
      `INSERT INTO factcheck_runs (
        target_hash, target_label, verdict, confidence, claims_total,
        verified_count, contradicted_count, unverified_count, report_json, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_hash) DO UPDATE SET
        verdict = excluded.verdict,
        confidence = excluded.confidence,
        claims_total = excluded.claims_total,
        verified_count = excluded.verified_count,
        contradicted_count = excluded.contradicted_count,
        unverified_count = excluded.unverified_count,
        report_json = excluded.report_json,
        checked_at = excluded.checked_at`,
    ).run(
      targetHash,
      result.target,
      result.verdict,
      result.confidence,
      total,
      verified,
      contradicted,
      unverified,
      JSON.stringify(result),
      checkedAt,
    );
  } catch {
    // Allow read-only/ephemeral execution even if SQLite write fails
  }

  return result;
}

export function formatFactCheckReportMarkdown(v: FactCheckVerdict): string {
  const lines: string[] = [
    `# Fact-Check Verdict: \`${v.verdict}\` (${v.confidence}/100)`,
    "",
    `- **Target**: \`${v.target}\``,
    `- **Checked At**: \`${v.checkedAt}\``,
    `- **Latency**: \`${v.durationMs.toFixed(1)} ms\``,
    `- **Totals**: \`${v.totals.claimsChecked}\` claims (\`VERIFIED=${v.totals.verified}\`, \`CONTRADICTED=${v.totals.contradicted}\`, \`UNVERIFIED_NEEDS_CITATION=${v.totals.unverified}\`)`,
    "",
    "| Line | Status | Category | Claim | Citation / Detail |",
    "| :--- | :--- | :--- | :--- | :--- |",
  ];

  for (const d of v.diagnostics) {
    const safeClaim = d.claim.replace(/\|/g, "/").slice(0, 80);
    const safeDetail = d.detail.replace(/\|/g, "/").slice(0, 140);
    lines.push(
      `| L${d.line} | \`${d.status}\` | \`${d.category}\` | \`${safeClaim}\` | ${safeDetail} ([ref](${d.citation})) |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
