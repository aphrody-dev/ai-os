import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  federateChatCompletion,
} from "../providers/federation.ts";

// ============================================================================
// 1. Vercel AI SDK v5/v6 UIMessageStream SSE Protocol (`x-vercel-ai-ui-message-stream: v1`)
// ============================================================================

export function createVercelUiMessageStream(
  completion: ChatCompletionResponse,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const messageId = completion.id || `msg_${crypto.randomUUID().slice(0, 12)}`;
  const textPartId = `txt_${crypto.randomUUID().slice(0, 8)}`;
  const text = completion.choices[0]?.message.content ?? "";

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const sendEvent = (payload: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      sendEvent({ type: "start", messageId });
      sendEvent({ type: "text-start", id: textPartId });
      if (text.length > 0) {
        // Emit deterministic chunks compatible with Vercel AI SDK useChat / streamText
        const chunkSize = 256;
        for (let i = 0; i < text.length; i += chunkSize) {
          sendEvent({
            type: "text-delta",
            id: textPartId,
            delta: text.slice(i, i + chunkSize),
          });
        }
      }
      sendEvent({ type: "text-end", id: textPartId });
      sendEvent({
        type: "finish",
        finishReason: completion.choices[0]?.finish_reason ?? "stop",
        messageMetadata: {
          model: completion.model,
          provider: completion.provider,
          usage: completion.usage,
        },
      });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

export async function handleVercelStreamRequest(
  req: Request,
): Promise<Response> {
  let body: {
    id?: string;
    model?: string;
    provider?: string;
    messages?: Array<{
      role?: string;
      content?: string;
      parts?: Array<{ type?: string; text?: string }>;
    }>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body for Vercel UIMessageStream" } },
      { status: 400 },
    );
  }

  const normalizedMessages: ChatCompletionRequest["messages"] = (
    body.messages ?? []
  ).map((m) => {
    const role =
      m.role === "system" || m.role === "assistant" || m.role === "tool"
        ? m.role
        : "user";
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.parts)
          ? m.parts
              .filter((p) => typeof p.text === "string")
              .map((p) => p.text)
              .join("\n")
          : "";
    return { role, content };
  });

  if (normalizedMessages.length === 0) {
    return Response.json(
      { error: { message: "messages array must be non-empty" } },
      { status: 400 },
    );
  }

  const completion = await federateChatCompletion({
    model: body.model,
    provider: body.provider,
    messages: normalizedMessages,
    stream: true,
  });

  return new Response(createVercelUiMessageStream(completion), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

// ============================================================================
// 2. Anthropic Messages API (`POST /v1/messages` unified on ai-os :4318)
// ============================================================================

export async function handleAnthropicMessagesRequest(
  req: Request,
): Promise<Response> {
  let body: {
    model?: string;
    system?: string | Array<{ type?: string; text?: string }>;
    messages?: Array<{
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    }>;
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid JSON body" },
      },
      { status: 400 },
    );
  }

  const chatMessages: ChatCompletionRequest["messages"] = [];
  if (typeof body.system === "string" && body.system.trim()) {
    chatMessages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const sysText = body.system
      .map((b) => b.text ?? "")
      .filter(Boolean)
      .join("\n");
    if (sysText) chatMessages.push({ role: "system", content: sysText });
  }

  for (const m of body.messages ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((c) => c.text ?? "")
              .filter(Boolean)
              .join("\n")
          : "";
    chatMessages.push({ role, content: text });
  }

  if (chatMessages.length === 0) {
    return Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "messages must be non-empty",
        },
      },
      { status: 400 },
    );
  }

  const completion = await federateChatCompletion({
    model: body.model,
    messages: chatMessages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
  });

  const assistantText = completion.choices[0]?.message.content ?? "";
  const msgId = `msg_${completion.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`;

  if (body.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        };
        emit("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: completion.model,
            content: [],
            stop_reason: null,
            usage: {
              input_tokens: completion.usage.prompt_tokens,
              output_tokens: 0,
            },
          },
        });
        emit("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        emit("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: assistantText },
        });
        emit("content_block_stop", { type: "content_block_stop", index: 0 });
        emit("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: completion.usage.completion_tokens },
        });
        emit("message_stop", { type: "message_stop" });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }

  return Response.json({
    id: msgId,
    type: "message",
    role: "assistant",
    model: completion.model,
    provider: completion.provider,
    content: [{ type: "text", text: assistantText }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage.prompt_tokens,
      output_tokens: completion.usage.completion_tokens,
    },
  });
}

// ============================================================================
// 3. Google DeepMind Gemma 4 Multimodal & Thinking Chat Formatter
// ============================================================================

