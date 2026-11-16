// Tool loop (replaces the AI SDK generateText): call the model, run the requested tools, feed the results back,
// stop when the model answers without tool calls or after maxSteps.
import { validate } from "./schema";
import type {
  ChatResponse,
  LanguageModel,
  Message,
  Tool,
  ToolCall,
  ToolSet,
  Usage,
} from "./types";

export const tool = <I = any>(t: Tool<I>): Tool<I> => t;

export type Step = ChatResponse & {
  toolResults: { call: ToolCall; output: unknown; error?: string }[];
};

export type GenerateOptions = {
  model: LanguageModel;
  system?: string;
  prompt?: string;
  messages?: Message[];
  tools?: ToolSet;
  /** Default 1 (one model call), as in the AI SDK; raise it for agentic runs. */
  maxSteps?: number;
  /** Force a tool call on the first step (weak local models). */
  requireToolFirst?: boolean;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onStep?: (s: Step) => void;
};

export type GenerateResult = {
  text: string;
  finishReason: string;
  steps: Step[];
  toolCalls: ToolCall[];
  /** Messages produced by this call (assistant and tool turns), to append to a session history. */
  response: Message[];
  usage: Usage;
};

/** Tool output as text; BigInt, cycles, functions and symbols never throw out of the loop. */
export const stringify = (v: unknown): string => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v ?? null) ?? String(v);
  } catch {
    return String(v);
  }
};

export async function generateText(
  o: GenerateOptions,
): Promise<GenerateResult> {
  const input: Message[] = [
    ...(o.messages ?? []),
    ...(o.prompt !== undefined
      ? [{ role: "user" as const, content: o.prompt }]
      : []),
  ];
  const response: Message[] = [];
  const steps: Step[] = [];
  const specs = Object.entries(o.tools ?? {}).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const max = Math.max(1, o.maxSteps ?? 1);
  for (let i = 0; i < max; i++) {
    o.signal?.throwIfAborted();
    const r = await o.model.chat({
      system: o.system,
      messages: [...input, ...response],
      tools: o.model.tools && specs.length ? specs : undefined,
      toolChoice: o.requireToolFirst && i === 0 ? "required" : "auto",
      maxOutputTokens: o.maxOutputTokens,
      signal: o.signal,
    });
    usage.inputTokens! += r.usage?.inputTokens ?? 0;
    usage.outputTokens! += r.usage?.outputTokens ?? 0;
    response.push({
      role: "assistant",
      content: r.text,
      ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
    });
    const step: Step = { ...r, toolResults: [] };
    for (const call of r.toolCalls) {
      o.signal?.throwIfAborted();
      const t =
        o.tools && Object.hasOwn(o.tools, call.name)
          ? o.tools[call.name]
          : undefined;
      let output: unknown;
      let error: string | undefined;
      if (!t) error = `unknown tool ${call.name}`;
      else {
        const bad = validate(t.inputSchema, call.input);
        if (bad.length) error = `invalid input: ${bad.join("; ")}`;
        else
          try {
            output = await t.execute(call.input);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
      }
      step.toolResults.push({ call, output, error });
      response.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: error ? `error: ${error}` : stringify(output),
      });
    }
    steps.push(step);
    o.onStep?.(step);
    if (!r.toolCalls.length) break;
  }
  const last = steps.at(-1)!;
  return {
    text: last.text,
    finishReason: last.finishReason,
    steps,
    toolCalls: steps.flatMap((s) => s.toolCalls),
    response,
    usage,
  };
}
