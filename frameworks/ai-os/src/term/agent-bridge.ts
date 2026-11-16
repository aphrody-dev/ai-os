// Unified AI-First Terminal Agent Bridge (OpenRouter, ACP v1.31.0, OpenCode, MCP Agent, A2A 1.0.1, Claude, Antigravity).
// Zero duplicated provider discovery: builds directly on @aphrody/ai-os llm/models, relay/acp, relay/a2a, relay/backends, and core/agent.
import { homedir } from "node:os";
import { join } from "node:path";
import { run as runAgent } from "../core/agent.ts";
import { resolveModel as resolveCoreModel } from "../core/model.ts";
import { llmAsk } from "../llm/model.ts";
import { listModels, providers } from "../llm/models.ts";
import { a2aHttp } from "../relay/a2a.ts";
import { handle as acpHandle } from "../relay/acp.ts";
import { agy, claude, gemini, opencode } from "../relay/backends.ts";
import { outboundFetch } from "../relay/outbound.ts";
import type { TermManager } from "./pty.ts";

export interface TermAskRequest {
  engine:
    | "auto"
    | "openrouter"
    | "acp"
    | "opencode"
    | "mcp"
    | "a2a"
    | "claude"
    | "agy"
    | "gemini";
  model?: string;
  prompt: string;
  paneId?: string;
  includeScreen?: boolean;
  includeFailedBlock?: boolean;
  cwd?: string;
}

export interface TermAskResponse {
  engine: string;
  model?: string;
  text: string;
  ms: number;
  commands: string[];
  protocol: string;
}

/** Extract runnable shell commands from fenced code blocks for safe one-click [Insert] / [Run]. */
export function extractCommands(markdown: string): string[] {
  const cmds: string[] = [];
  const seen = new Set<string>();
  const re =
    /```(?:sh|bash|zsh|pwsh|powershell|cmd|shell)?\r?\n([\s\S]*?)```/gi;
  for (const m of markdown.matchAll(re)) {
    const block = m[1]!.trim();
    if (!block) continue;
    for (const line of block.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      if (!seen.has(clean)) {
        seen.add(clean);
        cmds.push(clean);
      }
    }
  }
  return cmds.slice(0, 8);
}

let cachedCatalog:
  | {
      engines: { id: string; label: string; available: boolean }[];
      openrouterModels: string[];
      models: string[];
    }
  | undefined;

export function discoverAiCatalogFast() {
  if (cachedCatalog) return cachedCatalog;
  return {
    engines: [
      {
        id: "openrouter",
        label: "OpenRouter",
        available: Boolean(Bun.env.OPENROUTER_API_KEY),
      },
      { id: "acp", label: "ACP v1.31.0", available: true },
      {
        id: "opencode",
        label: "OpenCode CLI/TUI",
        available: Boolean(Bun.which("opencode")),
      },
      { id: "mcp", label: "AI-OS MCP Agent", available: true },
      { id: "a2a", label: "A2A 1.0.1", available: true },
      {
        id: "agy",
        label: "Antigravity (Gemini 4)",
        available: Boolean(Bun.which("agy")),
      },
      {
        id: "claude",
        label: "Claude Code",
        available: Boolean(Bun.which("claude")),
      },
    ],
    openrouterModels: [] as string[],
    models: [] as string[],
  };
}

export async function discoverAiCatalog() {
  const groups = await listModels().catch(() => []);
  const flat = groups.flatMap((g) => g.models);
  const openrouterModels = flat
    .filter((m) => m.provider === "openrouter")
    .slice(0, 40)
    .map((m) => m.id);
  const localModels = flat
    .filter((m) => m.provider !== "openrouter")
    .slice(0, 30)
    .map((m) => m.id);
  const cliEngines = [
    {
      id: "openrouter",
      label: "OpenRouter",
      available: Boolean(Bun.env.OPENROUTER_API_KEY),
    },
    { id: "acp", label: "ACP v1.31.0", available: true },
    {
      id: "opencode",
      label: "OpenCode CLI/TUI",
      available: Boolean(Bun.which("opencode")),
    },
    { id: "mcp", label: "AI-OS MCP Agent", available: flat.length > 0 },
    { id: "a2a", label: "A2A 1.0.1", available: true },
    {
      id: "agy",
      label: "Antigravity (Gemini 4)",
      available: Boolean(Bun.which("agy")),
    },
    {
      id: "claude",
      label: "Claude Code",
      available: Boolean(Bun.which("claude")),
    },
  ];
  cachedCatalog = {
    engines: cliEngines,
    openrouterModels,
    models: [...openrouterModels, ...localModels],
  };
  return cachedCatalog;
}

