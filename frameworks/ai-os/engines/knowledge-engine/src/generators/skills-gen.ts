import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  redactSecretsFromText,
  scanTextForEmojis,
  stripEmojis,
} from "../env/safe-env.ts";

export interface GeneratedSkillDescriptor {
  name: string;
  skillMdPath: string;
  referenceFiles: string[];
  discoveryTokens: number;
  fullActivationTokens: number;
  progressiveSavingsPct: number;
}

export interface SkillsGenReport {
  skillsRootDir: string;
  generatedSkills: GeneratedSkillDescriptor[];
  durationMs: number;
}

export interface SkillsGenOptions {
  srcRoot?: string;
  skillsRootDir?: string;
}

interface SkillBlueprint {
  name: string;
  description: string;
  bodyMarkdown: string;
  references: Array<{ filename: string; content: string }>;
}

const SKILL_BLUEPRINTS: readonly SkillBlueprint[] = [
  {
    name: "context7-deep-research",
    description:
      "Mandatory upstream API grounding via Context7 v2 SQLite cache, 5-channel parallel deep research (ske research), and deterministic multi-evidence fact checking (ske factcheck) before writing or reviewing code.",
    bodyMarkdown: `# Context7, Deep Research & Deterministic Fact-Checker (\`ske\`)

Activate this skill before implementing unfamiliar upstream APIs, auditing architectural Markdown plans, or citing external library behavior in \`C:\\aphrody\`.

## Core Workflow

1. **Resolve & Query Official Docs via Context7**:
   - Prefer MCP tools \`ctx7_query_docs\` (from \`knowledge-engine\`) or \`resolve-library-id\` / \`query-docs\` (from \`context7\`).
   - CLI equivalent:
     \`\`\`powershell
     ske research "Bun v1.4.4 bun:ffi dlopen and Context7 MCP"
     \`\`\`
2. **Multi-Hop Deep Research (\`ske research\`)**:
   - Fans out in parallel across Context7 v2, Exa Neural Search, GitHub Live API, Kernel.org/Freedesktop GitLab, and local \`C:\\aphrody\` lockfiles/manifests.
   - Emits Blake3-deduplicated dossiers into \`C:\\aphrody\\docs\\research\\<slug>.md\`.
3. **Deterministic Fact-Checking (\`ske factcheck\`)**:
   - Verifies \`file:///C:/...\` links, \`~/.local/bin\` binaries, \`src.lock.json\` versions, GitHub repo liveness, Context7 symbols, secret hygiene, \`C:\\Windows\\System32\` non-mutation, and zero-emoji compliance:
     \`\`\`powershell
     ske factcheck C:/aphrody/README.md
     \`\`\`

## Progressive Disclosure Reference
- Detailed MCP JSON-RPC schemas, SQLite WAL cache tables, and authority tier ranking rules: see [\`references/protocol-and-tiers.md\`](./references/protocol-and-tiers.md).
`,
    references: [
      {
        filename: "protocol-and-tiers.md",
        content: `# Context7 v2 & Knowledge-Engine Protocol Reference

## REST & Cache Architecture
- **Search Endpoint**: \`GET https://context7.com/api/v2/libs/search?libraryName=<name>&query=<q>\`
- **Context Endpoint**: \`GET https://context7.com/api/v2/context?libraryId=<id>&query=<q>&type=txt\`
- **SQLite WAL Store**: \`C:\\aphrody\\var\\knowledge.sqlite\` (\`context7_cache\` table keyed by \`rs_blake3_hex\` via \`rust_stack_ffi.dll\`, 24h TTL).
- **Secret Hygiene**: \`CTX7_API_KEY\`, \`EXA_API_KEY\`, and \`GITHUB_TOKEN\` are loaded in-memory from \`C:\\aphrody\\.env\` via \`@aphrody/env-kit\` and never written to editor JSON/TOML config files.

## Source Authority Tiers
1. **Tier 1**: Official Specifications (WHATWG, W3C, MCP \`2025-03-26\`, \`kernel.org\`), Context7 Official Docs, and Local Verified \`C:\\aphrody\` Lockfiles.
2. **Tier 2**: Upstream GitHub / Freedesktop GitLab Canonical Repositories & Release Tags.
3. **Tier 3**: Exa Neural Web Search Highlights.
`,
      },
    ],
  },
  {
    name: "ai-triad-orchestrator",
    description:
      "Orchestrate OpenAI Codex CLI, Google Antigravity CLI (agy/gemini), and Anthropic Claude Code via @aphrody/ai-triad (triad CLI, :4319 multi-protocol gateway, parallel Council consensus, OAuth 2.1 PKCE, and sync-configs).",
    bodyMarkdown: `# Sovereign AI Triad Orchestrator (\`Codex + AGY + Claude\`)

Activate this skill when coordinating multi-agent tasks, running parallel code reviews across OpenAI/Google/Anthropic models, or synchronizing MCP/provider configurations across AI editors.

## Primary Commands (\`%USERPROFILE%\\.local\\bin\\triad.exe\`)

1. **Verify Readiness & Auth Hygiene**:
   \`\`\`powershell
   triad doctor --no-color
   triad auth-status --fast
   \`\`\`
2. **Synchronize All Client Configs Idempotently**:
   Updates Antigravity CLI, Gemini CLI, Codex (\`~/.codex/config.toml\`), Claude Code (\`~/.claude.json\`, \`mcp_sovereign.json\`), OpenCode, and Zed with \`ai-os\`, \`ai-triad\`, \`context7\`, and \`knowledge-engine\`:
   \`\`\`powershell
   triad sync-configs
   \`\`\`
3. **Headless Delegation & Parallel Council Consensus**:
   \`\`\`powershell
   triad ask codex "Audit memory layout of FFI struct"
   triad council "Verify SQLite WAL concurrency and hook latency < 40ms"
   \`\`\`

## Progressive Disclosure Reference
- Gateway HTTP routes (\`:4319\`), quota-aware fallback chains, and MCP tool schemas: see [\`references/gateway-and-council.md\`](./references/gateway-and-council.md).
`,
    references: [
      {
        filename: "gateway-and-council.md",
        content: `# AI Triad Gateway (:4319) & MCP Federation

## Multi-Protocol Endpoints (\`http://127.0.0.1:4319\`)
- \`POST /v1/chat/completions\` — OpenAI Chat Completions wire translation (\`triad/auto\`, \`triad/claude\`, \`triad/codex\`, \`triad/agy\`, \`triad/council\`).
- \`POST /v1/responses\` — OpenAI Responses API for Codex custom \`model_providers\`.
- \`POST /v1/messages\` — Anthropic Messages v1 wire translation.
- \`POST /mcp\` & \`triad mcp-stdio\` — MCP \`2025-03-26\` server exposing \`triad_ask_claude\`, \`triad_ask_codex\`, \`triad_ask_agy\`, \`triad_council_review\`, and \`triad_auth_status\`.

## Automatic Quota Fallback
\`routeTask\` automatically detects HTTP \`429\` / \`resource_exhausted\` responses and fails over across \`agy -> claude -> codex\` without dropping context.
`,
      },
    ],
  },
  {
    name: "rust-stack-sovereign",
    description:
      "Build, serve, and bind the 100% Pure-Rust Sovereign Stack (C:\\aphrody\\crates\\rust-stack): Better-Auth (Argon2id, OAuth2.1 PKCE, Ed25519 JWKS), shadcn_rs zero-JS SSR/Dioxus/GPUI components, native Open-WebUI, Rust coding agent, OpenAI Gateway (:4320), and 228ns rust_stack_ffi.dll.",
    bodyMarkdown: `# Pure-Rust Sovereign Stack & \`rust_stack_ffi.dll\`

Activate this skill when working on authentication, zero-JS SSR UI components (\`shadcn_rs\`), high-throughput LLM gateway caching (\`:4320\`), or sub-microsecond Bun <-> Rust C-ABI FFI.

## Execution & Verification

1. **Launch Unified Rust Server (\`:4320\`)**:
   \`\`\`powershell
   rust-stack serve
   \`\`\`
2. **Run Cargo & Bun FFI Verification**:
   \`\`\`powershell
   cargo test --manifest-path C:\\aphrody\\crates\\rust-stack\\Cargo.toml
   bun test C:\\aphrody\\crates\\rust-stack\\ffi_verify.test.ts
   \`\`\`
3. **Bun v1.4.4 \`bun:ffi\` Binding Contract**:
   Always pass \`FFIType.u64\` (with \`BigInt(byteLength)\`) for Rust \`usize\` parameters so \`bun check\` and 64-bit Windows MS-x64 ABI match cleanly.

## Progressive Disclosure Reference
- Full C-ABI symbol signatures (\`rs_blake3_hex\`, \`rs_auth_issue_jwt\`, \`rs_auth_verify_jwt\`, \`rs_ui_render_card\`) and crate module layout: see [\`references/ffi-and-modules.md\`](./references/ffi-and-modules.md).
`,
    references: [
      {
        filename: "ffi-and-modules.md",
        content: `# \`rust_stack_ffi.dll\` C-ABI Export Table

Located at \`%USERPROFILE%\\.local\\bin\\rust_stack_ffi.dll\` (compiled with \`opt-level = 3\`, \`lto = "fat"\`, \`codegen-units = 1\`, \`panic = "abort"\`).

| Exported Symbol | Signature | Purpose |
| :--- | :--- | :--- |
| \`rs_abi_version\` | \`() -> u32\` | Returns ABI contract version (\`1\`) |
| \`rs_blake3_hex\` | \`(ptr: *const u8, len: usize, out: *mut u8, out_cap: usize) -> i32\` | Writes 64-byte lowercase hex Blake3 digest (~228 ns/call) |
| \`rs_auth_issue_jwt\` | \`(sub: *const u8, sub_len: usize, secret: *const u8, sec_len: usize, ttl_secs: u64, out: *mut u8, out_cap: usize) -> i32\` | Issues signed HMAC-SHA256 JWT |
| \`rs_auth_verify_jwt\` | \`(tok: *const u8, tok_len: usize, secret: *const u8, sec_len: usize) -> i32\` | Constant-time signature + expiry verification (\`1\` valid, \`0\` invalid) |
| \`rs_ui_render_card\` | \`(title: *const u8, t_len: usize, body: *const u8, b_len: usize, out: *mut u8, out_cap: usize) -> i32\` | Renders HTML-escaped \`shadcn_rs\` SSR card |
`,
      },
    ],
  },
  {
    name: "go-infra-oneclick-deploy",
    description:
      "Deploy any Bun, Rust, Go, or WASM/WebGPU app in C:\\aphrody via Go 1.27 src-deploy / dpl: daemonless OCI v1.1 image builds, Caddy HTTP/3 blue/green across fr1/fr2 and Google-only usa egress, Cloudflare DNS/Workers/R2 S3v4, and 3-way Rust <-> Bun <-> Go FFI (infra_go.dll).",
    bodyMarkdown: `# Go 1.27 One-Click Deploy & Three-Way FFI (\`src-deploy\` / \`dpl\`)

Activate this skill when packaging OCI v1.1 container images without a Docker daemon, generating HTTP/3 \`Caddyfile\` and \`systemd\` units, uploading assets to Cloudflare R2, or calling \`infra_go.dll\` via FFI.

## Standard CLI Workflows (\`dpl\` / \`src-deploy\`)

1. **Environment & Fleet Readiness**:
   \`\`\`powershell
   dpl doctor
   dpl detect C:\\aphrody\\apps\\web
   \`\`\`
2. **Generate Deployment Plan & HTTP/3 Caddyfile**:
   \`\`\`powershell
   dpl plan --all --out C:\\aphrody\\infra\\generated\\deploy-plan.json
   dpl caddyfile --out C:\\aphrody\\infra\\generated\\Caddyfile
   \`\`\`
3. **Dry-Run or Live Fleet Rollout**:
   \`\`\`powershell
   dpl up --all --dry-run
   \`\`\`

## Regional Egress Invariant
- \`fr1\` (\`203.0.113.1\`) and \`fr2\` (\`203.0.113.2\`) host production European workloads with HTTP/3 Blue/Green failover.
- \`usa\` (\`203.0.113.3\`) is strictly pinned to Google/Gemini API egress; non-Google workloads are rejected deterministically.

## Progressive Disclosure Reference
- OCI v1.1 layout details, R2 \`AWS4-HMAC-SHA256\` signing, and \`infra_go.dll\` C-shared exports: see [\`references/oci-fleet-and-ffi.md\`](./references/oci-fleet-and-ffi.md).
`,
    references: [
      {
        filename: "oci-fleet-and-ffi.md",
        content: `# Go Infra OCI v1.1, Fleet Routing & \`infra_go.dll\` FFI

## Daemonless OCI v1.1 Packaging (\`C:\\aphrody\\infra\\internal\\oci\`)
Writes deterministic \`oci-layout\`, \`index.json\`, config blobs, and tar layers directly to \`blobs/sha256/*\` without requiring \`dockerd\`, plus supports Windows Named Pipe \`\\\\.\\pipe\\docker_engine\` and SSH tunnel pushes when a daemon is present.

## Zig 0.17 CGO Shared Library (\`%USERPROFILE%\\.local\\bin\\infra_go.dll\`)
- \`GoInfraVersion()\` — ABI version string.
- \`GoDetectProjectJSON(path)\` — Framework & regional topology classification.
- \`GoSignR2S3v4AuthHeader(...)\` — Pure-Go Cloudflare R2 S3v4 signature generator.
- \`GoComputeOciDigest(buffer)\` — Deterministic SHA-256 OCI layer digest.
- Tested end-to-end across Rust, Bun, and Go in \`C:\\aphrody\\infra\\ffi-bridge\\polyglot.test.ts\`.
`,
      },
    ],
  },
  {
    name: "agy-continuous-reviewer",
    description:
      "Audit historical and live Antigravity CLI (agy) sessions via ske review-sessions, ske watch, and C:\\aphrody\\.agents\\hooks.json (PreToolUse, PostToolUse, Stop) for broken file:/// links, failed commands, emoji violations, secret leaks, and System32 safety.",
    bodyMarkdown: `# Continuous AGY Session Reviewer & Lifecycle Hooks

Activate this skill when auditing \`agy\` transcripts (\`transcript.jsonl\`), configuring \`.agents/hooks.json\`, or running real-time workspace quality gates.

## Commands (\`ske\`)

1. **Incremental Full-Brain Session Audit (\`< 30ms\` cached)**:
   Scans \`%USERPROFILE%\\.gemini\\antigravity-cli\\brain\\*\\.system_generated\\logs\\transcript.jsonl\` and writes \`C:\\aphrody\\docs\\AGY_SESSIONS_CONTINUOUS_REVIEW.md\` + \`C:\\aphrody\\var\\reports\\agy-sessions-audit.json\`:
   \`\`\`powershell
   ske review-sessions
   \`\`\`
2. **Continuous Watcher Loop**:
   Incrementally audits active transcripts, fact-checks modified \`C:\\aphrody\\docs\\*.md\` and \`SKILL.md\` files, and refreshes \`MONOREPO_ATLAS.md\`:
   \`\`\`powershell
   ske watch --interval 30
   ske watch --once
   \`\`\`

## Antigravity \`hooks.json\` Contract Invariants
- \`PreToolUse\` (\`pre-tool-guard.ts\`): Returns \`{"decision":"allow"}\` or \`{"decision":"deny","reason":"..."}\`. Blocks \`C:\\Windows\\System32\` mutations, raw \`.env\` git staging, and raw token commits.
- \`PostToolUse\` (\`post-tool-tracker.ts\`): Logs turn events to \`C:\\aphrody\\var\\knowledge.sqlite\` (\`live_turn_events\`) in \`< 15ms\` and returns \`{}\`.
- \`Stop\` (\`stop-session-reviewer.ts\`): Audits the active turn in \`< 40ms\`, appends to \`continuous-review-stream.jsonl\`, and returns \`{"decision":"stop"}\` (or \`{"decision":"continue","reason":"..."}\` strictly when \`terminationReason === "NO_TOOL_CALL"\`, \`executionNum <= 1\`, and a critical safety violation occurred).

## Progressive Disclosure Reference
- Transcript JSONL schema and SQLite incremental indexing columns: see [\`references/transcript-schema-and-hooks.md\`](./references/transcript-schema-and-hooks.md).
`,
    references: [
      {
        filename: "transcript-schema-and-hooks.md",
        content: `# AGY \`transcript.jsonl\` Schema & Incremental SQLite Index

## JSONL Step Record Fields
Each line in \`brain/<conversation-id>/.system_generated/logs/transcript.jsonl\` contains:
- \`step_index\`: Monotonic 0-based integer step index.
- \`source\`: \`"USER"\` | \`"MODEL"\` | \`"SYSTEM"\`.
- \`type\`: \`"USER_INPUT"\` | \`"PLANNER_RESPONSE"\` | \`"SYSTEM_MESSAGE"\` | \`"GENERIC"\`.
- \`status\`: \`"DONE"\` | \`"ERROR"\` | \`"CANCELLED"\`.
- \`tool_calls\`: Optional array of \`{ name: string, args: Record<string, unknown> }\` (including \`invoke_subagent\`, \`run_command\`, \`write_file\`, \`edit_file\`, \`call_mcp_tool\`).
- \`input_tokens\`, \`output_tokens\`, \`cache_read_tokens\`.

## Incremental Indexing (\`agy_session_reviews\`)
Keyed by \`session_id\` storing \`transcript_mtime_ms\`, \`transcript_size\`, and \`artifacts_sig\`. Unchanged sessions bypass disk reads completely, keeping full 47+ session re-audits under \`30 ms\`.
`,
      },
    ],
  },
];

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

