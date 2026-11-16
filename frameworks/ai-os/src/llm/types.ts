// Types of the single model bridge: messages, tool calls and the LanguageModel contract used by the agent loop,
// the relay, research and the gateway. Wire format follows OpenAI chat/completions (function tools).

/** JSON Schema subset understood by validate() (type, properties, required, items, enum, minItems, minLength, format uri). */
export type JsonSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  minItems?: number;
  minLength?: number;
  format?: string;
  additionalProperties?: boolean;
};

export type ToolCall = { id: string; name: string; input: unknown };

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ChatRequest = {
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "required" | "none";
  maxOutputTokens?: number;
  /** 0 (or an integer seed) makes the request deterministic, hence cacheable by the relay (relay/outbound.ts). */
  temperature?: number;
  seed?: number;
  /** Structured output: JSON schema the answer must match (OpenAI `response_format` json_schema). */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  /** Thinking level of reasoning models (OpenAI `reasoning_effort`: low, medium, high). */
  reasoningEffort?: string;
  signal?: AbortSignal;
};

export type Usage = { inputTokens?: number; outputTokens?: number };

export type ChatResponse = {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: Usage;
};

/** A model addressed as `provider/model`. Providers without tool calling (CLI agents) return text only. */
export interface LanguageModel {
  readonly id: string;
  readonly tools: boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** Tool given to generateText(): JSON Schema input, validated before execute(). */
export type Tool<I = any> = {
  description: string;
  inputSchema: JsonSchema;
  execute: (input: I) => unknown | Promise<unknown>;
};
export type ToolSet = Record<string, Tool>;

/** Anything that maps texts to vectors (hash embedder offline, or a discovered `provider/model` /v1/embeddings). */
export type Embedder = {
  id: string;
  embed(texts: string[]): Promise<number[][]>;
};
