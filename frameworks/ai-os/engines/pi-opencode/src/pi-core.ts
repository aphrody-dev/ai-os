import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { diffLineStats, isSafeWorkspacePath } from "./native-bridge.ts";

export interface PiToolCall {
  id: string;
  name: "read" | "write" | "edit" | "bash";
  arguments: Record<string, unknown>;
}

export interface PiToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  output: string;
  diff?: { added: number; removed: number };
}

export interface PiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: PiToolCall[];
  toolCallId?: string;
}

export interface PiAgentOptions {
  cwd: string;
  allowShell?: boolean;
  maxTurns?: number;
  shellTimeoutMs?: number;
  appendSystemPrompt?: string;
}

export type PiModelCallFn = (
  messages: PiMessage[],
  tools: typeof PI_ATOMIC_TOOL_DECLARATIONS,
) => Promise<{ content: string; toolCalls?: PiToolCall[] }>;

/**
 * Pi's 4 pure atomic tool declarations (`earendil-works/pi` philosophy:
 * skip bloated sub-frameworks, expose only `read`, `write`, `edit`, `bash`).
 */
export const PI_ATOMIC_TOOL_DECLARATIONS = [
  {
    name: "read",
    description:
      "Read UTF-8 file contents with optional 1-based startLine and endLine.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Create or overwrite a UTF-8 file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace an exact target string in an existing workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "bash",
    description:
      "Execute a non-interactive shell command inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
] as const;

export function buildMinimalPiSystemPrompt(opts: PiAgentOptions): string {
  const lines = [
    "You are a minimalist, precision coding agent powered by Pi + OpenCode + Bun v1.4.4.",
    "Tools available: read, write, edit, bash.",
    "Rules:",
    "- Read files before editing them. Prefer surgical edits over full rewrites.",
    "- Never touch host OS directories (C:\\Windows\\System32, /usr/bin, /etc).",
    "- Verify every change with real tests or typechecks (`bun test`, `bun check`, `cargo test`).",
    `Working directory: ${resolve(opts.cwd)}`,
  ];
  if (opts.appendSystemPrompt?.trim()) {
    lines.push("", opts.appendSystemPrompt.trim());
  }
  return lines.join("\n");
}

const DESTRUCTIVE_HOST_CMD_RE =
  /\b(system32|reg\s+delete\s+hklm|bcdedit|diskpart|format\s+[a-z]:|rm\s+-rf\s+\/(?:\s|$))/i;

function resolveWorkspaceTarget(cwd: string, rawPath: string): string {
  const target = resolve(cwd, rawPath);
  if (!isSafeWorkspacePath(target)) {
    throw new Error(
      `Blocked unsafe host OS path (Torvalds userspace guard): ${target}`,
    );
  }
  const normRoot = resolve(cwd).toLowerCase();
  const normTarget = target.toLowerCase();
  if (
    normTarget !== normRoot &&
    !normTarget.startsWith(`${normRoot}\\`) &&
    !normTarget.startsWith(`${normRoot}/`)
  ) {
    throw new Error(`Path escapes isolated workspace (${cwd}): ${target}`);
  }
  return target;
}

export async function executePiTool(
  call: PiToolCall,
  opts: PiAgentOptions,
): Promise<PiToolResult> {
  try {
    switch (call.name) {
      case "read": {
        const target = resolveWorkspaceTarget(
          opts.cwd,
          String(call.arguments.path ?? ""),
        );
        if (!existsSync(target)) {
          return {
            toolCallId: call.id,
            name: "read",
            ok: false,
            output: `File not found: ${target}`,
          };
        }
        const raw = readFileSync(target, "utf8");
        const allLines = raw.split(/\r?\n/);
        const start = Math.max(1, Number(call.arguments.startLine ?? 1));
        const end = Math.min(
          allLines.length,
          Number(call.arguments.endLine ?? allLines.length),
        );
        const numbered = allLines
          .slice(start - 1, end)
          .map((l, idx) => `${start + idx}: ${l}`)
          .join("\n");
        return {
          toolCallId: call.id,
          name: "read",
          ok: true,
          output: numbered,
        };
      }

      case "write": {
        const target = resolveWorkspaceTarget(
          opts.cwd,
          String(call.arguments.path ?? ""),
        );
        const content = String(call.arguments.content ?? "");
        const before = existsSync(target) ? readFileSync(target, "utf8") : "";
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
        const diff = diffLineStats(before, content);
        return {
          toolCallId: call.id,
          name: "write",
          ok: true,
          output: `Wrote ${Buffer.byteLength(content)} bytes to ${target} (+${diff.added}/-${diff.removed})`,
          diff,
        };
      }

      case "edit": {
        const target = resolveWorkspaceTarget(
          opts.cwd,
          String(call.arguments.path ?? ""),
        );
        if (!existsSync(target)) {
          return {
            toolCallId: call.id,
            name: "edit",
            ok: false,
            output: `File not found: ${target}`,
          };
        }
        const oldText = String(call.arguments.oldText ?? "");
        const newText = String(call.arguments.newText ?? "");
        const before = readFileSync(target, "utf8");
        if (!oldText || !before.includes(oldText)) {
          return {
            toolCallId: call.id,
            name: "edit",
            ok: false,
            output: `Target snippet not found in ${target}`,
          };
        }
        const after = before.replace(oldText, newText);
        writeFileSync(target, after, "utf8");
        const diff = diffLineStats(before, after);
        return {
          toolCallId: call.id,
          name: "edit",
          ok: true,
          output: `Edited ${target} (+${diff.added}/-${diff.removed})`,
          diff,
        };
      }

      case "bash": {
        if (opts.allowShell === false) {
          return {
            toolCallId: call.id,
            name: "bash",
            ok: false,
            output: "Shell tool disabled",
          };
        }
        const command = String(call.arguments.command ?? "").trim();
        if (DESTRUCTIVE_HOST_CMD_RE.test(command)) {
          return {
            toolCallId: call.id,
            name: "bash",
            ok: false,
            output: `Blocked destructive host command: ${command}`,
          };
        }
        const isWin = process.platform === "win32";
        const argv = isWin
          ? ["pwsh", "-NoProfile", "-Command", command]
          : ["sh", "-lc", command];
        const proc = Bun.spawn(argv, {
          cwd: resolve(opts.cwd),
          stdout: "pipe",
          stderr: "pipe",
        });
        const timeoutMs = opts.shellTimeoutMs ?? 30_000;
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        clearTimeout(timer);
        const combined = [stdout.trim(), stderr.trim()]
          .filter(Boolean)
          .join("\n")
          .slice(0, 16_000);
        return {
          toolCallId: call.id,
          name: "bash",
          ok: exitCode === 0,
          output: `exit=${exitCode}\n${combined}`.trim(),
        };
      }
    }
  } catch (err) {
    return {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Runs Pi's deterministic agent turn loop until the model emits a plain assistant message
 * with zero tool calls or `maxTurns` is reached.
 */
export async function runPiAgentLoop(
  userPrompt: string,
  opts: PiAgentOptions,
  callModel: PiModelCallFn,
  onEvent?: (ev: {
    type: "turn" | "tool_result" | "done";
    detail: unknown;
  }) => void,
): Promise<{
  messages: PiMessage[];
  turns: number;
  toolResults: PiToolResult[];
}> {
  const maxTurns = opts.maxTurns ?? 12;
  const messages: PiMessage[] = [
    { role: "system", content: buildMinimalPiSystemPrompt(opts) },
    { role: "user", content: userPrompt },
  ];
  const toolResults: PiToolResult[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    onEvent?.({ type: "turn", detail: { turn } });
    const reply = await callModel(messages, PI_ATOMIC_TOOL_DECLARATIONS);
    messages.push({
      role: "assistant",
      content: reply.content,
      toolCalls: reply.toolCalls,
    });

    if (!reply.toolCalls || reply.toolCalls.length === 0) {
      onEvent?.({ type: "done", detail: { turn, finalText: reply.content } });
      return { messages, turns: turn, toolResults };
    }

    for (const tc of reply.toolCalls) {
      const res = await executePiTool(tc, opts);
      toolResults.push(res);
      onEvent?.({ type: "tool_result", detail: res });
      messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: res.output,
      });
    }
  }

  return { messages, turns: maxTurns, toolResults };
}
