import { federateChatCompletion } from "../providers/federation.ts";
import { executeMcpTool, MCP_TOOLS } from "./mcp.ts";

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpSession {
  sessionId: string;
  cwd: string;
  createdAt: string;
  canceled: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
}

const acpSessions = new Map<string, AcpSession>();

export async function handleAcpRequest(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return Response.json({
      protocol: "agent-client-protocol",
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: {
        name: "ai-os-sovereign-acp",
        version: "1.0.0",
      },
      activeSessions: acpSessions.size,
      toolsCount: MCP_TOOLS.length,
    });
  }

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

  const id = rpc.id ?? null;
  const params = rpc.params ?? {};

  switch (rpc.method) {
    case "initialize": {
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentInfo: {
            name: "ai-os-sovereign-acp",
            version: "1.0.0",
          },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: true,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              http: true,
              sse: true,
            },
          },
          authMethods: [],
        },
      });
    }

    case "session/new": {
      const sessionId = `acp_${crypto.randomUUID()}`;
      const cwd = typeof params.cwd === "string" ? params.cwd : "C:/src";
      acpSessions.set(sessionId, {
        sessionId,
        cwd,
        createdAt: new Date().toISOString(),
        canceled: false,
        history: [],
      });
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          modes: {
            currentModeId: "sovereign-autonomous",
            availableModes: [
              {
                id: "sovereign-autonomous",
                name: "Sovereign NHITL Autonomous Mode",
                description:
                  "Full desktop FFI + browser CDP + multi-provider execution",
              },
              {
                id: "architect-readonly",
                name: "Architect Read-Only Analysis",
                description: "Read-only inspection and standards verification",
              },
            ],
          },
        },
      });
    }

    case "session/prompt": {
      const sessionId = String(params.sessionId ?? "");
      let session = acpSessions.get(sessionId);
      if (!session) {
        session = {
          sessionId: sessionId || `acp_${crypto.randomUUID()}`,
          cwd: "C:/src",
          createdAt: new Date().toISOString(),
          canceled: false,
          history: [],
        };
        acpSessions.set(session.sessionId, session);
      }
      session.canceled = false;

      let promptText = "";
      if (typeof params.prompt === "string") {
        promptText = params.prompt;
      } else if (Array.isArray(params.prompt)) {
        promptText = (params.prompt as Array<{ type?: string; text?: string }>)
          .map((b) => b.text ?? "")
          .join("\n");
      }

      session.history.push({ role: "user", text: promptText });

      const updates: Array<Record<string, unknown>> = [];
      if (params.toolCall && typeof params.toolCall === "object") {
        const tc = params.toolCall as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const toolName = tc.name ?? "monorepo_exec";
        const toolCallId = `tc_${crypto.randomUUID().slice(0, 8)}`;
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId,
          title: `Executing ${toolName}`,
          kind: "execute",
          status: "in_progress",
        });
        const toolRes = await executeMcpTool(toolName, tc.arguments ?? {});
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: toolRes.isError ? "failed" : "completed",
          content: toolRes.content,
        });
      }

      const completion = await federateChatCompletion({
        model:
          typeof params.model === "string"
            ? params.model
            : "ai-os/sovereign-default",
        messages: session.history.map((h) => ({
          role: h.role,
          content: h.text,
        })),
      });
      const answer = completion.choices[0]?.message.content ?? "";
      session.history.push({ role: "assistant", text: answer });

      updates.push({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: answer,
        },
      });

      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("text/event-stream")) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const u of updates) {
              const notif = {
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: session!.sessionId,
                  update: u,
                },
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(notif)}\n\n`),
              );
            }
            const finalResp = {
              jsonrpc: "2.0",
              id,
              result: {
                stopReason: session!.canceled ? "cancelled" : "end_turn",
              },
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(finalResp)}\n\n`),
            );
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
        jsonrpc: "2.0",
        id,
        result: {
          sessionId: session.sessionId,
          stopReason: session.canceled ? "cancelled" : "end_turn",
          output: answer,
          updates,
        },
      });
    }

    case "session/cancel": {
      const sessionId = String(params.sessionId ?? "");
      const session = acpSessions.get(sessionId);
      if (session) {
        session.canceled = true;
      }
      if (rpc.id === undefined) {
        return new Response(null, { status: 202 });
      }
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          canceled: true,
        },
      });
    }

    default: {
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${String(rpc.method)}`,
        },
      });
    }
  }
}
