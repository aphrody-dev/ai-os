import {
  type ChatCompletionRequest,
  computeDeterministicEmbedding,
  createOpenAiSseStream,
  createVercelDataStream,
  federateChatCompletion,
  listProviderDescriptors,
  probeLocalProviders,
} from "../providers/federation.ts";

export async function handleModelsListRequest(): Promise<Response> {
  const descriptors = listProviderDescriptors();
  const created = Math.floor(Date.now() / 1000);
  const models = [
    {
      id: "ai-os/system1-bun",
      object: "model",
      created,
      owned_by: "ai-os",
      provider: "system1-bitnet-cpu-ssd",
      zeroGpu: true,
    },
    {
      id: "ai-os/sovereign-local",
      object: "model",
      created,
      owned_by: "ai-os",
      provider: "sovereign-local-kernel",
    },
    {
      id: "ai-os/sovereign-default",
      object: "model",
      created,
      owned_by: "ai-os",
      provider: "federation-auto",
    },
    ...descriptors.map((d) => ({
      id: d.defaultModel,
      object: "model",
      created,
      owned_by: d.id,
      provider: d.id,
      kind: d.kind,
      uncensoredLocal: d.uncensoredLocal,
    })),
  ];

  return Response.json({
    object: "list",
    data: models,
  });
}

export async function handleChatCompletionsRequest(
  req: Request,
): Promise<Response> {
  let body: ChatCompletionRequest;
  try {
    body = (await req.json()) as ChatCompletionRequest;
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json(
      { error: { message: "messages array must be non-empty" } },
      { status: 400 },
    );
  }

  const completion = await federateChatCompletion(body);
  const streamFormat = req.headers.get("x-vercel-ai-data-stream");

  if (body.stream) {
    if (streamFormat === "v1") {
      return new Response(createVercelDataStream(completion), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-vercel-ai-data-stream": "v1",
          "cache-control": "no-cache",
        },
      });
    }
    return new Response(createOpenAiSseStream(completion), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  return Response.json(completion);
}

export async function handleResponsesRequest(req: Request): Promise<Response> {
  let body: {
    model?: string;
    input?: string | Array<{ role?: string; content?: string }>;
    instructions?: string;
    temperature?: number;
    max_output_tokens?: number;
    stream?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const messages: ChatCompletionRequest["messages"] = [];
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      messages.push({
        role:
          item.role === "system" || item.role === "assistant"
            ? item.role
            : "user",
        content: item.content ?? "",
      });
    }
  } else {
    messages.push({ role: "user", content: "" });
  }

  const completion = await federateChatCompletion({
    model: body.model,
    messages,
    temperature: body.temperature,
    max_tokens: body.max_output_tokens,
  });

  const text = completion.choices[0]?.message.content ?? "";
  return Response.json({
    id: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: completion.created,
    status: "completed",
    model: completion.model,
    output_text: text,
    output: [
      {
        type: "message",
        id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: completion.usage.prompt_tokens,
      output_tokens: completion.usage.completion_tokens,
      total_tokens: completion.usage.total_tokens,
    },
  });
}

export async function handleEmbeddingsRequest(req: Request): Promise<Response> {
  let body: { model?: string; input?: string | string[]; dimensions?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const model = body.model ?? "ai-os-embed-v1";
  const dims =
    typeof body.dimensions === "number" && body.dimensions > 0
      ? body.dimensions
      : 64;
  const inputs = Array.isArray(body.input)
    ? body.input.map(String)
    : [String(body.input ?? "")];

  const data = inputs.map((text, index) => ({
    object: "embedding",
    index,
    embedding: computeDeterministicEmbedding(text, dims),
  }));

  const tokenCount = inputs.reduce(
    (acc, s) => acc + Math.max(1, Math.ceil(s.length / 4)),
    0,
  );
  return Response.json({
    object: "list",
    data,
    model,
    usage: {
      prompt_tokens: tokenCount,
      total_tokens: tokenCount,
    },
  });
}

export function handleOpenWebUiVersionRequest(): Response {
  return Response.json({
    version: "1.0.0",
    engine: "ai-os-sovereign-bun",
    bunVersion: Bun.version,
    status: true,
  });
}

export async function handleOllamaTagsBridgeRequest(): Promise<Response> {
  const probed = await probeLocalProviders(450);
  const nowIso = new Date().toISOString();
  const models = [
    {
      name: "ai-os/sovereign-local:latest",
      model: "ai-os/sovereign-local:latest",
      modified_at: nowIso,
      size: 0,
      digest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      details: {
        format: "sovereign",
        family: "ai-os",
        parameter_size: "native",
        quantization_level: "FP16",
      },
    },
    ...probed.map((p) => ({
      name: `${p.defaultModel}:latest`,
      model: `${p.defaultModel}:latest`,
      modified_at: nowIso,
      size: 0,
      digest: `sha256:${Bun.CryptoHasher.hash("sha256", p.id, "hex")}`,
      details: {
        format: p.kind,
        family: p.id,
        reachable: p.reachable,
      },
    })),
  ];

  return Response.json({ models });
}
