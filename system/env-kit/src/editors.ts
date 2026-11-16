import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SyncEditorsResult {
  opencodePath: string;
  zedPath: string;
  piSettingsPath: string;
  piModelsPath: string;
  antigravityCliMcpPath: string;
  antigravityGlobalMcpPath: string;
  geminiSettingsPath: string;
  claudeJsonPath: string;
  updatedFiles: string[];
}

function stripJsonCommentsAndTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // Remove trailing commas before `}` or `]` outside strings
  let cleaned = "";
  inString = false;
  escaped = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j]!;
    if (inString) {
      cleaned += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k]!)) {
        k++;
      }
      if (out[k] === "}" || out[k] === "]") {
        continue;
      }
    }
    cleaned += ch;
  }

  return cleaned;
}

function readJsoncObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, "utf8");
  const stripped = stripJsonCommentsAndTrailingCommas(raw).trim();
  if (!stripped) {
    return {};
  }
  return JSON.parse(stripped) as Record<string, unknown>;
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

export function syncAllEditorConfigs(
  options: {
    homeDir?: string;
    appDataDir?: string;
    env?: Record<string, string | undefined>;
  } = {},
): SyncEditorsResult {
  const home = options.homeDir ?? homedir();
  const appData =
    options.appDataDir ??
    process.env.APPDATA ??
    (process.platform === "win32"
      ? join(home, "AppData", "Roaming")
      : (process.env.XDG_CONFIG_HOME ?? join(home, ".config")));
  const env = options.env ?? process.env;
  const exe = process.platform === "win32" ? ".exe" : "";
  const AIOS_BIN = join(home, ".local", "bin", `ai-os${exe}`);
  const ENVKIT_BIN = join(home, ".local", "bin", `env-kit${exe}`);
  const ENV_FILE = join(
    process.env.ENV_KIT_ROOT ?? resolve(import.meta.dir, "..", "..", ".."),
    ".env",
  );

  const opencodePath = join(home, ".config", "opencode", "opencode.jsonc");
  const zedPath = join(appData, "Zed", "settings.json");
  const piSettingsPath = join(home, ".pi", "agent", "settings.json");
  const piModelsPath = join(home, ".pi", "agent", "models.json");
  const antigravityCliMcpPath = join(
    home,
    ".gemini",
    "antigravity-cli",
    "mcp_config.json",
  );
  const antigravityGlobalMcpPath = join(
    home,
    ".gemini",
    "config",
    "mcp_config.json",
  );
  const geminiSettingsPath = join(home, ".gemini", "settings.json");
  const claudeJsonPath = join(home, ".claude.json");

  const updatedFiles: string[] = [];

  // 1. OpenCode (`~/.config/opencode/opencode.jsonc`)
  const oc = readJsoncObject(opencodePath);
  oc.$schema = oc.$schema ?? "https://opencode.ai/config.json";
  oc.doctrine = oc.doctrine ?? "No Human In The Loop (NHITL / ZHITL)";

  const ocMcp = asRecord(oc.mcp);
  ocMcp.ai_os = {
    type: "local",
    command: [AIOS_BIN, "mcp-stdio"],
    enabled: true,
  };
  ocMcp.cloudflare = {
    type: "remote",
    url: "https://mcp.cloudflare.com/mcp",
    enabled: true,
    headers: {
      Authorization: "Bearer {env:CLOUDFLARE_API_TOKEN}",
    },
  };
  ocMcp["cloudflare-docs"] = {
    type: "remote",
    url: "https://docs.mcp.cloudflare.com/mcp",
    enabled: true,
  };
  ocMcp.vercel = {
    type: "remote",
    url: "https://mcp.vercel.com",
    enabled: true,
    headers: {
      Authorization: "Bearer {env:VERCEL_TOKEN}",
    },
  };
  ocMcp.context7 = {
    type: "remote",
    url: "https://mcp.context7.com/mcp",
    enabled: true,
    headers: {
      Authorization: "Bearer {env:CTX7_API_KEY}",
    },
  };
  ocMcp.figma = {
    type: "local",
    command: [AIOS_BIN, "mcp-stdio"],
    enabled: true,
    environment: {
      FIGMA_API_KEY: "{env:FIGMA_ACCESS_TOKEN}",
      FIGMA_ACCESS_TOKEN: "{env:FIGMA_ACCESS_TOKEN}",
    },
  };
  ocMcp.github = ocMcp.github ?? {
    type: "local",
    command: [AIOS_BIN, "mcp-stdio"],
    enabled: true,
    environment: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_TOKEN}",
    },
  };
  oc.mcp = ocMcp;

  const ocProviders = asRecord(oc.providers);
  const existingAnthropic = asRecord(ocProviders.anthropic);
  ocProviders.anthropic = {
    ...existingAnthropic,
    name: (existingAnthropic.name as string | undefined) ?? "Anthropic Claude",
    apiKey: "{env:ANTHROPIC_API_KEY}",
    options: {
      ...asRecord(existingAnthropic.options),
      headers: {
        ...asRecord(asRecord(existingAnthropic.options).headers),
        "anthropic-workspace-id": "{env:ANTHROPIC_WORKSPACE_ID}",
      },
    },
    models: Array.isArray(existingAnthropic.models)
      ? existingAnthropic.models
      : [
          "claude-opus-5-5",
          "claude-sonnet-5-5",
          "claude-haiku-5-5",
          "claude-fable-5-2",
        ],
  };

  ocProviders.google = {
    name: "Google Gemini API",
    apiKey: "{env:GEMINI_API_KEY}",
    models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview"],
  };

  ocProviders.gemini = {
    name: "Google Gemini Direct",
    apiKey: "{env:GEMINI_API_KEY}",
    models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview"],
  };

  ocProviders.openai = {
    name: "OpenAI API",
    apiKey: "{env:OPENAI_API_KEY}",
    models: ["gpt-5.4", "gpt-5.4-mini", "o4-mini"],
  };

  ocProviders.ring3_local = {
    name: "Ring-3 CUDA/AVX2 Daemon (r3d)",
    baseUrl: "http://127.0.0.1:8787/v1",
    apiKey: "ring3-local",
    models: [
      "qwen3-coder-next-abliterated",
      "deepseek-r1-distill-qwen-14b-heretic",
    ],
  };

  ocProviders.locally_uncensored = {
    name: "Locally Uncensored / Heretic Primary (:8129 + :8084 fallback)",
    baseUrl: "http://127.0.0.1:8129/v1",
    options: {
      fallbackBaseUrl: "http://127.0.0.1:8084/v1",
    },
    apiKey: "local-uncensored",
    models: [
      "qwen3-coder-14b-heretic",
      "local-qwen-coder-7b",
      "local-qwen-chat",
    ],
  };

  // Upgrade legacy `local_uncensored` (:8084) cleanly without hardcoded secrets
  if (ocProviders.local_uncensored) {
    const legacyLu = asRecord(ocProviders.local_uncensored);
    ocProviders.local_uncensored = {
      ...legacyLu,
      name: "Local Uncensored llama.cpp (:8084)",
      baseUrl: "http://127.0.0.1:8084/v1",
      apiKey: "local-uncensored",
      models: Array.isArray(legacyLu.models)
        ? legacyLu.models
        : ["local-qwen-coder-7b", "local-qwen-chat"],
    };
  }

  oc.providers = ocProviders;
  mkdirSync(dirname(opencodePath), { recursive: true });
  writeFileSync(opencodePath, `${JSON.stringify(oc, null, 2)}\n`, "utf8");
  updatedFiles.push(opencodePath);

  // 2. Zed (`%APPDATA%\Zed\settings.json`)
  const zed = readJsoncObject(zedPath);
  const zedLm = asRecord(zed.language_models);
  zedLm.anthropic = {
    ...asRecord(zedLm.anthropic),
    api_url: "https://api.anthropic.com",
  };
  zedLm.google = {
    ...asRecord(zedLm.google),
    api_url: "https://generativelanguage.googleapis.com",
  };
  zedLm.openai = {
    ...asRecord(zedLm.openai),
    api_url: "https://api.openai.com/v1",
  };
  zedLm.ollama = {
    ...asRecord(zedLm.ollama),
    api_url: "http://127.0.0.1:11434",
  };
  zedLm.openai_compatible = {
    ...asRecord(zedLm.openai_compatible),
    ring3_agent: {
      api_url: "http://127.0.0.1:8787/v1",
      available_models: [
        {
          name: "qwen3-coder-next-abliterated",
          display_name: "Ring-3 Qwen3 Coder Abliterated (RTX 4070 sm_89)",
          max_tokens: 131072,
        },
      ],
    },
    locally_uncensored: {
      api_url: "http://127.0.0.1:8129/v1",
      available_models: [
        {
          name: "qwen3-coder-14b-heretic",
          display_name: "Locally Uncensored Heretic 14B (:8129)",
          max_tokens: 131072,
        },
      ],
    },
    locally_uncensored_llama_cpp: {
      api_url: "http://127.0.0.1:8084/v1",
      available_models: [
        {
          name: "local-qwen-coder-7b",
          display_name: "Locally Uncensored llama.cpp (:8084)",
          max_tokens: 65536,
        },
      ],
    },
  };
  zed.language_models = zedLm;

  const zedAgent = asRecord(zed.agent);
  zed.agent = {
    ...zedAgent,
    always_allow_tool_actions: true,
    default_profile: "write",
    default_model: zedAgent.default_model ?? {
      provider: "anthropic",
      model: "claude-sonnet-4-5-latest",
    },
  };

  const zedCtx = asRecord(zed.context_servers);
  zedCtx["ai-os"] = {
    source: "custom",
    enabled: true,
    command: {
      path: AIOS_BIN,
      args: ["mcp-stdio"],
      env: {},
    },
  };
  zedCtx["native-hardware-cuda"] = zedCtx["native-hardware-cuda"] ?? {
    source: "custom",
    enabled: true,
    command: {
      path: ENVKIT_BIN,
      args: ["exec", "--", "r3d-mcp"],
      env: {},
    },
  };
  zedCtx.github = zedCtx.github ?? {
    source: "custom",
    enabled: true,
    command: {
      path: ENVKIT_BIN,
      args: ["exec", "--", AIOS_BIN, "mcp-stdio"],
      env: {},
    },
  };
  zedCtx.figma = zedCtx.figma ?? {
    source: "custom",
    enabled: true,
    command: {
      path: ENVKIT_BIN,
      args: ["exec", "--", AIOS_BIN, "mcp-stdio"],
      env: {},
    },
  };
  zed.context_servers = zedCtx;

  mkdirSync(dirname(zedPath), { recursive: true });
  writeFileSync(
    zedPath,
    `// Zed settings (UI + Language Models + NHITL Agent + MCP Context Servers)\n${JSON.stringify(zed, null, 2)}\n`,
    "utf8",
  );
  updatedFiles.push(zedPath);

  // 3. Pi (`~/.pi/agent/settings.json` & `~/.pi/agent/models.json`)
  const piSettings = readJsoncObject(piSettingsPath);
  const nextPiSettings = {
    ...piSettings,
    defaultProvider: piSettings.defaultProvider ?? "anthropic",
    defaultModel: piSettings.defaultModel ?? "claude-sonnet-5-5",
    fallbackProvider: "locally-uncensored",
    fallbackModel: "qwen3-coder-14b-heretic",
    nhitl: true,
    autoApproveTools: true,
    envFile: ENV_FILE,
    apiKeys: {
      anthropic: "$ANTHROPIC_API_KEY",
      google: "$GEMINI_API_KEY",
      gemini: "$GEMINI_API_KEY",
      openai: "$OPENAI_API_KEY",
    },
  };
  mkdirSync(dirname(piSettingsPath), { recursive: true });
  writeFileSync(
    piSettingsPath,
    `${JSON.stringify(nextPiSettings, null, 2)}\n`,
    "utf8",
  );
  updatedFiles.push(piSettingsPath);

  const piModels = readJsoncObject(piModelsPath);
  const nextPiModels = {
    ...piModels,
    providers: {
      ...asRecord(piModels.providers),
      anthropic: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        headers: {
          "anthropic-workspace-id": "$ANTHROPIC_WORKSPACE_ID",
        },
        models: [
          {
            id: "claude-opus-5-5",
            name: "Claude Opus 5.5",
            contextWindow: 200000,
            maxTokens: 32768,
          },
          {
            id: "claude-sonnet-5-5",
            name: "Claude Sonnet 5.5",
            contextWindow: 200000,
            maxTokens: 16384,
          },
        ],
      },
      google: {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini 3.1 Pro Preview",
            contextWindow: 1048576,
            maxTokens: 65536,
          },
          {
            id: "gemini-3-flash-preview",
            name: "Gemini 3 Flash Preview",
            contextWindow: 1048576,
            maxTokens: 65536,
          },
        ],
      },
      openai: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            contextWindow: 272000,
            maxTokens: 32768,
          },
        ],
      },
      "ring3-agent": {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8787/v1",
        apiKey: "ring3-local",
        models: [
          {
            id: "qwen3-coder-next-abliterated",
            name: "Ring-3 Qwen3 Coder Abliterated (CUDA sm_89)",
            contextWindow: 131072,
            maxTokens: 16384,
          },
        ],
      },
      "locally-uncensored": {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8129/v1",
        fallbackBaseUrl: "http://127.0.0.1:8084/v1",
        apiKey: "local-uncensored",
        models: [
          {
            id: "qwen3-coder-14b-heretic",
            name: "Locally Uncensored Qwen3 Coder 14B Heretic (:8129)",
            contextWindow: 131072,
            maxTokens: 16384,
          },
          {
            id: "local-qwen-coder-7b",
            name: "Locally Uncensored Qwen Coder 7B (:8084)",
            contextWindow: 65536,
            maxTokens: 8192,
          },
        ],
      },
    },
  };
  writeFileSync(
    piModelsPath,
    `${JSON.stringify(nextPiModels, null, 2)}\n`,
    "utf8",
  );
  updatedFiles.push(piModelsPath);

  // 4. Antigravity (`agy`), Gemini CLI & Claude Code MCP servers (preserving existing entries)
  const cfToken = env.CLOUDFLARE_API_TOKEN?.trim();
  const vercelToken = env.VERCEL_TOKEN?.trim();
  const remoteServers = (withHttpType: boolean): Record<string, unknown> => {
    const typeField = withHttpType ? { type: "http" } : {};
    return {
      "cloudflare-docs": {
        ...typeField,
        url: "https://docs.mcp.cloudflare.com/mcp",
      },
      ...(cfToken
        ? {
            cloudflare: {
              ...typeField,
              url: "https://mcp.cloudflare.com/mcp",
              headers: { Authorization: `Bearer ${cfToken}` },
            },
          }
        : {}),
      ...(vercelToken
        ? {
            vercel: {
              ...typeField,
              url: "https://mcp.vercel.com",
              headers: { Authorization: `Bearer ${vercelToken}` },
            },
          }
        : {}),
    };
  };

  const syncMcpFile = (
    filePath: string,
    includeAiOs: boolean,
    withHttpType: boolean,
  ): void => {
    const doc = readJsoncObject(filePath);
    const servers = asRecord(doc.mcpServers);
    if (includeAiOs && !servers["ai-os"]) {
      servers["ai-os"] = {
        command: AIOS_BIN,
        args: ["mcp-stdio"],
      };
    }
    doc.mcpServers = {
      ...servers,
      ...remoteServers(withHttpType),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    updatedFiles.push(filePath);
  };

  syncMcpFile(antigravityCliMcpPath, true, false);
  syncMcpFile(antigravityGlobalMcpPath, true, false);
  syncMcpFile(geminiSettingsPath, true, false);
  if (existsSync(claudeJsonPath)) {
    syncMcpFile(claudeJsonPath, false, true);
  }

  return {
    opencodePath,
    zedPath,
    piSettingsPath,
    piModelsPath,
    antigravityCliMcpPath,
    antigravityGlobalMcpPath,
    geminiSettingsPath,
    claudeJsonPath,
    updatedFiles,
  };
}