export function validateSkillMarkdownStrict(
  raw: string,
  filePath: string,
): { valid: boolean; name: string; description: string; error?: string } {
  if (scanTextForEmojis(raw).length > 0) {
    return {
      valid: false,
      name: "",
      description: "",
      error: `Emoji violation in ${filePath}`,
    };
  }
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    return {
      valid: false,
      name: "",
      description: "",
      error: `Missing YAML frontmatter fence in ${filePath}`,
    };
  }
  const fm = fmMatch[1]!;
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
  const description = descMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";

  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return {
      valid: false,
      name,
      description,
      error: `Invalid skill name "${name}" in ${filePath}`,
    };
  }
  if (!description || description.length < 20) {
    return {
      valid: false,
      name,
      description,
      error: `Missing or too-short description in ${filePath}`,
    };
  }
  return { valid: true, name, description };
}

export function generateWorkspaceSkills(
  options: SkillsGenOptions = {},
): SkillsGenReport {
  const t0 = Bun.nanoseconds();
  const srcRoot =
    options.srcRoot ?? (process.platform === "win32" ? "C:\\aphrody" : "/src");
  const skillsRootDir = resolve(
    options.skillsRootDir ?? join(srcRoot, ".agents", "skills"),
  );

  const generatedSkills: GeneratedSkillDescriptor[] = [];

  for (const bp of SKILL_BLUEPRINTS) {
    const skillDir = join(skillsRootDir, bp.name);
    const refsDir = join(skillDir, "references");
    mkdirSync(refsDir, { recursive: true });

    const skillMdContent = stripEmojis(
      redactSecretsFromText(
        `---\nname: ${bp.name}\ndescription: "${bp.description.replace(/"/g, '\\"')}"\n---\n\n${bp.bodyMarkdown.trim()}\n`,
      ),
    );

    const validation = validateSkillMarkdownStrict(
      skillMdContent,
      join(skillDir, "SKILL.md"),
    );
    if (!validation.valid) {
      throw new Error(validation.error ?? `Failed to validate ${bp.name}`);
    }

    const skillMdPath = join(skillDir, "SKILL.md");
    writeFileSync(skillMdPath, skillMdContent, "utf8");

    const writtenRefs: string[] = [];
    let totalRefChars = 0;
    for (const ref of bp.references) {
      const refPath = join(refsDir, ref.filename);
      mkdirSync(dirname(refPath), { recursive: true });
      const cleanRef = stripEmojis(
        redactSecretsFromText(`${ref.content.trim()}\n`),
      );
      writeFileSync(refPath, cleanRef, "utf8");
      writtenRefs.push(refPath);
      totalRefChars += cleanRef.length;
    }

    const discoveryTokens = estimateTokens(
      bp.name.length + bp.description.length + 8,
    );
    const fullActivationTokens = estimateTokens(
      skillMdContent.length + totalRefChars,
    );
    const progressiveSavingsPct = Number(
      ((1 - discoveryTokens / fullActivationTokens) * 100).toFixed(2),
    );

    generatedSkills.push({
      name: bp.name,
      skillMdPath,
      referenceFiles: writtenRefs,
      discoveryTokens,
      fullActivationTokens,
      progressiveSavingsPct,
    });
  }

  const durationMs = (Bun.nanoseconds() - t0) / 1e6;
  return {
    skillsRootDir,
    generatedSkills,
    durationMs,
  };
}
