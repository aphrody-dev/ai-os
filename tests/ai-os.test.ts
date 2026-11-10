import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { ExtractionManifest } from "../src/extractor.ts";
import {
  AD_ABI_VERSION_MAJOR,
  getDesktopFfi,
  resolveBrowserCliPath,
  resolveDesktopCliPath,
  runBrowserCli,
  runDesktopCli,
} from "../src/ffi/desktop.ts";
import { runSentinelSync } from "../src/sentinel/index.ts";
import { startAiOsServer } from "../src/server.ts";

let server: ReturnType<typeof startAiOsServer>;
let baseUrl = "";

beforeAll(() => {
  server = startAiOsServer({ port: 0, hostname: "127.0.0.1" });
  baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  getDesktopFfi()?.close();
});

describe("Part 1: Exhaustive Extraction Manifest & Native Fat-LTO Binaries", () => {
  test("EXTRACTION_MANIFEST.json & COMPARISON_AND_INTEGRATION_MATRIX.md exist and cover 100% of dependencies", () => {
    const manifestPath = "C:/src/ai-os/EXTRACTION_MANIFEST.json";
    const matrixPath = "C:/src/ai-os/COMPARISON_AND_INTEGRATION_MATRIX.md";
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(matrixPath)).toBe(true);

    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as ExtractionManifest;
    expect(manifest.summary.agentBrowser.cargoLockCratesTotal).toBe(332);
    expect(manifest.summary.agentBrowser.pnpmUniquePackagesCount).toBe(1225);
    expect(manifest.summary.agentBrowser.pnpmSnapshotsCount).toBe(1229);
    expect(
      manifest.summary.agentBrowser.packageJsonFilesCount,
    ).toBeGreaterThanOrEqual(17);
    expect(manifest.summary.agentDesktop.cargoLockCratesTotal).toBe(166);
    expect(manifest.summary.agentDesktop.workspaceMembersCount).toBe(6);
    expect(
      manifest.summary.agentDesktop.ffiExportedSymbolsCount,
    ).toBeGreaterThanOrEqual(85);
    expect(manifest.sovereignStack.length).toBeGreaterThanOrEqual(10);
  });

  test("agent-desktop.exe, agent_desktop_ffi.dll, and agent-browser.exe are installed in ~/.local/bin and functional", async () => {
    const desktopBin = resolveDesktopCliPath();
    const browserBin = resolveBrowserCliPath();
    expect(existsSync(desktopBin)).toBe(true);
    expect(existsSync(browserBin)).toBe(true);

    const desktopVer = await runDesktopCli(["version"]);
    expect(desktopVer.exitCode).toBe(0);
    expect((desktopVer.parsed as { ok?: boolean })?.ok).toBe(true);

    const browserVer = await runBrowserCli(["--version"]);
    expect(browserVer.exitCode).toBe(0);
    expect(browserVer.stdout).toContain("0.42.0");

    const ffi = getDesktopFfi();
    expect(ffi).not.toBeNull();
    expect(ffi!.abiVersion).toBe(AD_ABI_VERSION_MAJOR);

    const ffiVer = ffi!.versionEnvelope() as {
      ok?: boolean;
      data?: { version?: string };
    };
    expect(ffiVer.ok).toBe(true);
    expect(ffiVer.data?.version).toBe("1.2.0");

    const ffiStatus = ffi!.statusEnvelope() as {
      ok?: boolean;
      command?: string;
    };
    expect(ffiStatus.ok).toBe(true);
    expect(ffiStatus.command).toBe("status");
  });
});

