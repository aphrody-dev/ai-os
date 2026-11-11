import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  getDesktopFfi,
  resolveBrowserCliPath,
  resolveDesktopCliPath,
  runBrowserCli,
  runDesktopCli,
} from "../ffi/desktop.ts";
import { getCudaFfi, getPolyglotFfi } from "../ffi/polyglot.ts";
import {
  buildCanonicalSoulMarkdown,
  DEFAULT_BRAIN_VAULT_DIR,
} from "../nexus/brain-memory.ts";
import { listActiveCollections } from "../nexus/skills-hub.ts";
import {
  executeUnifiedDomainTool,
  UNIFIED_DOMAIN_TOOLS,
} from "../nexus/unified-mcp.ts";
import {
  inspectPolyglotEcosystem,
  runPythonPolyglotScan,
} from "../polyglot/index.ts";
import { probeLocalProviders } from "../providers/federation.ts";
import { readCachedSentinelState, runSentinelSync } from "../sentinel/index.ts";
import { searchSkills } from "./skills.ts";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "desktop_snapshot",
    description:
      "Capture a native OS accessibility tree snapshot with interactive element refs via agent_desktop_ffi.dll (bun:ffi zero-copy) or agent-desktop.exe.",
    inputSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description:
            "Optional application title/process filter. Omit to snapshot focused surface.",
        },
        surface: {
          type: "integer",
          description: "AdSnapshotSurface discriminant (0=Window, 1=Focused).",
          default: 0,
        },
        maxDepth: {
          type: "integer",
          description: "Maximum accessibility tree traversal depth.",
          default: 6,
        },
        interactiveOnly: {
          type: "boolean",
          default: true,
        },
        compact: {
          type: "boolean",
          default: true,
        },
        statusOnly: {
          type: "boolean",
          description:
            "When true, calls fast ad_status permission & surface check without full UIA traversal.",
          default: false,
        },
      },
    },
  },
  {
    name: "desktop_action",
    description:
      "Execute a native desktop accessibility action by snapshot-qualified ref (@<snapshot_id>:eN) via agent_desktop_ffi.dll or CLI subcommand.",
    inputSchema: {
      type: "object",
      properties: {
        refId: {
          type: "string",
          description: "Snapshot-qualified element reference, e.g. @snap1:e3",
        },
        action: {
          type: "string",
          enum: [
            "click",
            "double_click",
            "right_click",
            "set_value",
            "set_focus",
            "type_text",
            "press_key",
            "hover",
            "clear",
          ],
          default: "click",
        },
        text: {
          type: "string",
          description:
            "Optional text payload for set_value / type_text / press_key.",
        },
        policy: {
          type: "integer",
          description: "0=Headless, 1=FocusFallback, 2=Headed",
          default: 0,
        },
        cliArgs: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional raw CLI arguments passed directly to agent-desktop.exe when refId is omitted.",
        },
      },
    },
  },
  {
    name: "browser_navigate",
    description:
      "Drive the Fat-LTO Rust CDP agent-browser.exe engine (open URL, inspect version/doctor, or run CDP subcommands).",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Target URL to open via agent-browser.",
        },
        command: {
          type: "string",
          description:
            "Optional agent-browser subcommand (e.g., 'open', 'doctor', '--version').",
          default: "open",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Additional CLI arguments.",
        },
      },
    },
  },
  {
    name: "browser_a11y_tree",
    description:
      "Extract semantic accessibility snapshot or run axe-core / wck validation via agent-browser.exe and C:\\src\\wck.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "Optional browser session name.",
        },
        interactiveOnly: {
          type: "boolean",
          default: true,
        },
        compact: {
          type: "boolean",
          default: true,
        },
        checkDoctor: {
          type: "boolean",
          description:
            "Run non-destructive CDP/environment check instead of active tab snapshot.",
          default: false,
        },
      },
    },
  },
  {
    name: "monorepo_exec",
    description:
      "Execute structured sovereign monorepo tools across C:\\src (wck, depot, bun-parity, ring3-agent status, or git status).",
    inputSchema: {
      type: "object",
      required: ["subsystem"],
      properties: {
        subsystem: {
          type: "string",
          enum: ["wck", "depot", "bun-parity", "ring3-agent", "binaries-check"],
        },
        args: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
  {
    name: "sentinel_status",
    description:
      "Query or refresh the Real-Time & Nightly Standards Sentinel (Web, Linux 7.4, Windows Insiders, Chrome Canary, Android 17/18, AI Specs).",
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          default: false,
        },
        targetIds: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
  {
    name: "skills_search",
    description:
      "Search indexed SKILL.md definitions across Google/DeepMind, Vercel-Labs, Anthropic, OpenCode, agent-browser, agent-desktop, and C:\\src\\.agents.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          default: "",
        },
        limit: {
          type: "integer",
          default: 20,
        },
      },
    },
  },
  {
    name: "cuda_sm89_scan",
    description:
      "Probe RTX 4070 Ada Lovelace sm_89 GPU telemetry, FP32 FMA GFLOPS, FP16 Tensor Core TFLOPS, GDDR6X bandwidth, and Zero-Copy Pinned DMA via sovereign_cuda_sm89.dll.",
    inputSchema: {
      type: "object",
      properties: {
        quick: {
          type: "boolean",
          default: true,
        },
        includePythonTorch: {
          type: "boolean",
          default: false,
        },
      },
    },
  },
  {
    name: "polyglot_ast_parse",
    description:
      "Parse Python, Rust, TypeScript, or TSX source code into structural AST symbols via Fat-LTO Rust + Tree-Sitter sovereign_polyglot_ffi.dll.",
    inputSchema: {
      type: "object",
      required: ["language", "code"],
      properties: {
        language: {
          type: "string",
          enum: ["python", "rust", "typescript", "tsx"],
        },
        code: {
          type: "string",
        },
      },
    },
  },
  {
    name: "rag_zero_copy_cosine",
    description:
      "Compute ultra-fast batch cosine similarity across document embeddings via CUDA sm_89 or AVX2+FMA3 Rayon FFI.",
    inputSchema: {
      type: "object",
      required: ["query", "corpus", "dim"],
      properties: {
        query: {
          type: "array",
          items: { type: "number" },
        },
        corpus: {
          type: "array",
          items: { type: "number" },
        },
        dim: {
          type: "integer",
        },
        backend: {
          type: "string",
          enum: ["auto", "cuda", "avx2"],
          default: "auto",
        },
      },
    },
  },
  {
    name: "heretic_abliterate_preview",
    description:
      "Project out a directional refusal vector from a weight matrix W' = W - scale*(W@r)*r^T via CUDA sm_89 or Rust AVX2 FFI.",
    inputSchema: {
      type: "object",
      required: ["weights", "refusalDir", "outFeatures", "inFeatures"],
      properties: {
        weights: {
          type: "array",
          items: { type: "number" },
        },
        refusalDir: {
          type: "array",
          items: { type: "number" },
        },
        outFeatures: {
          type: "integer",
        },
        inFeatures: {
          type: "integer",
        },
        scale: {
          type: "number",
          default: 1.0,
        },
      },
    },
  },
  {
    name: "ecosystem_submodules_status",
    description:
      "Return full status of the 86 polyglot 2026 LLM/AI/Astral/ggml/PyO3/HuggingFace/OpenAI/NVIDIA/PyTorch/Tree-sitter submodules and compiled native binaries.",
    inputSchema: {
      type: "object",
      properties: {
        quickGpu: {
          type: "boolean",
          default: true,
        },
      },
    },
  },
  ...UNIFIED_DOMAIN_TOOLS,
];