function buildTerminalContext(
  manager: TermManager,
  req: TermAskRequest,
): { contextText: string; cwd: string } {
  const pane = req.paneId ? manager.get(req.paneId) : manager.first();
  const cwd = req.cwd ?? pane?.cwd ?? process.cwd();
  if (!pane) return { contextText: `Workspace: ${cwd}`, cwd };

  const parts: string[] = [
    `Pane: ${pane.label} (${pane.profile}, ${pane.cols}x${pane.rows}, cwd=${pane.cwd})`,
  ];
  const meta = pane.vterm.meta();
  const blocks = pane.vterm.blocks();
  if (req.includeFailedBlock !== false) {
    const failed = [...blocks].reverse().find((b) => b.failed);
    if (failed) {
      const tail: string[] = [];
      for (let r = failed.outRow; r <= failed.endRow; r++) {
        tail.push(pane.vterm.rowText(r));
      }
      parts.push(
        `Last failed command (OSC 133, exit=${failed.exitCode}):\n$ ${failed.command}\n${tail.join("\n").slice(-1500)}`,
      );
    }
  }
  if (req.includeScreen !== false) {
    const txt = pane.vterm.text().slice(-3000);
    if (txt)
      parts.push(
        `Visible terminal buffer (cursor ${meta.cursorX},${meta.cursorY}):\n${txt}`,
      );
  }
  return { contextText: parts.join("\n\n"), cwd };
}

async function runViaAcp(
  prompt: string,
  cwd: string,
  meta: { engine?: string; model?: string },
): Promise<{ text: string; engine: string }> {
  const send = async (msg: unknown) => {
    const out: any[] = [];
    await acpHandle(msg as any, (m) => out.push(m));
    return out;
  };
  await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  const sMsgs = await send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd, mcpServers: [], _meta: meta },
  });
  const sessionId = sMsgs.find((m) => m.id === 2)?.result?.sessionId;
  if (!sessionId) throw new Error("ACP session/new failed");
  const pMsgs = await send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: prompt }] },
  });
  const err = pMsgs.find((m) => m.error);
  if (err) throw new Error(err.error.message ?? "ACP prompt error");
  const chunks = pMsgs
    .filter((m) => m.method === "session/update")
    .map((m) => m.params?.update?.content?.text ?? "");
  return { text: chunks.join(""), engine: `acp (${meta.engine ?? "gemini"})` };
}

