import { getSovereignEnv, maskSecret } from "../env.ts";
import { mintGoogleAccessToken } from "../nexus/security.ts";
import {
  convertVerboseLlmToDecision,
  decideSystem1,
  type DecisionToolSpec,
} from "../system1/decisional-engine.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  name?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  provider?: string;
  decision_mode?: boolean;
  tools?: DecisionToolSpec[];
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  provider: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: "stop" | "length" | "tool_calls";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  kind: "cloud" | "local";
  baseUrl: string;
  authKeyName?: string;
  authStatus: string;
  defaultModel: string;
  uncensoredLocal: boolean;
}

export interface ProviderProbeResult extends ProviderDescriptor {
  reachable: boolean;
  latencyMs: number;
  models: string[];
  detail?: string;
}

export const FEDERATION_PROVIDERS: ReadonlyArray<{
  id: string;
  name: string;
  kind: "cloud" | "local";
  baseUrl: string;
  healthPath: string;
  authKeyName?: string;
  defaultModel: string;
  uncensoredLocal: boolean;
}> = [
  {
    id: "ring3-agent",
    name: "Ring-3 Native Rust Daemon (r3d CUDA sm_89 / AVX2 / WebGPU)",
    kind: "local",
    baseUrl: "http://127.0.0.1:8787",
    healthPath: "/v1/models",
    defaultModel: "ring3-local",
    uncensoredLocal: true,
  },
  {
    id: "locally-uncensored",
    name: "Locally Uncensored / Heretic Open-Weights Engine",
    kind: "local",
    baseUrl: "http://127.0.0.1:8129",
    healthPath: "/v1/models",
    defaultModel: "heretic-uncensored",
    uncensoredLocal: true,
  },
  {
    id: "llamacpp-primary",
    name: "llama.cpp Server (8081)",
    kind: "local",
    baseUrl: "http://127.0.0.1:8081",
    healthPath: "/v1/models",
    defaultModel: "llamacpp-8081",
    uncensoredLocal: true,
  },
  {
    id: "llamacpp-secondary",
    name: "llama.cpp Server (8084)",
    kind: "local",
    baseUrl: "http://127.0.0.1:8084",
    healthPath: "/v1/models",
    defaultModel: "llamacpp-8084",
    uncensoredLocal: true,
  },
  {
    id: "llamacpp-cpu-nogpu",
    name: "llama.cpp Zero-GPU CPU+SSD+RAM System-1 Server (8089)",
    kind: "local",
    baseUrl: "http://127.0.0.1:8089",
    healthPath: "/v1/models",
    defaultModel: "bitnet-b1.58-cpu",
    uncensoredLocal: true,
  },
  {
    id: "mistralrs",
    name: "mistral.rs Local Rust Engine (8080)",
    kind: "local",
    baseUrl: "http://127.0.0.1:8080",
    healthPath: "/v1/models",
    defaultModel: "mistralrs-local",
    uncensoredLocal: true,
  },
  {
    id: "vllm",
    name: "vLLM High-Throughput Engine (8000)",
    kind: "local",
    baseUrl: "http://127.0.0.1:8000",
    healthPath: "/v1/models",
    defaultModel: "vllm-local",
    uncensoredLocal: true,
  },
  {
    id: "ollama",
    name: "Ollama Local Model Runner (11434)",
    kind: "local",
    baseUrl: "http://127.0.0.1:11434",
    healthPath: "/api/tags",
    defaultModel: "qwen3:8b",
    uncensoredLocal: true,
  },
  {
    id: "open-webui",
    name: "Open WebUI Local Gateway (3000)",
    kind: "local",
    baseUrl: "http://127.0.0.1:3000",
    healthPath: "/api/version",
    authKeyName: "OPEN_WEBUI_API_KEY",
    defaultModel: "open-webui-default",
    uncensoredLocal: true,
  },
  {
    id: "google",
    name: "Google / DeepMind Gemini API",
    kind: "cloud",
    baseUrl: "https://generativelanguage.googleapis.com",
    healthPath: "/v1beta/models",
    authKeyName: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    uncensoredLocal: false,
  },
  {
    id: "anthropic",
    name: "Anthropic Claude Messages API",
    kind: "cloud",
    baseUrl: "https://api.anthropic.com",
    healthPath: "/v1/models",
    authKeyName: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-5",
    uncensoredLocal: false,
  },
  {
    id: "openai",
    name: "OpenAI / Vercel AI Gateway",
    kind: "cloud",
    baseUrl: "https://api.openai.com",
    healthPath: "/v1/models",
    authKeyName: "OPENAI_API_KEY",
    defaultModel: "gpt-4.1-mini",
    uncensoredLocal: false,
  },
];

function flattenContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part.text === "string" ? part.text : JSON.stringify(part),
      )
      .join("\n");
  }
  return String(content ?? "");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function listProviderDescriptors(): ProviderDescriptor[] {
  const env = getSovereignEnv();
  return FEDERATION_PROVIDERS.map((p) => {
    let keyVal: string | undefined;
    if (p.id === "google") {
      keyVal = env.get("GEMINI_API_KEY") ?? env.get("GOOGLE_API_KEY");
    } else if (p.id === "openai") {
      keyVal = env.get("OPENAI_API_KEY") ?? env.get("AI_GATEWAY_API_KEY");
    } else if (p.authKeyName) {
      keyVal = env.get(p.authKeyName);
    }
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      authKeyName: p.authKeyName,
      authStatus: p.authKeyName
        ? maskSecret(p.authKeyName, keyVal)
        : "LOCAL_NO_KEY_REQUIRED",
      defaultModel: p.defaultModel,
      uncensoredLocal: p.uncensoredLocal,
    };
  });
}

export async function probeLocalProviders(
  timeoutMs = 650,
): Promise<ProviderProbeResult[]> {
  const descriptors = listProviderDescriptors();
  return Promise.all(
    descriptors.map(async (desc) => {
      const spec = FEDERATION_PROVIDERS.find((x) => x.id === desc.id)!;
      if (spec.kind === "cloud") {
        const configured = desc.authStatus.startsWith("SET");
        return {
          ...desc,
          reachable: configured,
          latencyMs: 0,
          models: [desc.defaultModel],
          detail: configured
            ? "API key configured (redacted)"
            : "API key unset",
        };
      }

      const start = performance.now();
      try {
        const res = await fetch(`${spec.baseUrl}${spec.healthPath}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        const latencyMs = Math.round((performance.now() - start) * 100) / 100;
        const models: string[] = [];
        if (res.ok) {
          try {
            const body = (await res.json()) as Record<string, unknown>;
            if (Array.isArray(body.data)) {
              for (const item of body.data as Array<{ id?: string }>) {
                if (item.id) models.push(item.id);
              }
            } else if (Array.isArray(body.models)) {
              for (const item of body.models as Array<{
                name?: string;
                model?: string;
              }>) {
                const n = item.name ?? item.model;
                if (n) models.push(n);
              }
            }
          } catch {
            // non-JSON health endpoint
          }
        }
        return {
          ...desc,
          reachable: res.ok,
          latencyMs,
          models: models.length > 0 ? models : [desc.defaultModel],
          detail: `HTTP ${res.status}`,
        };
      } catch {
        return {
          ...desc,
          reachable: false,
          latencyMs: Math.round((performance.now() - start) * 100) / 100,
          models: [desc.defaultModel],
          detail: "offline",
        };
      }
    }),
  );
}

async function callOpenAiCompatibleEndpoint(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  req: ChatCompletionRequest,
  providerId: string,
  timeoutMs = 15000,
): Promise<ChatCompletionResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.max_tokens ?? 1024,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${providerId} returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const choices =
    (data.choices as Array<{ message?: { content?: string } }> | undefined) ??
    [];
  const text = choices[0]?.message?.content ?? "";
  const promptTokens = estimateTokens(
    req.messages.map((m) => flattenContent(m.content)).join(" "),
  );
  const completionTokens = estimateTokens(text);
  return {
    id:
      (typeof data.id === "string" ? data.id : null) ??
      `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    provider: providerId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function callOllamaEndpoint(
  model: string,
  req: ChatCompletionRequest,
  timeoutMs = 15000,
): Promise<ChatCompletionResponse> {
  const res = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: flattenContent(m.content),
      })),
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`ollama returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? "";
  const promptTokens = estimateTokens(
    req.messages.map((m) => flattenContent(m.content)).join(" "),
  );
  const completionTokens = estimateTokens(content);
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    provider: "ollama",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function callGeminiEndpoint(
  apiKey: string,
  model: string,
  req: ChatCompletionRequest,
  timeoutMs = 20000,
): Promise<ChatCompletionResponse> {
  const systemMsgs = req.messages
    .filter((m) => m.role === "system")
    .map((m) => flattenContent(m.content))
    .join("\n");
  const contents = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: flattenContent(m.content) }],
    }));

  const payload: Record<string, unknown> = {
    contents:
      contents.length > 0
        ? contents
        : [{ role: "user", parts: [{ text: "Hello" }] }],
    generationConfig: {
      temperature: req.temperature ?? 0.2,
      maxOutputTokens: req.max_tokens ?? 1024,
    },
  };
  if (systemMsgs.length > 0) {
    payload.systemInstruction = { parts: [{ text: systemMsgs }] };
  }

  const cleanModel = model.replace(/^google\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`gemini returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";
  const promptTokens = estimateTokens(
    req.messages.map((m) => flattenContent(m.content)).join(" "),
  );
  const completionTokens = estimateTokens(text);
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: cleanModel,
    provider: "google",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function callAnthropicEndpoint(
  apiKey: string,
  model: string,
  req: ChatCompletionRequest,
  timeoutMs = 20000,
): Promise<ChatCompletionResponse> {
  const systemMsgs = req.messages
    .filter((m) => m.role === "system")
    .map((m) => flattenContent(m.content))
    .join("\n");
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: flattenContent(m.content),
    }));

  const cleanModel = model.replace(/^anthropic\//, "");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cleanModel,
      max_tokens: req.max_tokens ?? 1024,
      system: systemMsgs || undefined,
      messages:
        messages.length > 0 ? messages : [{ role: "user", content: "Hello" }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`anthropic returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    id?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.map((c) => c.text ?? "").join("") ?? "";
  const promptTokens = estimateTokens(
    req.messages.map((m) => flattenContent(m.content)).join(" "),
  );
  const completionTokens = estimateTokens(text);
  return {
    id: data.id ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: cleanModel,
    provider: "anthropic",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function buildSovereignKernelFallback(
  model: string,
  req: ChatCompletionRequest,
): ChatCompletionResponse {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const promptText = lastUser ? flattenContent(lastUser.content) : "";
  const reply = `[ai-os sovereign-kernel v1.0.0 | model=${model}] Processed prompt (${promptText.length} chars): ${promptText.slice(0, 280)}`;
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(reply);
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    provider: "sovereign-local-kernel",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function federateRawChatCompletion(
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const env = getSovereignEnv();
  const requestedModel = (req.model ?? "ai-os/sovereign-default").replace(
    /:decide$/,
    "",
  );

  if (
    requestedModel === "ai-os/system1-bun" ||
    requestedModel === "system1-bun" ||
    req.provider === "system1-bun"
  ) {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const promptText = lastUser ? flattenContent(lastUser.content) : "";
    const envelope = decideSystem1(promptText, {
      tools: req.tools,
      includeBunDocsRefs: true,
    });
    const serialized = JSON.stringify(envelope);
    const promptTokens = estimateTokens(promptText);
    const completionTokens = estimateTokens(serialized);
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "ai-os/system1-bun",
      provider: "system1-bitnet-cpu-ssd",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: serialized },
          finish_reason:
            envelope.decision === "CALL_TOOL" ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  if (
    requestedModel === "ai-os/sovereign-local" ||
    requestedModel === "sovereign-local" ||
    req.provider === "sovereign-local"
  ) {
    return buildSovereignKernelFallback(requestedModel, req);
  }

  // Explicit provider / model prefix routing (Keyless Vertex AI ADC first, then API key)
  if (
    requestedModel.startsWith("gemini-") ||
    requestedModel.startsWith("google/") ||
    req.provider === "google"
  ) {
    const cleanModel = requestedModel.replace(/^google\//, "");
    const minted = await mintGoogleAccessToken();
    if (minted.token) {
      try {
        const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(minted.projectId)}/locations/global/publishers/google/models/${encodeURIComponent(cleanModel)}:generateContent`;
        const contents = req.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: flattenContent(m.content) }],
          }));
        const res = await fetch(vertexUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${minted.token}`,
            "x-goog-user-project": minted.projectId,
          },
          body: JSON.stringify({
            contents:
              contents.length > 0
                ? contents
                : [{ role: "user", parts: [{ text: "Hello" }] }],
            generationConfig: {
              temperature: req.temperature ?? 0.2,
              maxOutputTokens: req.max_tokens ?? 1024,
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
            }>;
          };
          const text =
            data.candidates?.[0]?.content?.parts
              ?.map((p) => p.text ?? "")
              .join("") ?? "";
          if (text) {
            const promptTokens = estimateTokens(
              req.messages.map((m) => flattenContent(m.content)).join(" "),
            );
            const completionTokens = estimateTokens(text);
            return {
              id: `chatcmpl-${crypto.randomUUID()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: cleanModel,
              provider: "google-vertex-keyless",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: text },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            };
          }
        }
      } catch {
        // Fall through to GEMINI_API_KEY
      }
    }

    const key = env.get("GEMINI_API_KEY") ?? env.get("GOOGLE_API_KEY");
    if (key) {
      try {
        return await callGeminiEndpoint(key, requestedModel, req);
      } catch {
        // fall through to local sovereign fallback
      }
    }
  }

  if (
    requestedModel.startsWith("claude-") ||
    requestedModel.startsWith("anthropic/") ||
    req.provider === "anthropic"
  ) {
    const key = env.get("ANTHROPIC_API_KEY");
    if (key) {
      try {
        return await callAnthropicEndpoint(key, requestedModel, req);
      } catch {
        // fall through
      }
    }
  }

  if (
    requestedModel.startsWith("gpt-") ||
    requestedModel.startsWith("openai/") ||
    req.provider === "openai"
  ) {
    const key = env.get("OPENAI_API_KEY") ?? env.get("AI_GATEWAY_API_KEY");
    const gatewayUrl =
      req.provider === "vercel"
        ? "https://ai-gateway.vercel.sh"
        : "https://api.openai.com";
    if (key) {
      try {
        return await callOpenAiCompatibleEndpoint(
          gatewayUrl,
          key,
          requestedModel.replace(/^openai\//, ""),
          req,
          "openai",
        );
      } catch {
        // fall through
      }
    }
  }

  // Probe local zero-refusal engines in priority order with fast connect timeout
  const localOpenAiCandidates: Array<{
    id: string;
    baseUrl: string;
    apiKey?: string;
  }> = [
    { id: "ring3-agent", baseUrl: "http://127.0.0.1:8787" },
    { id: "locally-uncensored", baseUrl: "http://127.0.0.1:8129" },
    { id: "llamacpp-primary", baseUrl: "http://127.0.0.1:8081" },
    { id: "llamacpp-secondary", baseUrl: "http://127.0.0.1:8084" },
    { id: "mistralrs", baseUrl: "http://127.0.0.1:8080" },
    { id: "vllm", baseUrl: "http://127.0.0.1:8000" },
    {
      id: "open-webui",
      baseUrl: "http://127.0.0.1:3000/api",
      apiKey: env.get("OPEN_WEBUI_API_KEY"),
    },
  ];

  for (const cand of localOpenAiCandidates) {
    if (req.provider && req.provider !== cand.id) continue;
    try {
      return await callOpenAiCompatibleEndpoint(
        cand.baseUrl,
        cand.apiKey,
        requestedModel,
        req,
        cand.id,
        900,
      );
    } catch {
      // try next local engine
    }
  }

  if (!req.provider || req.provider === "ollama") {
    try {
      return await callOllamaEndpoint(requestedModel, req, 900);
    } catch {
      // fall through
    }
  }

  // Try cloud fallback if keys are available and no local daemon is active
  const geminiKey = env.get("GEMINI_API_KEY") ?? env.get("GOOGLE_API_KEY");
  if (geminiKey && requestedModel === "ai-os/cloud-auto") {
    try {
      return await callGeminiEndpoint(geminiKey, "gemini-2.5-flash", req);
    } catch {
      // fall through
    }
  }

  return buildSovereignKernelFallback(requestedModel, req);
}

