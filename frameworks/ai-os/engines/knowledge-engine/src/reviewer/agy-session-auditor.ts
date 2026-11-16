import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openKnowledgeDatabase } from "../db/sqlite.ts";
import { runFactCheck } from "../factcheck/verifier.ts";
import { generateMonorepoDocs } from "../generators/docs-gen.ts";
import {
  redactSecretsFromText,
  scanTextForEmojis,
  scanTextForSecretLeaks,
  stripEmojis,
} from "../env/safe-env.ts";

export interface SessionAuditMetrics {
  sessionId: string;
  transcriptPath: string;
  hasTranscript: boolean;
  createdAt: string;
  lastTimestamp: string;
  totalSteps: number;
  inputTokens: number;
  outputTokens: number;
  toolCallsByType: Record<string, number>;
  mcpCallsCount: number;
  subagentsSpawned: string[];
  parentSenderId: string | null;
  failedCommandsCount: number;
  brokenFileLinks: string[];
  unverifiedClaimsCount: number;
  emojiViolationsCount: number;
  secretLeaksCount: number;
  system32ViolationsCount: number;
  artifactFiles: string[];
}

export interface GlobalSessionsAuditReport {
  generatedAt: string;
  brainRootDir: string;
  totalSessions: number;
  sessionsWithTranscripts: number;
  cacheHits: number;
  reindexedCount: number;
  durationMs: number;
  totals: {
    steps: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    mcpCalls: number;
    subagentsSpawned: number;
    failedCommands: number;
    brokenFileLinks: number;
    unverifiedClaims: number;
    emojiViolations: number;
    secretLeaks: number;
    system32Violations: number;
  };
  toolCallBreakdown: Record<string, number>;
  sessions: SessionAuditMetrics[];
  markdownReportPath: string;
  jsonLedgerPath: string;
}

export interface SessionAuditorOptions {
  brainRootDir?: string;
  srcRoot?: string;
  dbPath?: string;
  envPath?: string;
  markdownOutPath?: string;
  jsonOutPath?: string;
  sessionIdFilter?: string;
  limit?: number;
  writeOutputs?: boolean;
}

interface StoredSessionRow {
  session_id: string;
  transcript_mtime_ms: number;
  transcript_size: number;
  artifacts_sig: string;
  metrics_json: string;
}

interface TranscriptLineObj {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: Array<{
    name?: string;
    args?: Record<string, unknown>;
  }>;
}

function computeArtifactsSignature(sessionDir: string): {
  sig: string;
  mdFiles: string[];
} {
  const mdFiles: string[] = [];
  let entries;
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return { sig: "none", mdFiles };
  }
  const parts: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md")) {
      const full = join(sessionDir, e.name);
      mdFiles.push(full);
      try {
        const st = statSync(full);
        parts.push(`${e.name}:${st.size}:${Math.floor(st.mtimeMs)}`);
      } catch {
        parts.push(e.name);
      }
    }
  }
  parts.sort();
  return { sig: parts.join("|") || "none", mdFiles };
}

