// Anthropic Messages <-> OpenAI chat/completions (request, response, SSE), so Claude Code, Codex, OpenCode and agy
// can use the relay as an Anthropic base URL while the router speaks OpenAI to every provider.
const text = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
      : "";

const image = (b: any) => ({
  type: "image_url",
  image_url: {
    url:
      b.source?.type === "base64"
        ? `data:${b.source.media_type};base64,${b.source.data}`
        : String(b.source?.url ?? ""),
  },
});

export function anthropicToOpenAI(r: any) {
  const messages: any[] = [];
  const sys = text(r.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of r.messages ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: any[] = m.content ?? [];
    // tool results come first (OpenAI wants them right after the assistant tool_calls), then the user's own parts.
    for (const b of blocks.filter((x) => x.type === "tool_result"))
      messages.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: text(b.content) || (b.is_error ? "error" : ""),
      });
    const parts = blocks
      .filter((x) => x.type === "text" || x.type === "image")
      .map((x) =>
        x.type === "text" ? { type: "text", text: x.text } : image(x),
      );
    const calls = blocks
      .filter((x) => x.type === "tool_use")
      .map((x) => ({
        id: x.id,
        type: "function",
        function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) },
      }));
    if (m.role === "assistant") {
      if (parts.length || calls.length)
        messages.push({
          role: "assistant",
          content: parts.map((p: any) => p.text ?? "").join("") || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
    } else if (parts.length) {
      messages.push({
        role: "user",
        content: parts.every((p: any) => p.type === "text")
          ? parts.map((p: any) => p.text).join("")
          : parts,
      });
    }
  }
  const tc = r.tool_choice;
  return {
    model: r.model,
    messages,
    stream: r.stream === true,
    ...(r.max_tokens ? { max_tokens: r.max_tokens } : {}),
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
    ...(r.top_p !== undefined ? { top_p: r.top_p } : {}),
    ...(r.stop_sequences?.length ? { stop: r.stop_sequences } : {}),
    ...(r.tools?.length
      ? {
          tools: r.tools.map((t: any) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description ?? "",
              parameters: t.input_schema ?? { type: "object" },
            },
          })),
          ...(tc?.type === "any"
            ? { tool_choice: "required" }
            : tc?.type === "tool"
              ? {
                  tool_choice: {
                    type: "function",
                    function: { name: tc.name },
                  },
                }
              : tc?.type === "none"
                ? { tool_choice: "none" }
                : { tool_choice: "auto" }),
        }
      : {}),
  };
}

const STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "end_turn",
};

export function openAIToAnthropic(j: any, model: string) {
  const c = j.choices?.[0] ?? {};
  const m = c.message ?? {};
  const content: any[] = [];
  const t = text(m.content);
  if (t) content.push({ type: "text", text: t });
  for (const tc of m.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {}
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function?.name,
      input,
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: `msg_${String(j.id ?? crypto.randomUUID())
      .replace(/\W/g, "")
      .slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP[c.finish_reason] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: j.usage?.prompt_tokens ?? 0,
      output_tokens: j.usage?.completion_tokens ?? 0,
    },
  };
}

/** OpenAI SSE -> Anthropic SSE events. */
export function anthropicStream(
  src: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ev = (name: string, data: unknown) =>
    enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  let buf = "";
  let started = false;
  let idx = -1;
  let open: "text" | "tool" | undefined;
  const tools = new Map<number, number>();
  let stop = "end_turn";
  let inTok = 0;
  let outTok = 0;
  const closeBlock = (c: TransformStreamDefaultController<Uint8Array>) => {
    if (open)
      c.enqueue(
        ev("content_block_stop", { type: "content_block_stop", index: idx }),
      );
    open = undefined;
  };
  const begin = (c: TransformStreamDefaultController<Uint8Array>) => {
    if (started) return;
    started = true;
    c.enqueue(
      ev("message_start", {
        type: "message_start",
        message: {
          id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  };
  const frame = (
    line: string,
    c: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (!line.startsWith("data:")) return;
    const d = line.slice(5).trim();
    if (!d || d === "[DONE]") return;
    let j: any;
    try {
      j = JSON.parse(d);
    } catch {
      return;
    }
    begin(c);
    if (j.usage) {
      inTok = j.usage.prompt_tokens ?? inTok;
      outTok = j.usage.completion_tokens ?? outTok;
    }
    const ch = j.choices?.[0];
    if (!ch) return;
    const delta = ch.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (open !== "text") {
        closeBlock(c);
        idx++;
        open = "text";
        c.enqueue(
          ev("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      c.enqueue(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: idx,
          delta: { type: "text_delta", text: delta.content },
        }),
      );
    }
    for (const tc of delta.tool_calls ?? []) {
      const n = tc.index ?? 0;
      if (!tools.has(n) || (tc.id && open !== "tool")) {
        closeBlock(c);
        idx++;
        tools.set(n, idx);
        open = "tool";
        c.enqueue(
          ev("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `toolu_${crypto.randomUUID().slice(0, 12)}`,
              name: tc.function?.name ?? "",
              input: {},
            },
          }),
        );
      }
      if (tc.function?.arguments)
        c.enqueue(
          ev("content_block_delta", {
            type: "content_block_delta",
            index: tools.get(n)!,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          }),
        );
    }
    if (ch.finish_reason) stop = STOP[ch.finish_reason] ?? "end_turn";
  };
  return src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          frame(buf.slice(0, i).trim(), c);
          buf = buf.slice(i + 1);
        }
      },
      flush(c) {
        if (buf.trim()) frame(buf.trim(), c);
        begin(c);
        closeBlock(c);
        c.enqueue(
          ev("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stop, stop_sequence: null },
            usage: { input_tokens: inTok, output_tokens: outTok },
          }),
        );
        c.enqueue(ev("message_stop", { type: "message_stop" }));
      },
    }),
  );
}