export function getMcpToolsForProfile(
  profile: "default" | "minimal" = "default",
): readonly McpToolDefinition[] {
  if (profile === "minimal") {
    const minimalSet = new Set([
      "os_atomic",
      "posix_os",
      "desktop_snapshot",
      "desktop_action",
      "browser_navigate",
      "browser_a11y_tree",
      "skills_search",
    ]);
    return MCP_TOOLS.filter((t) => minimalSet.has(t.name));
  }
  // Context-optimized unified default: core OS tools + unified domain routers
  const unifiedSet = new Set([
    "os_atomic",
    "desktop_snapshot",
    "desktop_action",
    "browser_navigate",
    "browser_a11y_tree",
    "monorepo_exec",
    "sentinel_status",
    "skills_search",
    ...UNIFIED_DOMAIN_TOOLS.map((t) => t.name),
  ]);
  return MCP_TOOLS.filter((t) => unifiedSet.has(t.name));
}

export async function executeMcpTool(
  name: string,
  rawArgs: Record<string, unknown> = {},
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structured?: unknown;
}> {
  try {
    if (name === "desktop_snapshot") {
      const ffi = getDesktopFfi();
      if (ffi) {
        const payload = rawArgs.statusOnly
          ? ffi.statusEnvelope()
          : ffi.snapshot({
              app: typeof rawArgs.app === "string" ? rawArgs.app : undefined,
              surface:
                typeof rawArgs.surface === "number" ? rawArgs.surface : 0,
              maxDepth:
                typeof rawArgs.maxDepth === "number" ? rawArgs.maxDepth : 6,
              interactiveOnly:
                typeof rawArgs.interactiveOnly === "boolean"
                  ? rawArgs.interactiveOnly
                  : true,
              compact:
                typeof rawArgs.compact === "boolean" ? rawArgs.compact : true,
            });
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structured: payload,
        };
      }
      const cliRes = await runDesktopCli(
        rawArgs.statusOnly ? ["status"] : ["snapshot", "--compact"],
      );
      return {
        isError: cliRes.exitCode !== 0,
        content: [{ type: "text", text: cliRes.stdout || cliRes.stderr }],
        structured: cliRes.parsed,
      };
    }

    if (name === "desktop_action") {
      if (typeof rawArgs.refId === "string" && rawArgs.refId.length > 0) {
        const ffi = getDesktopFfi();
        if (ffi) {
          const payload = ffi.executeByRef({
            refId: rawArgs.refId,
            action:
              typeof rawArgs.action === "string" ? rawArgs.action : "click",
            text: typeof rawArgs.text === "string" ? rawArgs.text : undefined,
            policy:
              rawArgs.policy === 1 || rawArgs.policy === 2 ? rawArgs.policy : 0,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structured: payload,
          };
        }
      }
      const cliArgs = Array.isArray(rawArgs.cliArgs)
        ? rawArgs.cliArgs.map(String)
        : ["version"];
      const cliRes = await runDesktopCli(cliArgs);
      return {
        isError: cliRes.exitCode !== 0,
        content: [{ type: "text", text: cliRes.stdout || cliRes.stderr }],
        structured: cliRes.parsed,
      };
    }

    if (name === "browser_navigate") {
      const cmd =
        typeof rawArgs.command === "string" ? rawArgs.command : "open";
      const extraArgs = Array.isArray(rawArgs.args)
        ? rawArgs.args.map(String)
        : [];
      const fullArgs =
        cmd === "--version" || cmd === "version"
          ? ["--version"]
          : typeof rawArgs.url === "string" && rawArgs.url.length > 0
            ? [cmd, rawArgs.url, ...extraArgs]
            : [cmd, ...extraArgs];
      const res = await runBrowserCli(fullArgs);
      return {
        isError: res.exitCode !== 0,
        content: [{ type: "text", text: (res.stdout || res.stderr).trim() }],
        structured: res.parsed ?? {
          exitCode: res.exitCode,
          stdout: res.stdout.trim(),
        },
      };
    }

    if (name === "browser_a11y_tree") {
      if (rawArgs.checkDoctor) {
        const ver = await runBrowserCli(["--version"]);
        return {
          isError: ver.exitCode !== 0,
          content: [{ type: "text", text: ver.stdout.trim() }],
          structured: {
            binary: resolveBrowserCliPath(),
            version: ver.stdout.trim(),
          },
        };
      }
      const args = ["snapshot"];
      if (rawArgs.interactiveOnly !== false) args.push("-i");
      if (rawArgs.compact !== false) args.push("-c");
      if (typeof rawArgs.session === "string" && rawArgs.session.length > 0) {
        args.push("--session", rawArgs.session);
      }
      const res = await runBrowserCli(args, 10000);
      return {
        isError: res.exitCode !== 0,
        content: [{ type: "text", text: (res.stdout || res.stderr).trim() }],
        structured: res.parsed,
      };
    }

    if (name === "monorepo_exec") {
      const sub = String(rawArgs.subsystem ?? "binaries-check");
      if (sub === "binaries-check") {
        const desktopBin = resolveDesktopCliPath();
        const browserBin = resolveBrowserCliPath();
        const ffi = getDesktopFfi();
        const info = {
          desktopCli: { path: desktopBin, exists: existsSync(desktopBin) },
          browserCli: { path: browserBin, exists: existsSync(browserBin) },
          desktopFfi: ffi
            ? { path: ffi.dllPath, abiVersion: ffi.abiVersion, loaded: true }
            : { loaded: false },
          wckDir: existsSync("C:/src/wck"),
          depotDir: existsSync("C:/src/depot"),
          ring3AgentDir: existsSync("C:/src/ring3-agent"),
          rosegriffonDir: existsSync("C:/src/apps/rosegriffon"),
          nieBin: existsSync(join(homedir(), ".local", "bin", "nie.exe")),
          ieCmd: existsSync(join(homedir(), ".local", "bin", "ie.cmd")),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
          structured: info,
        };
      }
      if (sub === "ring3-agent") {
        const providers = await probeLocalProviders(500);
        const r3 = providers.find((p) => p.id === "ring3-agent");
        return {
          content: [
            { type: "text", text: JSON.stringify(r3 ?? { reachable: false }) },
          ],
          structured: r3,
        };
      }
      if (sub === "bun-parity") {
        const parityPath = resolve("C:/src/bun-parity/parity-matrix.json");
        const txt = existsSync(parityPath)
          ? await Bun.file(parityPath).text()
          : "{}";
        const parsed = JSON.parse(txt) as Record<string, unknown>;
        const summary = {
          bunVersion: parsed.bunVersion,
          overallNativeScore: parsed.overallNativeScore,
          overallPatchedScore: parsed.overallPatchedScore,
          totalFeaturesScanned: parsed.totalFeaturesScanned,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(summary) }],
          structured: summary,
        };
      }
      if (sub === "wck") {
        const wckBin = "C:/Users/aphro/.local/bin/wck.exe";
        const cmd = existsSync(wckBin)
          ? [
              wckBin,
              ...(Array.isArray(rawArgs.args)
                ? rawArgs.args.map(String)
                : ["--help"]),
            ]
          : ["bun", "run", "C:/src/wck/src/cli.ts", "--help"];
        const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
        const out =
          new TextDecoder().decode(proc.stdout) ||
          new TextDecoder().decode(proc.stderr);
        return {
          isError: proc.exitCode !== 0,
          content: [{ type: "text", text: out.trim() }],
        };
      }
      if (sub === "depot") {
        const cargoToml = "C:/src/depot/Cargo.toml";
        const exists = existsSync(cargoToml);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                subsystem: "depot",
                manifestExists: exists,
                path: cargoToml,
              }),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `Unsupported subsystem: ${sub}` }],
      };
    }

    if (name === "sentinel_status") {
      const targetIds = Array.isArray(rawArgs.targetIds)
        ? rawArgs.targetIds.map(String)
        : undefined;
      const state =
        rawArgs.refresh || !readCachedSentinelState()
          ? await runSentinelSync({ targetIds })
          : readCachedSentinelState()!;
      return {
        content: [{ type: "text", text: JSON.stringify(state) }],
        structured: state,
      };
    }

    if (name === "skills_search") {
      const query = typeof rawArgs.query === "string" ? rawArgs.query : "";
      const limit = typeof rawArgs.limit === "number" ? rawArgs.limit : 20;
      const matches = searchSkills(query, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(matches) }],
        structured: matches,
      };
    }

    if (name === "cuda_sm89_scan") {
      const cuda = getCudaFfi();
      const quick = rawArgs.quick !== false;
      const gpuTelemetry = cuda
        ? cuda.scanAndBench(quick)
        : { ok: false, error: "sovereign_cuda_sm89.dll not loaded" };
      const pyTorch = rawArgs.includePythonTorch
        ? await runPythonPolyglotScan()
        : undefined;
      const payload = { gpuTelemetry, pythonStack: pyTorch };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structured: payload,
      };
    }

    if (name === "polyglot_ast_parse") {
      const ffi = getPolyglotFfi();
      if (!ffi) {
        return {
          isError: true,
          content: [
            { type: "text", text: "sovereign_polyglot_ffi.dll not loaded" },
          ],
        };
      }
      const lang = String(rawArgs.language ?? "python");
      const code = String(rawArgs.code ?? "");
      const parsed = ffi.parseAst(lang, code);
      return {
        isError: !parsed.ok,
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
        structured: parsed,
      };
    }

    if (name === "rag_zero_copy_cosine") {
      const qArr = Array.isArray(rawArgs.query)
        ? new Float32Array(rawArgs.query.map(Number))
        : new Float32Array(0);
      const cArr = Array.isArray(rawArgs.corpus)
        ? new Float32Array(rawArgs.corpus.map(Number))
        : new Float32Array(0);
      const dim = Number(rawArgs.dim ?? qArr.length);
      const backend = String(rawArgs.backend ?? "auto");
      const cuda = getCudaFfi();
      const poly = getPolyglotFfi();

      let scores: Float32Array;
      let usedBackend = "none";
      if (
        (backend === "cuda" || (backend === "auto" && cArr.length >= 4096)) &&
        cuda
      ) {
        scores = cuda.cosineRagBatch(qArr, cArr, dim);
        usedBackend = "cuda_sm89";
      } else if (poly) {
        scores = poly.cosineRagBatch(qArr, cArr, dim);
        usedBackend = "rust_avx2_rayon";
      } else {
        return {
          isError: true,
          content: [{ type: "text", text: "No native RAG FFI backend loaded" }],
        };
      }
      const payload = {
        ok: true,
        backend: usedBackend,
        dim,
        numDocs: scores.length,
        scores: Array.from(scores).map((x) => Math.round(x * 1e6) / 1e6),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structured: payload,
      };
    }

    if (name === "heretic_abliterate_preview") {
      const wArr = Array.isArray(rawArgs.weights)
        ? new Float32Array(rawArgs.weights.map(Number))
        : new Float32Array(0);
      const rArr = Array.isArray(rawArgs.refusalDir)
        ? new Float32Array(rawArgs.refusalDir.map(Number))
        : new Float32Array(0);
      const outF = Number(rawArgs.outFeatures ?? 0);
      const inF = Number(rawArgs.inFeatures ?? 0);
      const scale = typeof rawArgs.scale === "number" ? rawArgs.scale : 1.0;

      const cuda = getCudaFfi();
      const poly = getPolyglotFfi();
      let backend = "rust_avx2";
      if (cuda && wArr.length >= 4096) {
        cuda.hereticAbliterateInPlace(wArr, rArr, outF, inF, scale);
        backend = "cuda_sm89";
      } else if (poly) {
        poly.hereticAbliterateInPlace(wArr, rArr, outF, inF, scale);
      } else {
        return {
          isError: true,
          content: [
            { type: "text", text: "No native abliteration FFI loaded" },
          ],
        };
      }
      const payload = {
        ok: true,
        backend,
        outFeatures: outF,
        inFeatures: inF,
        abliteratedWeights: Array.from(wArr).map(
          (x) => Math.round(x * 1e6) / 1e6,
        ),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structured: payload,
      };
    }

    if (name === "ecosystem_submodules_status") {
      const status = inspectPolyglotEcosystem({
        quickGpu: rawArgs.quickGpu !== false,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structured: status,
      };
    }

    const unifiedRes = await executeUnifiedDomainTool(name, rawArgs);
    if (unifiedRes.handled) {
      return {
        isError: Boolean(unifiedRes.isError),
        content: [
          {
            type: "text",
            text:
              typeof unifiedRes.payload === "string"
                ? unifiedRes.payload
                : JSON.stringify(unifiedRes.payload, null, 2),
          },
        ],
        structured: unifiedRes.payload,
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown MCP tool: ${name}` }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        { type: "text", text: `Tool execution error (${name}): ${msg}` },
      ],
    };
  }
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export async function dispatchMcpJsonRpc(
  msg: JsonRpcRequest,
  profile: "default" | "minimal" = "default",
): Promise<JsonRpcResponse | null> {
  // JSON-RPC notifications (no id) return null
  if (msg.id === undefined) {
    return null;
  }

  const id = msg.id;
  switch (msg.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: {
            name: "ai-os-sovereign-mcp",
            version: "2.0.0",
          },
        },
      };
    }
    case "ping": {
      return { jsonrpc: "2.0", id, result: {} };
    }
    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: getMcpToolsForProfile(profile),
        },
      };
    }
    case "tools/call": {
      const toolName = String(msg.params?.name ?? "");
      const args =
        (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
      const res = await executeMcpTool(toolName, args);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: res.content,
          isError: Boolean(res.isError),
          structuredContent: res.structured,
        },
      };
    }
    case "resources/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            {
              uri: "soul://canonical",
              name: "SOUL.md",
              mimeType: "text/markdown",
            },
            {
              uri: "brain://index",
              name: "00 Unified Brain Index.md",
              mimeType: "text/markdown",
            },
            {
              uri: "skills://collections",
              name: "Active Skill & MCP Collections",
              mimeType: "application/json",
            },
            {
              uri: "file:///C:/src/ai-os/EXTRACTION_MANIFEST.json",
              name: "EXTRACTION_MANIFEST.json",
              mimeType: "application/json",
            },
            {
              uri: "file:///C:/src/ai-os/COMPARISON_AND_INTEGRATION_MATRIX.md",
              name: "COMPARISON_AND_INTEGRATION_MATRIX.md",
              mimeType: "text/markdown",
            },
            {
              uri: "file:///C:/src/ai-os/SENTINEL_REPORT.md",
              name: "SENTINEL_REPORT.md",
              mimeType: "text/markdown",
            },
          ],
        },
      };
    }
    case "resources/read": {
      const uri = String(msg.params?.uri ?? "");
      let text = "";
      let mimeType = "text/markdown";
      if (uri === "soul://canonical") {
        text = buildCanonicalSoulMarkdown();
      } else if (uri === "brain://index") {
        const idxPath = `${DEFAULT_BRAIN_VAULT_DIR}/00 Unified Brain Index.md`;
        text = existsSync(idxPath)
          ? readFileSync(idxPath, "utf8")
          : "# Unified Brain Index (run ai-os sync)";
      } else if (uri === "skills://collections") {
        mimeType = "application/json";
        text = JSON.stringify(listActiveCollections(), null, 2);
      } else if (uri.startsWith("file:///")) {
        const localPath = uri.replace(/^file:\/\/\//, "");
        text = existsSync(localPath) ? readFileSync(localPath, "utf8") : "";
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [{ uri, mimeType, text }],
        },
      };
    }
    default: {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${msg.method}`,
        },
      };
    }
  }
}