function extractBrokenFileLinks(text: string): string[] {
  const broken: string[] = [];
  const regex = /file:\/\/\/([A-Za-z]:\/[^\s)"'`#>\]]+)/g;
  let m: RegExpExecArray | null = regex.exec(text);
  while (m !== null) {
    const raw = decodeURIComponent(m[1]!).replace(/\//g, "\\");
    // Ignore template placeholders like <conversation-id> or /path/to/file
    if (
      !raw.includes("<") &&
      !raw.includes("*") &&
      !/\\path\\to\\/i.test(raw) &&
      !existsSync(raw)
    ) {
      broken.push(`file:///${raw.replace(/\\/g, "/")}`);
    }
    m = regex.exec(text);
  }
  return broken;
}

export function parseSingleSession(
  sessionId: string,
  sessionDir: string,
  transcriptPath: string,
  artifactMdFiles: string[],
  envPath?: string,
  incrementalStartByte = 0,
  baseMetrics?: SessionAuditMetrics,
): SessionAuditMetrics {
  const metrics: SessionAuditMetrics = baseMetrics
    ? {
        ...baseMetrics,
        toolCallsByType: { ...baseMetrics.toolCallsByType },
        subagentsSpawned: [...baseMetrics.subagentsSpawned],
        brokenFileLinks: [...baseMetrics.brokenFileLinks],
        artifactFiles: artifactMdFiles,
      }
    : {
        sessionId,
        transcriptPath,
        hasTranscript: existsSync(transcriptPath),
        createdAt: "",
        lastTimestamp: "",
        totalSteps: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolCallsByType: {},
        mcpCallsCount: 0,
        subagentsSpawned: [],
        parentSenderId: null,
        failedCommandsCount: 0,
        brokenFileLinks: [],
        unverifiedClaimsCount: 0,
        emojiViolationsCount: 0,
        secretLeaksCount: 0,
        system32ViolationsCount: 0,
        artifactFiles: artifactMdFiles,
      };

  let rawSlice = "";
  if (existsSync(transcriptPath)) {
    metrics.hasTranscript = true;
    const st = statSync(transcriptPath);
    if (incrementalStartByte > 0 && incrementalStartByte < st.size) {
      const len = st.size - incrementalStartByte;
      const buf = new Uint8Array(len);
      const fd = openSync(transcriptPath, "r");
      try {
        readSync(fd, buf, 0, len, incrementalStartByte);
      } finally {
        closeSync(fd);
      }
      rawSlice = new TextDecoder().decode(buf);
    } else if (incrementalStartByte === 0) {
      rawSlice = readFileSync(transcriptPath, "utf8");
    }
  }

  let lastModelResponseText = "";
  const brokenSet = new Set<string>(metrics.brokenFileLinks);
  const subagentSet = new Set<string>(metrics.subagentsSpawned);

  if (rawSlice.length > 0) {
    const lines = rawSlice.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let step: TranscriptLineObj;
      try {
        step = JSON.parse(trimmed) as TranscriptLineObj;
      } catch {
        continue;
      }

      metrics.totalSteps++;
      if (step.created_at) {
        if (!metrics.createdAt) metrics.createdAt = step.created_at;
        metrics.lastTimestamp = step.created_at;
      }
      if (typeof step.input_tokens === "number") {
        metrics.inputTokens += step.input_tokens;
      }
      if (typeof step.output_tokens === "number") {
        metrics.outputTokens += step.output_tokens;
      }

      const content = typeof step.content === "string" ? step.content : "";

      // Detect parent sender ID on initial SYSTEM_MESSAGE
      if (step.step_index === 0 && step.type === "SYSTEM_MESSAGE" && content) {
        const senderMatch = content.match(/\bsender=([0-9a-f-]{36})\b/i);
        if (senderMatch?.[1]) {
          metrics.parentSenderId = senderMatch[1];
        }
      }

      // Secret leak check across ALL transcript content
      if (content) {
        const secretFindings = scanTextForSecretLeaks(content, envPath);
        if (secretFindings.length > 0) {
          metrics.secretLeaksCount += secretFindings.length;
        }
      }

      // Failed command check
      if (
        step.status === "ERROR" ||
        (step.type === "GENERIC" &&
          /Command exited with code [1-9]\d*/.test(content))
      ) {
        metrics.failedCommandsCount++;
      }

      // Tool calls breakdown & System32 safety
      if (Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          const name = String(tc.name ?? "unknown");
          metrics.toolCallsByType[name] =
            (metrics.toolCallsByType[name] ?? 0) + 1;

          if (name === "call_mcp_tool" || name.startsWith("mcp_")) {
            metrics.mcpCallsCount++;
          }
          if (name === "invoke_subagent" || name.includes("subagent")) {
            const subName = String(
              tc.args?.Name ??
                tc.args?.AgentName ??
                tc.args?.SubagentName ??
                tc.args?.Recipient ??
                "subagent",
            );
            subagentSet.add(subName);
          }

          const argsStr = JSON.stringify(tc.args ?? {});
          if (scanTextForSecretLeaks(argsStr, envPath).length > 0) {
            metrics.secretLeaksCount++;
          }

          if (name === "write_file" || name === "edit_file") {
            const p = String(
              tc.args?.Path ?? tc.args?.path ?? "",
            ).toLowerCase();
            if (
              p.startsWith("c:\\windows\\system32") ||
              p.startsWith("c:/windows/system32")
            ) {
              metrics.system32ViolationsCount++;
            }
          } else if (name === "run_command") {
            const cmd = String(tc.args?.CommandLine ?? "");
            if (
              /\b(rm|del|Remove-Item|Move-Item|Set-Content|Out-File)\b[^\r\n]*c:[/\\]windows[/\\]system32/i.test(
                cmd,
              )
            ) {
              metrics.system32ViolationsCount++;
            }
          }
        }
      }

      if (step.type === "PLANNER_RESPONSE" && content) {
        lastModelResponseText = content;
      }
    }
  }

  // Audit final planner response + session Markdown artifacts for broken file:/// links, emojis, & unverified markers
  if (lastModelResponseText) {
    for (const bl of extractBrokenFileLinks(lastModelResponseText)) {
      brokenSet.add(bl);
    }
    metrics.emojiViolationsCount += scanTextForEmojis(
      lastModelResponseText,
    ).length;
    if (
      /\b(TODO:\s*verify|unverified\s+assumption)\b/i.test(
        lastModelResponseText,
      )
    ) {
      metrics.unverifiedClaimsCount++;
    }
  }

  if (incrementalStartByte === 0) {
    for (const mdPath of artifactMdFiles) {
      try {
        const mdText = readFileSync(mdPath, "utf8");
        for (const bl of extractBrokenFileLinks(mdText)) {
          brokenSet.add(bl);
        }
        metrics.emojiViolationsCount += scanTextForEmojis(mdText).length;
        metrics.secretLeaksCount += scanTextForSecretLeaks(
          mdText,
          envPath,
        ).length;
      } catch {
        // Ignore
      }
    }
  }

  metrics.brokenFileLinks = Array.from(brokenSet).slice(0, 20);
  metrics.subagentsSpawned = Array.from(subagentSet);
  return metrics;
}