export interface Gemma4Turn {
  role: "system" | "user" | "model" | "assistant";
  content: string;
  thought?: string;
  imagesCount?: number;
}

export function formatGemma4Prompt(
  turns: Gemma4Turn[],
  options?: { enableThinking?: boolean; addGenerationPrompt?: boolean },
): string {
  const parts: string[] = ["<bos>"];
  let systemPrefix = "";

  for (const turn of turns) {
    if (turn.role === "system") {
      systemPrefix += `${turn.content.trim()}\n\n`;
      continue;
    }
    const mappedRole = turn.role === "assistant" ? "model" : turn.role;
    parts.push(`<start_of_turn>${mappedRole}\n`);
    if (mappedRole === "user" && systemPrefix) {
      parts.push(systemPrefix);
      systemPrefix = "";
    }
    if (turn.imagesCount && turn.imagesCount > 0) {
      for (let i = 0; i < turn.imagesCount; i++) {
        parts.push("<start_of_image>");
      }
    }
    if (mappedRole === "model" && turn.thought) {
      parts.push(`<thought>\n${turn.thought.trim()}\n</thought>\n`);
    }
    parts.push(`${turn.content}<end_of_turn>\n`);
  }

  if (options?.addGenerationPrompt !== false) {
    parts.push("<start_of_turn>model\n");
    if (options?.enableThinking) {
      parts.push("<thought>\n");
    }
  }

  return parts.join("");
}

// ============================================================================
// 4. Llama / ggml GGUF v2/v3 Binary Header Inspector (Zero-Copy Uint8Array)
// ============================================================================

export interface GgufHeaderSummary {
  valid: boolean;
  magic: string;
  version: number;
  tensorCount: number;
  metadataKvCount: number;
  error?: string;
}

export function parseGgufHeader(bytes: Uint8Array): GgufHeaderSummary {
  if (bytes.byteLength < 24) {
    return {
      valid: false,
      magic: "",
      version: 0,
      tensorCount: 0,
      metadataKvCount: 0,
      error: "Buffer smaller than 24-byte GGUF header",
    };
  }
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== "GGUF") {
    return {
      valid: false,
      magic,
      version: 0,
      tensorCount: 0,
      metadataKvCount: 0,
      error: `Invalid magic '${magic}', expected 'GGUF'`,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const tensorCount = Number(view.getBigUint64(8, true));
  const metadataKvCount = Number(view.getBigUint64(16, true));

  return {
    valid: version >= 2 && version <= 4,
    magic,
    version,
    tensorCount,
    metadataKvCount,
  };
}

export function buildSyntheticGgufHeader(options?: {
  version?: number;
  tensorCount?: number;
  metadataKvCount?: number;
}): Uint8Array {
  const buf = new Uint8Array(24);
  buf[0] = 0x47; // G
  buf[1] = 0x47; // G
  buf[2] = 0x55; // U
  buf[3] = 0x46; // F
  const view = new DataView(buf.buffer);
  view.setUint32(4, options?.version ?? 3, true);
  view.setBigUint64(8, BigInt(options?.tensorCount ?? 291), true);
  view.setBigUint64(16, BigInt(options?.metadataKvCount ?? 34), true);
  return buf;
}

export const FUSED_ECOSYSTEM_PROTOCOLS = [
  {
    ecosystem: "Vercel & Vercel-Labs",
    spec: "UIMessageStream v1 SSE + DataStream v1 + just-bash POSIX",
    endpoints: ["/v1/vercel/stream", "/v1/chat/completions"],
    tier: "tier1-rust-bun",
  },
  {
    ecosystem: "Google DeepMind & Google",
    spec: "Vertex AI Grounded Search + A2A JSON-RPC + Gemma 4 Chat/Thought",
    endpoints: ["/.well-known/agent.json", "/a2a"],
    tier: "tier1-rust-bun",
  },
  {
    ecosystem: "OpenAI",
    spec: "Chat Completions + Responses API + Embeddings",
    endpoints: ["/v1/chat/completions", "/v1/responses", "/v1/embeddings"],
    tier: "tier1-rust-bun",
  },
  {
    ecosystem: "Anthropic & Linux Foundation",
    spec: "Messages API + MCP 2025-03-26 + ACP + SKILL.md",
    endpoints: ["/v1/messages", "/mcp", "/acp", "/api/skills"],
    tier: "tier1-rust-bun",
  },
  {
    ecosystem: "Llama / ggml / Heretic",
    spec: "GGUF v3 Binary Inspector + llama.cpp / Ring-3 CUDA sm_89 + Heretic Abliteration",
    endpoints: ["/ollama/api/tags", "/api/cuda"],
    tier: "tier2-proven-accelerator",
  },
] as const;
