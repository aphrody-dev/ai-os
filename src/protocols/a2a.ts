import { federateChatCompletion } from "../providers/federation.ts";
import { executeMcpTool } from "./mcp.ts";

export type A2ATaskState =
  "submitted" | "working" | "completed" | "failed" | "canceled";

export interface A2APart {
  type: "text" | "data";
  text?: string;
  data?: Record<string, unknown>;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2APart[];
}

export interface A2AArtifact {
  name: string;
  description?: string;
  parts: A2APart[];
  index: number;
}

export interface A2ATask {
  id: string;
  sessionId: string;
  status: {
    state: A2ATaskState;
    message?: A2AMessage;
    timestamp: string;
  };
  history: A2AMessage[];
  artifacts: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

const taskStore = new Map<string, A2ATask>();

export function buildAgentCard(origin: string): Record<string, unknown> {
  return {
    name: "Sovereign AI-OS Control Plane",
    description:
      "Unified Sovereign AI Control Plane on pure Bun v1.4.4 uniting OpenAI, MCP, A2A, ACP, native agent-desktop FFI, agent-browser CDP, and Real-Time/Nightly Standards Sentinel.",
    url: `${origin}/`,
    provider: {
      organization: "aphrody-dev",
      url: "https://aphrody.com",
    },
    version: "1.0.0",
    documentationUrl:
      "file:///C:/src/ai-os/COMPARISON_AND_INTEGRATION_MATRIX.md",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: ["Bearer", "None"],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "desktop-automation",
        name: "Native OS Accessibility & Computer Use",
        description:
          "Snapshots OS windows and executes ref-addressed UI actions in-process via agent_desktop_ffi.dll (ABI v7).",
        tags: ["desktop", "accessibility", "uiautomation", "ffi"],
        examples: ["Take a compact snapshot of the focused desktop window"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json", "text/plain"],
      },
      {
        id: "browser-cdp-a11y",
        name: "Headless & Headed Browser CDP + Axe-Core A11y",
        description:
          "Navigates pages and extracts semantic accessibility trees via Fat-LTO Rust agent-browser.exe.",
        tags: ["browser", "cdp", "a11y", "webgpu"],
        examples: ["Inspect browser version and accessibility tree"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json", "text/plain"],
      },
      {
        id: "standards-sentinel",
        name: "Real-Time & Nightly Standards Sentinel",
        description:
          "Synchronizes Web, Linux 7.4, Windows Insiders, Chrome Canary, Android 17/18, and AI protocol upstream feeds.",
        tags: ["sentinel", "standards", "chrome-canary", "kernel"],
        examples: ["Check upstream standards status"],
        inputModes: ["text/plain"],
        outputModes: ["application/json", "text/markdown"],
      },
      {
        id: "federated-inference",
        name: "Multi-Provider Cloud & Uncensored Local Inference",
        description:
          "Routes prompts across Ring-3 r3d, Locally Uncensored, llama.cpp, Ollama, vLLM, Gemini, Claude, and OpenAI.",
        tags: ["inference", "llm", "local", "cloud"],
        examples: ["Synthesize architectural guidance across C:\\src"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      },
    ],
  };
}

function extractUserText(msg: A2AMessage | undefined): string {
  if (!msg || !Array.isArray(msg.parts)) return "";
  return msg.parts
    .map((p) =>
      p.type === "text" ? (p.text ?? "") : JSON.stringify(p.data ?? {}),
    )
    .join("\n")
    .trim();
}

async function runTaskLifecycle(
  id: string,
  sessionId: string,
  userMessage: A2AMessage,
  metadata?: Record<string, unknown>,
  onTransition?: (task: A2ATask) => void,
): Promise<A2ATask> {
  const submittedTask: A2ATask = {
    id,
    sessionId,
    status: {
      state: "submitted",
      timestamp: new Date().toISOString(),
    },
    history: [userMessage],
    artifacts: [],
    metadata,
  };
  taskStore.set(id, submittedTask);
  onTransition?.(structuredClone(submittedTask));

  submittedTask.status = {
    state: "working",
    timestamp: new Date().toISOString(),
  };
  onTransition?.(structuredClone(submittedTask));

  try {
    const promptText = extractUserText(userMessage);
    let replyText = "";
    let structuredData: Record<string, unknown> | undefined;

    if (metadata?.tool && typeof metadata.tool === "string") {
      const toolOut = await executeMcpTool(
        metadata.tool,
        (metadata.toolArgs as Record<string, unknown> | undefined) ?? {},
      );
      replyText = toolOut.content.map((c) => c.text).join("\n");
      if (toolOut.structured && typeof toolOut.structured === "object") {
        structuredData = toolOut.structured as Record<string, unknown>;
      }
    } else {
      const completion = await federateChatCompletion({
        model:
          typeof metadata?.model === "string"
            ? metadata.model
            : "ai-os/sovereign-default",
        messages: [{ role: "user", content: promptText || "status" }],
      });
      replyText = completion.choices[0]?.message.content ?? "";
    }

    const agentMsg: A2AMessage = {
      role: "agent",
      parts: [{ type: "text", text: replyText }],
    };
    submittedTask.history.push(agentMsg);

    const artifactParts: A2APart[] = [{ type: "text", text: replyText }];
    if (structuredData) {
      artifactParts.push({ type: "data", data: structuredData });
    }
    submittedTask.artifacts.push({
      name: "result",
      index: 0,
      parts: artifactParts,
    });

    if (submittedTask.status.state !== "canceled") {
      submittedTask.status = {
        state: "completed",
        message: agentMsg,
        timestamp: new Date().toISOString(),
      };
    }
    onTransition?.(structuredClone(submittedTask));
    return submittedTask;
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    const failMsg: A2AMessage = {
      role: "agent",
      parts: [{ type: "text", text: `Task failed: ${errText}` }],
    };
    submittedTask.status = {
      state: "failed",
      message: failMsg,
      timestamp: new Date().toISOString(),
    };
    onTransition?.(structuredClone(submittedTask));
    return submittedTask;
  }
}

export async function handleA2AJsonRpcRequest(req: Request): Promise<Response> {
  let rpc: {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };
  try {
    rpc = (await req.json()) as typeof rpc;
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

  const rpcId = rpc.id ?? null;
  const params = rpc.params ?? {};

  if (rpc.method === "tasks/send" || rpc.method === "message/send") {
    const taskId =
      typeof params.id === "string" ? params.id : crypto.randomUUID();
    const sessionId =
      typeof params.sessionId === "string"
        ? params.sessionId
        : crypto.randomUUID();
    const message = (params.message as A2AMessage | undefined) ?? {
      role: "user",
      parts: [{ type: "text", text: "" }],
    };
    const metadata = params.metadata as Record<string, unknown> | undefined;
    const task = await runTaskLifecycle(taskId, sessionId, message, metadata);
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: task,
    });
  }

  if (rpc.method === "tasks/get") {
    const taskId = String(params.id ?? "");
    const found = taskStore.get(taskId);
    if (!found) {
      return Response.json({
        jsonrpc: "2.0",
        id: rpcId,
        error: { code: -32001, message: `Task not found: ${taskId}` },
      });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: found,
    });
  }