function renderContinuousReviewMarkdown(
  report: GlobalSessionsAuditReport,
): string {
  const topTools = Object.entries(report.toolCallBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const lines: string[] = [
    "# Antigravity CLI (`agy`) Continuous Sessions Audit Report",
    "",
    `Generated by \`@aphrody/knowledge-engine\` (\`ske review-sessions\`) at \`${report.generatedAt}\`.`,
    "",
    "## 1. Global Fleet Telemetry & Hygiene Summary",
    "",
    "| Metric | Value | Status |",
    "| :--- | :--- | :--- |",
    `| **Total Brain Session Directories** | \`${report.totalSessions}\` (\`${report.sessionsWithTranscripts}\` with \`transcript.jsonl\`) | Indexed |`,
    `| **Incremental SQLite WAL Performance** | \`${report.durationMs.toFixed(2)} ms\` (\`${report.cacheHits}\` cached, \`${report.reindexedCount}\` parsed) | \`< 30ms\` warm target |`,
    `| **Total Planner & Tool Steps** | \`${report.totals.steps.toLocaleString()}\` | Active |`,
    `| **Total Token Volume (In / Out)** | \`${report.totals.inputTokens.toLocaleString()}\` in / \`${report.totals.outputTokens.toLocaleString()}\` out | Tracked |`,
    `| **Total Tool Invocations / MCP Calls** | \`${report.totals.toolCalls.toLocaleString()}\` tools (\`${report.totals.mcpCalls}\` MCP calls) | Active |`,
    `| **Raw \`C:\\aphrody\\.env\` Secret Leaks** | \`${report.totals.secretLeaks}\` | ${report.totals.secretLeaks === 0 ? "PASS (Zero Leaks)" : "ACTION REQUIRED"} |`,
    `| **\`C:\\Windows\\System32\` Mutations** | \`${report.totals.system32Violations}\` | ${report.totals.system32Violations === 0 ? "PASS (Sacred Userspace Intact)" : "CRITICAL VIOLATION"} |`,
    `| **Non-Zero / Error Tool Steps** | \`${report.totals.failedCommands}\` | Historical command retries |`,
    `| **Broken \`file:///\` Links in Outputs/Artifacts** | \`${report.totals.brokenFileLinks}\` | Tracked |`,
    `| **Emoji Occurrences in Final Responses/Artifacts** | \`${report.totals.emojiViolations}\` | Audited |`,
    "",
    "## 2. Tool Invocation Breakdown Across All Sessions",
    "",
    "| Tool Name | Invocation Count |",
    "| :--- | :--- |",
    ...topTools.map(([name, cnt]) => `| \`${name}\` | \`${cnt}\` |`),
    "",
    "## 3. Subagent Spawn Topology",
    "",
  ];

  const parentSessions = report.sessions.filter(
    (s) => s.subagentsSpawned.length > 0 || s.parentSenderId !== null,
  );
  if (parentSessions.length === 0) {
    lines.push("_No multi-agent subagent edges recorded yet._");
  } else {
    for (const s of parentSessions.slice(0, 25)) {
      const convLink = `[conversation://${s.sessionId.slice(0, 8)}](conversation://${s.sessionId})`;
      const parentPart = s.parentSenderId
        ? ` <- spawned by [\`${s.parentSenderId.slice(0, 8)}\`](conversation://${s.parentSenderId})`
        : "";
      const childPart =
        s.subagentsSpawned.length > 0
          ? ` -> spawned: ${s.subagentsSpawned.map((c) => `\`${c}\``).join(", ")}`
          : "";
      lines.push(`- ${convLink}${parentPart}${childPart}`);
    }
  }
  lines.push("");

  lines.push("## 4. Per-Session Clickable Audit Ledger");
  lines.push("");
  lines.push(
    "| Session | Transcript | Steps | Tools (MCP) | Failed Cmds | Broken Links | Emojis | Secrets | Last Activity |",
  );
  lines.push(
    "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
  );

  for (const s of report.sessions) {
    const convLink = `[\`${s.sessionId.slice(0, 8)}\`](conversation://${s.sessionId})`;
    const trLink = s.hasTranscript
      ? `[transcript.jsonl](file:///${s.transcriptPath.replace(/\\/g, "/")})`
      : "_empty_";
    const totalSessionTools = Object.values(s.toolCallsByType).reduce(
      (a, b) => a + b,
      0,
    );
    const lastTs = s.lastTimestamp ? s.lastTimestamp.slice(0, 19) : "-";
    lines.push(
      `| ${convLink} | ${trLink} | ${s.totalSteps} | ${totalSessionTools} (${s.mcpCallsCount}) | ${s.failedCommandsCount} | ${s.brokenFileLinks.length} | ${s.emojiViolationsCount} | ${s.secretLeaksCount} | \`${lastTs}\` |`,
    );
  }
  lines.push("");

  return stripEmojis(redactSecretsFromText(lines.join("\n")));
}

/**
 * Audits all AGY sessions in `%USERPROFILE%\.gemini\antigravity-cli\brain\*`
 * using an incremental SQLite WAL index (`agy_session_reviews` keyed by `mtimeMs` + `size`)
 * so warm re-runs across 47+ sessions complete in `< 30ms`.
 */
export function auditAllAgySessions(
  options: SessionAuditorOptions = {},
): GlobalSessionsAuditReport {
  const t0 = Bun.nanoseconds();
  const home = homedir();
  const srcRoot =
    options.srcRoot ?? (process.platform === "win32" ? "C:\\aphrody" : "/src");
  const brainRootDir = resolve(
    options.brainRootDir ?? join(home, ".gemini", "antigravity-cli", "brain"),
  );
  const markdownReportPath = resolve(
    options.markdownOutPath ??
      join(srcRoot, "docs", "AGY_SESSIONS_CONTINUOUS_REVIEW.md"),
  );
  const jsonLedgerPath = resolve(
    options.jsonOutPath ??
      join(srcRoot, "var", "reports", "agy-sessions-audit.json"),
  );
  const writeOutputs = options.writeOutputs ?? true;

  const db = openKnowledgeDatabase(options.dbPath);
  const cachedRows = db
    .prepare<StoredSessionRow, []>(
      "SELECT session_id, transcript_mtime_ms, transcript_size, artifacts_sig, metrics_json FROM agy_session_reviews",
    )
    .all();
  const cacheMap = new Map<string, StoredSessionRow>();
  for (const r of cachedRows) {
    cacheMap.set(r.session_id, r);
  }

  const upsertStmt = db.prepare(
    `INSERT INTO agy_session_reviews (
      session_id, transcript_path, transcript_mtime_ms, transcript_size,
      artifacts_sig, metrics_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      transcript_path = excluded.transcript_path,
      transcript_mtime_ms = excluded.transcript_mtime_ms,
      transcript_size = excluded.transcript_size,
      artifacts_sig = excluded.artifacts_sig,
      metrics_json = excluded.metrics_json,
      updated_at = excluded.updated_at`,
  );

  const sessions: SessionAuditMetrics[] = [];
  let cacheHits = 0;
  let reindexedCount = 0;
  const pendingUpserts: Array<{
    sessionId: string;
    transcriptPath: string;
    mtimeMs: number;
    size: number;
    artifactsSig: string;
    metricsJson: string;
    nowIso: string;
  }> = [];

  if (existsSync(brainRootDir)) {
    const entries = readdirSync(brainRootDir, { withFileTypes: true }).filter(
      (e) =>
        e.isDirectory() &&
        (!options.sessionIdFilter || e.name === options.sessionIdFilter),
    );

    for (const entry of entries) {
      const sessionId = entry.name;
      const sessionDir = join(brainRootDir, sessionId);
      const transcriptPath = join(
        sessionDir,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );

      let mtimeMs = 0;
      let size = 0;
      if (existsSync(transcriptPath)) {
        try {
          const st = statSync(transcriptPath);
          mtimeMs = st.mtimeMs;
          size = st.size;
        } catch {
          // Ignore
        }
      }

      const cached = cacheMap.get(sessionId);
      // Fast path: if transcript mtime & byte size match, check artifacts signature
      if (
        cached &&
        cached.transcript_size === size &&
        Math.abs(cached.transcript_mtime_ms - mtimeMs) < 1
      ) {
        const { sig } = computeArtifactsSignature(sessionDir);
        if (cached.artifacts_sig === sig) {
          try {
            sessions.push(
              JSON.parse(cached.metrics_json) as SessionAuditMetrics,
            );
            cacheHits++;
            continue;
          } catch {
            // Fall through to reparse
          }
        }
      }

      const { sig: artifactsSig, mdFiles } =
        computeArtifactsSignature(sessionDir);

      // Byte-offset incremental append path when transcript grew monotonically and artifacts unchanged
      let parsed: SessionAuditMetrics;
      if (
        cached &&
        size > cached.transcript_size &&
        cached.transcript_size > 0 &&
        cached.artifacts_sig === artifactsSig
      ) {
        try {
          const prev = JSON.parse(cached.metrics_json) as SessionAuditMetrics;
          parsed = parseSingleSession(
            sessionId,
            sessionDir,
            transcriptPath,
            mdFiles,
            options.envPath,
            cached.transcript_size,
            prev,
          );
        } catch {
          parsed = parseSingleSession(
            sessionId,
            sessionDir,
            transcriptPath,
            mdFiles,
            options.envPath,
          );
        }
      } else {
        parsed = parseSingleSession(
          sessionId,
          sessionDir,
          transcriptPath,
          mdFiles,
          options.envPath,
        );
      }

      reindexedCount++;
      sessions.push(parsed);
      pendingUpserts.push({
        sessionId,
        transcriptPath,
        mtimeMs,
        size,
        artifactsSig,
        metricsJson: redactSecretsFromText(JSON.stringify(parsed)),
        nowIso: new Date().toISOString(),
      });
    }
  }

  if (pendingUpserts.length > 0) {
    const commitBatch = db.transaction((items: typeof pendingUpserts) => {
      for (const item of items) {
        upsertStmt.run(
          item.sessionId,
          item.transcriptPath,
          item.mtimeMs,
          item.size,
          item.artifactsSig,
          item.metricsJson,
          item.nowIso,
        );
      }
    });
    commitBatch(pendingUpserts);
  }

  sessions.sort((a, b) =>
    (b.lastTimestamp || "").localeCompare(a.lastTimestamp || ""),
  );

  const limitedSessions = options.limit
    ? sessions.slice(0, options.limit)
    : sessions;

  const toolCallBreakdown: Record<string, number> = {};
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let mcpCalls = 0;
  let subagentsSpawned = 0;
  let failedCommands = 0;
  let brokenFileLinks = 0;
  let unverifiedClaims = 0;
  let emojiViolations = 0;
  let secretLeaks = 0;
  let system32Violations = 0;

  for (const s of limitedSessions) {
    steps += s.totalSteps;
    inputTokens += s.inputTokens;
    outputTokens += s.outputTokens;
    mcpCalls += s.mcpCallsCount;
    subagentsSpawned += s.subagentsSpawned.length;
    failedCommands += s.failedCommandsCount;
    brokenFileLinks += s.brokenFileLinks.length;
    unverifiedClaims += s.unverifiedClaimsCount;
    emojiViolations += s.emojiViolationsCount;
    secretLeaks += s.secretLeaksCount;
    system32Violations += s.system32ViolationsCount;
    for (const [tName, cnt] of Object.entries(s.toolCallsByType)) {
      toolCallBreakdown[tName] = (toolCallBreakdown[tName] ?? 0) + cnt;
      toolCalls += cnt;
    }
  }

  const durationMs = (Bun.nanoseconds() - t0) / 1e6;
  const report: GlobalSessionsAuditReport = {
    generatedAt: new Date().toISOString(),
    brainRootDir,
    totalSessions: limitedSessions.length,
    sessionsWithTranscripts: limitedSessions.filter((s) => s.hasTranscript)
      .length,
    cacheHits,
    reindexedCount,
    durationMs,
    totals: {
      steps,
      inputTokens,
      outputTokens,
      toolCalls,
      mcpCalls,
      subagentsSpawned,
      failedCommands,
      brokenFileLinks,
      unverifiedClaims,
      emojiViolations,
      secretLeaks,
      system32Violations,
    },
    toolCallBreakdown,
    sessions: limitedSessions,
    markdownReportPath,
    jsonLedgerPath,
  };

  if (writeOutputs) {
    mkdirSync(dirname(markdownReportPath), { recursive: true });
    mkdirSync(dirname(jsonLedgerPath), { recursive: true });
    writeFileSync(
      markdownReportPath,
      renderContinuousReviewMarkdown(report),
      "utf8",
    );
    writeFileSync(
      jsonLedgerPath,
      `${redactSecretsFromText(JSON.stringify(report, null, 2))}\n`,
      "utf8",
    );
  }

  return report;
}

export interface WatchCycleSummary {
  reindexedSessions: number;
  factCheckedFiles: string[];
  regeneratedAtlas: boolean;
  durationMs: number;
}

/**
 * Continuous Reviewer & Watcher (`ske watch [--interval 30] [--once]`).
 * 1. Incrementally audits modified AGY `transcript.jsonl` sessions,
 * 2. Fact-checks modified `C:\aphrody\docs\*.md` and `SKILL.md` files,
 * 3. Regenerates `MONOREPO_ATLAS.md` and `AGY_SESSIONS_CONTINUOUS_REVIEW.md` when changes occur.
 */
export async function runContinuousWatchLoop(options?: {
  intervalSeconds?: number;
  once?: boolean;
  srcRoot?: string;
  brainRootDir?: string;
  dbPath?: string;
}): Promise<WatchCycleSummary> {
  const srcRoot =
    options?.srcRoot ?? (process.platform === "win32" ? "C:\\aphrody" : "/src");
  const intervalMs = Math.max(2, options?.intervalSeconds ?? 30) * 1000;
  const seenDocMtimes = new Map<string, number>();

  const collectWatchedMarkdownFiles = (): string[] => {
    const out: string[] = [];
    const docsDir = join(srcRoot, "docs");
    if (existsSync(docsDir)) {
      for (const e of readdirSync(docsDir, { withFileTypes: true })) {
        if (
          e.isFile() &&
          e.name.endsWith(".md") &&
          e.name !== "MONOREPO_ATLAS.md" &&
          e.name !== "AGY_SESSIONS_CONTINUOUS_REVIEW.md"
        ) {
          out.push(join(docsDir, e.name));
        }
      }
    }
    const skillsDir = join(srcRoot, ".agents", "skills");
    if (existsSync(skillsDir)) {
      for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const sk = join(skillsDir, e.name, "SKILL.md");
          if (existsSync(sk)) out.push(sk);
        }
      }
    }
    return out;
  };

  const executeSinglePass = async (
    isFirstPass: boolean,
  ): Promise<WatchCycleSummary> => {
    const t0 = Bun.nanoseconds();
    const audit = auditAllAgySessions({
      srcRoot,
      brainRootDir: options?.brainRootDir,
      dbPath: options?.dbPath,
      writeOutputs: false,
    });

    const modifiedMd: string[] = [];
    for (const filePath of collectWatchedMarkdownFiles()) {
      try {
        const st = statSync(filePath);
        const prev = seenDocMtimes.get(filePath);
        if (prev === undefined) {
          seenDocMtimes.set(filePath, st.mtimeMs);
          if (isFirstPass) modifiedMd.push(filePath);
        } else if (st.mtimeMs > prev) {
          seenDocMtimes.set(filePath, st.mtimeMs);
          modifiedMd.push(filePath);
        }
      } catch {
        // Ignore
      }
    }

    for (const md of modifiedMd.slice(0, 6)) {
      await runFactCheck(md, {
        srcRoot,
        dbPath: options?.dbPath,
        skipNetwork: true,
      });
    }

    let regeneratedAtlas = false;
    if (isFirstPass || audit.reindexedCount > 0 || modifiedMd.length > 0) {
      auditAllAgySessions({
        srcRoot,
        brainRootDir: options?.brainRootDir,
        dbPath: options?.dbPath,
        writeOutputs: true,
      });
      if (modifiedMd.length > 0) {
        await generateMonorepoDocs({
          srcRoot,
          dbPath: options?.dbPath,
          enrichContext7: false,
        });
        regeneratedAtlas = true;
      }
    }

    return {
      reindexedSessions: audit.reindexedCount,
      factCheckedFiles: modifiedMd,
      regeneratedAtlas,
      durationMs: (Bun.nanoseconds() - t0) / 1e6,
    };
  };

  const firstSummary = await executeSinglePass(true);
  if (options?.once) {
    return firstSummary;
  }

  while (true) {
    await Bun.sleep(intervalMs);
    const cycle = await executeSinglePass(false);
    process.stdout.write(
      `[ske:watch] cycle=${cycle.durationMs.toFixed(1)}ms reindexed=${cycle.reindexedSessions} factchecked=${cycle.factCheckedFiles.length} regen=${cycle.regeneratedAtlas}\n`,
    );
  }
}