export async function askTerminalAgent(
  manager: TermManager,
  req: TermAskRequest,
): Promise<TermAskResponse> {
  const t0 = performance.now();
  const { contextText, cwd } = buildTerminalContext(manager, req);
  const fullPrompt = `${contextText}\n\nUser request:\n${req.prompt}\n\nProvide a concise diagnosis and runnable command(s) in \`\`\`sh blocks when helpful.`;

  const pickEngine = async (): Promise<TermAskRequest["engine"]> => {
    if (req.engine !== "auto") return req.engine;
    if (req.model?.startsWith("openrouter/")) return "openrouter";
    if (Bun.env.OPENROUTER_API_KEY) return "openrouter";
    const models = await listModels().catch(() => []);
    if (models.length > 0) return "mcp";
    if (Bun.which("opencode")) return "opencode";
    if (Bun.which("agy")) return "agy";
    if (Bun.which("claude")) return "claude";
    return "acp";
  };

  const engine = await pickEngine();
  let text = "";
  let resolvedModel = req.model;
  let protocol: string = engine;

  switch (engine) {
    case "openrouter": {
      const groups = await listModels().catch(() => []);
      const flat = groups.flatMap((g) => g.models);
      const targetModel =
        resolvedModel ??
        flat.find((m) => m.provider === "openrouter")?.id ??
        flat[0]?.id ??
        "openrouter/auto";
      resolvedModel = targetModel;
      const res = await llmAsk(targetModel, fullPrompt);
      text = res.text;
      protocol = "openrouter-openai";
      break;
    }
    case "acp": {
      const res = await runViaAcp(fullPrompt, cwd, {
        engine: req.model?.startsWith("openrouter/")
          ? "openrouter"
          : Bun.which("opencode")
            ? "opencode"
            : Bun.which("agy")
              ? "gemini"
              : "claude",
        model: req.model,
      });
      text = res.text;
      protocol = "acp-v1.31.0";
      break;
    }
    case "opencode": {
      const res = await opencode(fullPrompt, req.model);
      text = res.text;
      protocol = "opencode-run";
      break;
    }
    case "mcp": {
      const home = Bun.env.AGENT_HOME ?? join(homedir(), ".agent");
      const model = await resolveCoreModel(req.model);
      resolvedModel = model.id;
      const res = await runAgent({
        task: fullPrompt,
        model,
        home,
        cwd,
        allowShell: true,
        maxSteps: 6,
      });
      text = res.text;
      protocol = "ai-os-mcp";
      break;
    }
    case "a2a": {
      const r = await a2aHttp(
        new Request("http://127.0.0.1/a2a", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "a2a-version": "1.0",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "SendMessage",
            params: {
              message: {
                messageId: crypto.randomUUID(),
                role: "ROLE_USER",
                parts: [{ text: fullPrompt }],
              },
              ...(req.model ? { configuration: { model: req.model } } : {}),
            },
          }),
        }),
      );
      const j = (await r.json()) as any;
      if (j.error) throw new Error(j.error.message ?? "A2A error");
      const task = j.result?.task ?? j.result;
      const parts =
        task?.artifacts?.[0]?.parts ??
        task?.status?.message?.parts ??
        task?.history?.[task.history.length - 1]?.parts ??
        [];
      text =
        parts.map((p: any) => p.text ?? "").join("\n") ||
        JSON.stringify(j.result);
      protocol = "a2a-1.0.1";
      break;
    }
    case "claude": {
      const res = await claude(fullPrompt, req.model);
      text = res.text;
      protocol = "claude-cli";
      break;
    }
    case "agy": {
      const res = await agy(fullPrompt, req.model);
      text = res.text;
      protocol = "antigravity-cli";
      break;
    }
    case "gemini": {
      const res = await gemini(fullPrompt);
      text = res.text;
      protocol = "gemini";
      break;
    }
  }

  return {
    engine,
    model: resolvedModel,
    text,
    ms: Math.round(performance.now() - t0),
    commands: extractCommands(text),
    protocol,
  };
}

export type TermStreamEvent =
  | { type: "meta"; engine: string; model?: string; protocol: string }
  | { type: "delta"; text: string }
  | {
      type: "done";
      engine: string;
      model?: string;
      text: string;
      ms: number;
      commands: string[];
      protocol: string;
    };