export async function handleMcpHttpRequest(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const sessionId = req.headers.get("mcp-session-id") ?? crypto.randomUUID();
    const accept = req.headers.get("accept") ?? "";
    if (accept.includes("text/event-stream")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: endpoint\ndata: ${JSON.stringify({ protocolVersion: MCP_PROTOCOL_VERSION, sessionId })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "mcp-session-id": sessionId,
        },
      });
    }
    return Response.json(
      {
        name: "ai-os-sovereign-mcp",
        protocolVersion: MCP_PROTOCOL_VERSION,
        transport: "Streamable HTTP + Stdio JSON-RPC 2.0",
        toolsCount: MCP_TOOLS.length,
      },
      { headers: { "mcp-session-id": sessionId } },
    );
  }

  if (req.method === "DELETE") {
    return new Response(null, { status: 204 });
  }

  const sessionId = req.headers.get("mcp-session-id") ?? crypto.randomUUID();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      { status: 400 },
    );
  }

  const accept = req.headers.get("accept") ?? "";
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(
        body.map((item) => dispatchMcpJsonRpc(item as JsonRpcRequest)),
      )
    ).filter((x): x is JsonRpcResponse => x !== null);
    if (responses.length === 0) {
      return new Response(null, {
        status: 202,
        headers: { "mcp-session-id": sessionId },
      });
    }
    return Response.json(responses, {
      headers: { "mcp-session-id": sessionId },
    });
  }

  const response = await dispatchMcpJsonRpc(body as JsonRpcRequest);
  if (response === null) {
    return new Response(null, {
      status: 202,
      headers: { "mcp-session-id": sessionId },
    });
  }

  if (
    accept.includes("text/event-stream") &&
    !accept.includes("application/json")
  ) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify(response)}\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "mcp-session-id": sessionId,
      },
    });
  }

  return Response.json(response, { headers: { "mcp-session-id": sessionId } });
}

export async function runMcpStdioServer(
  profile: "default" | "minimal" = "default",
): Promise<void> {
  const effectiveProfile =
    process.env.AI_OS_MCP_PROFILE === "minimal" ? "minimal" : profile;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as JsonRpcRequest;
        const resp = await dispatchMcpJsonRpc(parsed, effectiveProfile);
        if (resp) {
          process.stdout.write(`${JSON.stringify(resp)}\n`);
        }
      } catch {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          })}\n`,
        );
      }
    }
  }
}