export async function federateChatCompletion(
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const res = await federateRawChatCompletion(req);
  const wantDecide =
    req.decision_mode === true || (req.model ?? "").endsWith(":decide");
  if (!wantDecide) return res;

  const rawText = res.choices[0]?.message.content ?? "";
  const envelope = convertVerboseLlmToDecision(rawText, {
    tools: req.tools,
    includeBunDocsRefs: true,
  });
  const serialized = JSON.stringify(envelope);
  return {
    ...res,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: serialized },
        finish_reason:
          envelope.decision === "CALL_TOOL" ? "tool_calls" : "stop",
      },
    ],
  };
}

export function createOpenAiSseStream(
  completion: ChatCompletionResponse,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const content = completion.choices[0]?.message.content ?? "";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const roleChunk = {
        id: completion.id,
        object: "chat.completion.chunk",
        created: completion.created,
        model: completion.model,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      };
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`),
      );

      const words = content.split(/(\s+)/).filter((w) => w.length > 0);
      for (const piece of words) {
        const chunk = {
          id: completion.id,
          object: "chat.completion.chunk",
          created: completion.created,
          model: completion.model,
          choices: [
            { index: 0, delta: { content: piece }, finish_reason: null },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }

      const stopChunk = {
        id: completion.id,
        object: "chat.completion.chunk",
        created: completion.created,
        model: completion.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

export function createVercelDataStream(
  completion: ChatCompletionResponse,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const content = completion.choices[0]?.message.content ?? "";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
      controller.enqueue(
        encoder.encode(
          `d:${JSON.stringify({
            finishReason: "stop",
            usage: {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
            },
          })}\n`,
        ),
      );
      controller.close();
    },
  });
}

export function computeDeterministicEmbedding(
  input: string,
  dimensions = 64,
): number[] {
  const vec = new Array<number>(dimensions).fill(0);
  const bytes = new TextEncoder().encode(input);
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 16777619) >>> 0;
    const slot = i % dimensions;
    vec[slot] = (vec[slot] ?? 0) + ((hash & 0xffff) / 32767.5 - 1.0);
  }
  let normSq = 0;
  for (let i = 0; i < dimensions; i++) {
    normSq += (vec[i] ?? 0) * (vec[i] ?? 0);
  }
  const norm = Math.sqrt(normSq) || 1;
  return vec.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}