export async function streamTerminalAgent(
  manager: TermManager,
  req: TermAskRequest,
  emit: (ev: TermStreamEvent) => void,
): Promise<TermAskResponse> {
  const t0 = performance.now();
  const { contextText, cwd } = buildTerminalContext(manager, req);
  const fullPrompt = `${contextText}\n\nUser request:\n${req.prompt}\n\nProvide a concise diagnosis and runnable command(s) in \`\`\`sh blocks when helpful.`;

  let engine = req.engine;
  if (engine === "auto") {
    if (req.model?.startsWith("openrouter/")) engine = "openrouter";
    else if (Bun.env.OPENROUTER_API_KEY) engine = "openrouter";
    else {
      const models = await listModels().catch(() => []);
      if (models.length > 0) engine = "mcp";
      else if (Bun.which("opencode")) engine = "opencode";
      else if (Bun.which("agy")) engine = "agy";
      else if (Bun.which("claude")) engine = "claude";
      else engine = "acp";
    }
  }

  if (engine === "openrouter") {
    const prov = providers().find((p) => p.id === "openrouter")?.chat;
    if (prov) {
      const targetModel = req.model || "openrouter/auto";
      const modelShort = targetModel.replace(/^openrouter\//, "");
      emit({
        type: "meta",
        engine,
        model: targetModel,
        protocol: "openrouter-sse",
      });
      const r = await outboundFetch(
        `${prov.base()}${prov.path ?? "/v1/chat/completions"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...prov.headers(),
          },
          body: JSON.stringify({
            model: modelShort,
            messages: [{ role: "user", content: fullPrompt }],
            stream: true,
          }),
        },
      );
      if (r.ok && r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let fullText = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const j = JSON.parse(line.slice(6));
                const d = j?.choices?.[0]?.delta?.content ?? "";
                if (d) {
                  fullText += d;
                  emit({ type: "delta", text: d });
                }
              } catch {}
            }
            nl = buf.indexOf("\n");
          }
        }
        const doneRes: TermAskResponse = {
          engine,
          model: targetModel,
          text: fullText,
          ms: Math.round(performance.now() - t0),
          commands: extractCommands(fullText),
          protocol: "openrouter-sse",
        };
        emit({ type: "done", ...doneRes });
        return doneRes;
      }
    }
  }

  if (engine === "acp") {
    const acpEngine = req.model?.startsWith("openrouter/")
      ? "openrouter"
      : Bun.which("opencode")
        ? "opencode"
        : Bun.which("agy")
          ? "gemini"
          : "claude";
    emit({
      type: "meta",
      engine,
      model: req.model,
      protocol: "acp-v1.31.0-sse",
    });
    let sessionId = "";
    await acpHandle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      },
      () => {},
    );
    await acpHandle(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: {
          cwd,
          mcpServers: [],
          _meta: { engine: acpEngine, model: req.model },
        },
      },
      (m: any) => {
        if (m?.id === 2 && m?.result?.sessionId) sessionId = m.result.sessionId;
      },
    );
    if (!sessionId) throw new Error("ACP session/new failed");
    let fullText = "";
    await acpHandle(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: fullPrompt }] },
      },
      (m: any) => {
        if (m?.method === "session/update") {
          const d = m?.params?.update?.content?.text ?? "";
          if (d) {
            fullText += d;
            emit({ type: "delta", text: d });
          }
        }
      },
    );
    const doneRes: TermAskResponse = {
      engine,
      model: req.model,
      text: fullText,
      ms: Math.round(performance.now() - t0),
      commands: extractCommands(fullText),
      protocol: "acp-v1.31.0-sse",
    };
    emit({ type: "done", ...doneRes });
    return doneRes;
  }

  if (engine === "opencode") {
    const bin = Bun.which("opencode");
    if (bin) {
      emit({
        type: "meta",
        engine,
        model: req.model,
        protocol: "opencode-stream",
      });
      const argv = [bin, "run"];
      if (req.model) argv.push("-m", req.model);
      argv.push(fullPrompt);
      const env = { ...Bun.env };
      delete env.PWD;
      delete env.OLDPWD;
      const proc = Bun.spawn(argv, {
        cwd:
          process.platform === "win32" && cwd.startsWith("/")
            ? process.cwd()
            : cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const errPromise = new Response(proc.stderr).text();
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      let fullText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const d = dec.decode(value, { stream: true });
        if (d) {
          fullText += d;
          emit({ type: "delta", text: d });
        }
      }
      const [code, errText] = await Promise.all([proc.exited, errPromise]);
      if (code !== 0 && !fullText.trim()) {
        throw new Error(errText.trim() || `opencode exited ${code}`);
      }
      const doneRes: TermAskResponse = {
        engine,
        model: req.model,
        text: fullText.trim(),
        ms: Math.round(performance.now() - t0),
        commands: extractCommands(fullText),
        protocol: "opencode-stream",
      };
      emit({ type: "done", ...doneRes });
      return doneRes;
    }
  }

  // Fallback for MCP, A2A, Claude, Agy, Gemini
  const res = await askTerminalAgent(manager, req);
  emit({
    type: "meta",
    engine: res.engine,
    model: res.model,
    protocol: res.protocol,
  });
  emit({ type: "delta", text: res.text });
  emit({ type: "done", ...res });
  return res;
}