describe("Part 2: Unified Multi-Protocol AI Control Plane", () => {
  test("OpenAI Spec (/v1/models, /v1/chat/completions, /v1/responses, /v1/embeddings) + Open WebUI Bridge", async () => {
    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as {
      object: string;
      data: unknown[];
    };
    expect(modelsJson.object).toBe("list");
    expect(modelsJson.data.length).toBeGreaterThan(5);

    const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-os/sovereign-local",
        messages: [{ role: "user", content: "Ping sovereign control plane" }],
      }),
    });
    expect(chatRes.status).toBe(200);
    const chatJson = (await chatRes.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(chatJson.object).toBe("chat.completion");
    expect(chatJson.choices[0]?.message.content).toContain(
      "Ping sovereign control plane",
    );

    // SSE stream test
    const sseRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-os/sovereign-local",
        stream: true,
        messages: [{ role: "user", content: "Stream check" }],
      }),
    });
    expect(sseRes.status).toBe(200);
    const sseText = await sseRes.text();
    expect(sseText).toContain("data: [DONE]");

    // /v1/responses
    const respApi = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-os/sovereign-local",
        input: "Responses API check",
      }),
    });
    expect(respApi.status).toBe(200);
    const respJson = (await respApi.json()) as {
      object: string;
      status: string;
    };
    expect(respJson.object).toBe("response");
    expect(respJson.status).toBe("completed");

    // /v1/embeddings
    const embRes = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "vectorize me", dimensions: 32 }),
    });
    expect(embRes.status).toBe(200);
    const embJson = (await embRes.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    expect(embJson.data[0]?.embedding.length).toBe(32);

    // Open WebUI / Ollama bridge
    const verRes = await fetch(`${baseUrl}/api/version`);
    expect(verRes.status).toBe(200);
    const tagsRes = await fetch(`${baseUrl}/ollama/api/tags`);
    expect(tagsRes.status).toBe(200);
    const tagsJson = (await tagsRes.json()) as { models: unknown[] };
    expect(Array.isArray(tagsJson.models)).toBe(true);
  });

  test("MCP Streamable HTTP (/mcp) initialize, tools/list, and live FFI/CLI tools/call", async () => {
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      }),
    });
    expect(initRes.status).toBe(200);
    const initJson = (await initRes.json()) as {
      result: { protocolVersion: string };
    };
    expect(initJson.result.protocolVersion).toBe("2025-03-26");

    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    const listJson = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const toolNames = listJson.result.tools.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "desktop_snapshot",
        "desktop_action",
        "browser_navigate",
        "browser_a11y_tree",
        "monorepo_exec",
        "sentinel_status",
        "skills_search",
      ]),
    );

    // Call desktop_snapshot (statusOnly via bun:ffi)
    const callSnap = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "desktop_snapshot", arguments: { statusOnly: true } },
      }),
    });
    const snapJson = (await callSnap.json()) as {
      result: { isError: boolean; structuredContent: { ok: boolean } };
    };
    expect(snapJson.result.isError).toBe(false);
    expect(snapJson.result.structuredContent.ok).toBe(true);

    // Call browser_a11y_tree checkDoctor
    const callBrowser = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "browser_a11y_tree", arguments: { checkDoctor: true } },
      }),
    });
    const browserJson = (await callBrowser.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(browserJson.result.isError).toBe(false);
    expect(browserJson.result.content[0]?.text).toContain("0.42.0");
  });

  test("A2A Protocol (/.well-known/agent.json, tasks/send, tasks/get, tasks/cancel, tasks/sendSubscribe)", async () => {
    const cardRes = await fetch(`${baseUrl}/.well-known/agent.json`);
    expect(cardRes.status).toBe(200);
    const card = (await cardRes.json()) as {
      name: string;
      capabilities: { streaming: boolean };
      skills: unknown[];
    };
    expect(card.name).toContain("Sovereign AI-OS");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.skills.length).toBeGreaterThanOrEqual(4);

    const taskId = `task_${crypto.randomUUID()}`;
    const sendRes = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "a2a-1",
        method: "tasks/send",
        params: {
          id: taskId,
          message: {
            role: "user",
            parts: [{ type: "text", text: "Execute A2A sovereign check" }],
          },
          metadata: { model: "ai-os/sovereign-local" },
        },
      }),
    });
    expect(sendRes.status).toBe(200);
    const sendJson = (await sendRes.json()) as {
      result: { id: string; status: { state: string }; artifacts: unknown[] };
    };
    expect(sendJson.result.id).toBe(taskId);
    expect(sendJson.result.status.state).toBe("completed");
    expect(sendJson.result.artifacts.length).toBe(1);

    const getRes = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "a2a-2",
        method: "tasks/get",
        params: { id: taskId },
      }),
    });
    const getJson = (await getRes.json()) as { result: { id: string } };
    expect(getJson.result.id).toBe(taskId);

    const cancelRes = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "a2a-3",
        method: "tasks/cancel",
        params: { id: taskId },
      }),
    });
    const cancelJson = (await cancelRes.json()) as {
      result: { status: { state: string } };
    };
    expect(cancelJson.result.status.state).toBe("canceled");

    // SSE tasks/sendSubscribe
    const subRes = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "a2a-4",
        method: "tasks/sendSubscribe",
        params: {
          message: {
            role: "user",
            parts: [{ type: "text", text: "SSE task lifecycle" }],
          },
          metadata: { model: "ai-os/sovereign-local" },
        },
      }),
    });
    expect(subRes.status).toBe(200);
    const subSse = await subRes.text();
    expect(subSse).toContain('"state":"submitted"');
    expect(subSse).toContain('"state":"working"');
    expect(subSse).toContain('"state":"completed"');
  });

  test("ACP Agent Client Protocol (/acp initialize, session/new, session/prompt, session/cancel)", async () => {
    const initRes = await fetch(`${baseUrl}/acp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    expect(initRes.status).toBe(200);
    const initJson = (await initRes.json()) as {
      result: { protocolVersion: number };
    };
    expect(initJson.result.protocolVersion).toBe(1);

    const newRes = await fetch(`${baseUrl}/acp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: "C:/src/ai-os" },
      }),
    });
    const newJson = (await newRes.json()) as { result: { sessionId: string } };
    expect(newJson.result.sessionId).toStartWith("acp_");

    const promptRes = await fetch(`${baseUrl}/acp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: newJson.result.sessionId,
          model: "ai-os/sovereign-local",
          prompt: [{ type: "text", text: "Inspect binaries from ACP" }],
          toolCall: {
            name: "monorepo_exec",
            arguments: { subsystem: "binaries-check" },
          },
        },
      }),
    });
    const promptJson = (await promptRes.json()) as {
      result: { stopReason: string; updates: unknown[] };
    };
    expect(promptJson.result.stopReason).toBe("end_turn");
    expect(promptJson.result.updates.length).toBeGreaterThanOrEqual(3);

    const cancelRes = await fetch(`${baseUrl}/acp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "session/cancel",
        params: { sessionId: newJson.result.sessionId },
      }),
    });
    const cancelJson = (await cancelRes.json()) as {
      result: { canceled: boolean };
    };
    expect(cancelJson.result.canceled).toBe(true);
  });

  test("Skills & Hooks Registry (/api/skills & /api/hooks)", async () => {
    const skillsRes = await fetch(`${baseUrl}/api/skills`);
    expect(skillsRes.status).toBe(200);
    const skillsJson = (await skillsRes.json()) as {
      totalSkills: number;
      byEcosystem: Record<string, { skills: number }>;
    };
    expect(skillsJson.totalSkills).toBeGreaterThan(100);
    expect(
      skillsJson.byEcosystem["agent-desktop"]?.skills,
    ).toBeGreaterThanOrEqual(6);
    expect(
      skillsJson.byEcosystem["agent-browser"]?.skills,
    ).toBeGreaterThanOrEqual(1);

    const hooksRes = await fetch(`${baseUrl}/api/hooks`);
    expect(hooksRes.status).toBe(200);
    const hooksJson = (await hooksRes.json()) as { totalHooks: number };
    expect(hooksJson.totalHooks).toBeGreaterThanOrEqual(1);
  });
});

describe("Part 3: Live Upstream Standards Sentinel (SQLite WAL)", () => {
  test("Probes live kernel.org, Chrome Canary, AOSP, and WHATWG feeds into sentinel.sqlite", async () => {
    const state = await runSentinelSync({
      targetIds: [
        "linux-kernel-org",
        "chrome-win64-canary",
        "aosp-platform-build",
        "whatwg-html",
      ],
      timeoutMs: 8000,
    });
    expect(state.results.length).toBe(4);
    expect(state.liveCount + state.cachedCount).toBeGreaterThanOrEqual(3);
    const canary = state.results.find((r) => r.id === "chrome-win64-canary");
    expect(canary?.latestVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