  if (rpc.method === "tasks/cancel") {
    const taskId = String(params.id ?? "");
    let found = taskStore.get(taskId);
    if (!found) {
      found = {
        id: taskId || crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        status: {
          state: "canceled",
          timestamp: new Date().toISOString(),
        },
        history: [],
        artifacts: [],
      };
      taskStore.set(found.id, found);
    } else {
      found.status = {
        state: "canceled",
        timestamp: new Date().toISOString(),
      };
    }
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: found,
    });
  }

  if (rpc.method === "tasks/sendSubscribe" || rpc.method === "message/stream") {
    const taskId =
      typeof params.id === "string" ? params.id : crypto.randomUUID();
    const sessionId =
      typeof params.sessionId === "string"
        ? params.sessionId
        : crypto.randomUUID();
    const message = (params.message as A2AMessage | undefined) ?? {
      role: "user",
      parts: [{ type: "text", text: "" }],
    };
    const metadata = params.metadata as Record<string, unknown> | undefined;

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await runTaskLifecycle(taskId, sessionId, message, metadata, (snap) => {
          const eventPayload = {
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              id: snap.id,
              status: snap.status,
              final:
                snap.status.state === "completed" ||
                snap.status.state === "failed" ||
                snap.status.state === "canceled",
              artifacts: snap.artifacts,
            },
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(eventPayload)}\n\n`),
          );
        });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  return Response.json({
    jsonrpc: "2.0",
    id: rpcId,
    error: {
      code: -32601,
      message: `Unsupported A2A method: ${String(rpc.method)}`,
    },
  });
}
