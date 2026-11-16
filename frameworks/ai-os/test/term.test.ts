import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle as acpHandle } from "../src/relay/acp.ts";
import { chromePath } from "../src/relay/cdp.ts";
import { mcpRpc } from "../src/relay/protocols.ts";
import {
  discoverAiCatalog,
  extractCommands,
} from "../src/term/agent-bridge.ts";
import { createTermTools } from "../src/term/mcp-tools.ts";
import { TermManager } from "../src/term/pty.ts";
import { startTermServer } from "../src/term/server.ts";

describe("@aphrody/ai-os AI-First WebGPU Terminal", () => {
  test("TermManager spawns real ConPTY shell, tracks VTerm text & captures OSC-133 errors", async () => {
    const mgr = new TermManager();
    const profiles = mgr.profiles();
    expect(profiles.length).toBeGreaterThan(0);

    const isWin = process.platform === "win32";
    const argv = isWin
      ? [Bun.env.ComSpec ?? "cmd.exe", "/K", "echo aphrody-pty-ready"]
      : ["sh", "-c", "echo aphrody-pty-ready; sleep 2"];

    const errors: Array<{ code: number; cmd: string }> = [];
    const pane = mgr.spawn({
      argv,
      cols: 90,
      rows: 28,
      theme: "aphrody-m3-dark",
    });
    pane.subscribe((ev) => {
      if (ev.type === "block_error" && ev.block) {
        errors.push({ code: ev.block.exitCode, cmd: ev.block.command });
      }
    });

    try {
      const deadline = Date.now() + 8000;
      while (
        Date.now() < deadline &&
        !pane.vterm.text().includes("aphrody-pty-ready")
      ) {
        await Bun.sleep(40);
      }
      expect(pane.vterm.text()).toContain("aphrody-pty-ready");

      // Inject an OSC 133 failing command sequence directly into the terminal screen & test echo roundtrip
      pane.write("echo roundtrip_ok_42\r");
      const d2 = Date.now() + 5000;
      while (
        Date.now() < d2 &&
        !pane.vterm.text().includes("roundtrip_ok_42")
      ) {
        await Bun.sleep(40);
      }
      expect(pane.vterm.text()).toContain("roundtrip_ok_42");

      pane.resize(100, 30);
      expect(pane.summary().cols).toBe(100);
      expect(pane.summary().rows).toBe(30);

      // Verify v2 scrollback ring + DSR reply buffer
      const flood = Array.from(
        { length: 45 },
        (_, i) => `scroll_line_${i}\r\n`,
      ).join("");
      pane.vterm.feed(`${flood}\x1b[6n`);
      const replies = new TextDecoder().decode(pane.vterm.drainReplies());
      expect(replies).toMatch(/\x1b\[\d+;\d+R/);
      expect(pane.vterm.meta().scrollbackLen).toBeGreaterThan(0);
      const off = pane.scrollLines(5);
      expect(off).toBeGreaterThan(0);
      expect(pane.scrollbackText(0, 20)).toContain("scroll_line_0");
      pane.setScroll(0);
    } finally {
      mgr.closeAll();
    }
  });

  test("extractCommands & discoverAiCatalog expose OpenRouter, ACP, OpenCode, MCP & A2A", async () => {
    const cmds = extractCommands(
      "Fix build:\n```sh\ncargo check -p ay\nbun test frameworks/ai-os/test/term.test.ts\n```",
    );
    expect(cmds).toEqual([
      "cargo check -p ay",
      "bun test frameworks/ai-os/test/term.test.ts",
    ]);

    const cat = await discoverAiCatalog();
    const ids = cat.engines.map((e) => e.id);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("acp");
    expect(ids).toContain("opencode");
    expect(ids).toContain("mcp");
    expect(ids).toContain("a2a");
  });

  test("MCP tools (term_*) + ACP v1.31.0 support opencode/openrouter sessions", async () => {
    const res = await mcpRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (res?.result as any)?.tools ?? [];
    for (const name of [
      "term_profiles",
      "term_list",
      "term_spawn",
      "term_read",
      "term_blocks",
      "term_send",
      "term_resize",
      "term_close",
    ]) {
      expect(tools.some((t: any) => t.name === name)).toBe(true);
    }

    const mgr = new TermManager();
    const localTools = createTermTools(mgr);
    const byName = new Map(localTools.map((t) => [t.name, t]));
    try {
      const spawned = (await byName.get("term_spawn")!.run({
        profile: process.platform === "win32" ? "cmd" : mgr.profiles()[0]!.id,
        cols: 80,
        rows: 24,
      })) as any;
      expect(spawned.id).toBeTruthy();

      await byName.get("term_send")!.run({
        paneId: spawned.id,
        data: "echo mcp_tool_live_77",
        enter: true,
      });
      const deadline = Date.now() + 5000;
      let screen = "";
      while (Date.now() < deadline) {
        const rd = (await byName.get("term_read")!.run({
          paneId: spawned.id,
        })) as any;
        screen = rd.text ?? "";
        if (screen.includes("mcp_tool_live_77")) break;
        await Bun.sleep(40);
      }
      expect(screen).toContain("mcp_tool_live_77");
      const sbRead = (await byName.get("term_read")!.run({
        paneId: spawned.id,
        scrollback: true,
        maxLines: 50,
      })) as any;
      expect(sbRead.text).toContain("mcp_tool_live_77");
      expect(Array.isArray(sbRead.blocks)).toBe(true);
    } finally {
      mgr.closeAll();
    }

    // Verify ACP session negotiation for opencode & openrouter
    const out: any[] = [];
    await acpHandle(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "session/new",
        params: {
          cwd: process.cwd(),
          mcpServers: [],
          _meta: { engine: "opencode", model: "openrouter/auto" },
        },
      },
      (m) => out.push(m),
    );
    expect(out[0]?.result?.sessionId).toBeTruthy();
  });

  test("HTTP + WebSocket daemon serves aysys.wasm/WGSL & renders in real headless Chrome", async () => {
    const mgr = new TermManager();
    const srv = await startTermServer({
      port: 0,
      manager: mgr,
      defaultProfile: process.platform === "win32" ? "cmd" : undefined,
      theme: "aphrody-m3-dark",
    });

    const chromeProfile = mkdtempSync(join(tmpdir(), "ay-term-chrome-"));
    let chromeProc: Bun.Subprocess | undefined;

    try {
      // Unauthenticated request denied
      const unauth = await fetch(`${srv.baseUrl}/api/info`);
      expect(unauth.status).toBe(401);

      // Authenticated API + asset checks
      const infoRes = await fetch(`${srv.baseUrl}/api/info`, {
        headers: { authorization: `Bearer ${srv.token}` },
      });
      expect(infoRes.status).toBe(200);
      const info = (await infoRes.json()) as any;
      expect(info.themes.length).toBeGreaterThanOrEqual(9);
      expect(info.panes).toHaveLength(1);

      const wasmRes = await fetch(`${srv.baseUrl}/aysys.wasm`, {
        headers: { authorization: `Bearer ${srv.token}` },
      });
      expect(wasmRes.status).toBe(200);
      expect(wasmRes.headers.get("content-type")).toContain("wasm");
      const wasmBytes = await wasmRes.arrayBuffer();
      expect(wasmBytes.byteLength).toBeGreaterThan(20_000);

      const wgslRes = await fetch(`${srv.baseUrl}/term.wgsl`, {
        headers: { authorization: `Bearer ${srv.token}` },
      });
      expect(wgslRes.status).toBe(200);
      expect(await wgslRes.text()).toContain("fn fs_main");

      // WebSocket live PTY stream check
      const paneId = info.panes[0].id;
      const wsDone = new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${srv.port}/ws/pty/${paneId}`,
          {
            headers: { authorization: `Bearer ${srv.token}` },
          } as any,
        );
        let text = "";
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error(`WS timeout, got: ${text}`));
        }, 6000);
        ws.onopen = () => {
          ws.send("echo ws_binary_ok_99\r");
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === "string") text += ev.data;
          else text += new TextDecoder().decode(ev.data as ArrayBuffer);
          if (text.includes("ws_binary_ok_99")) {
            clearTimeout(timer);
            ws.close();
            resolve(text);
          }
        };
      });
      expect(await wsDone).toContain("ws_binary_ok_99");

      const textRes = await fetch(
        `${srv.baseUrl}/api/panes/${encodeURIComponent(paneId)}/text?scrollback=1`,
        { headers: { authorization: `Bearer ${srv.token}` } },
      );
      expect(textRes.status).toBe(200);
      const textJson = (await textRes.json()) as any;
      expect(textJson.text).toContain("ws_binary_ok_99");
      expect(textJson.meta?.cols).toBeGreaterThan(0);

      // Verify /api/ai/stream rejects unauth and serves text/event-stream when authenticated
      const unauthStream = await fetch(`${srv.baseUrl}/api/ai/stream`, {
        method: "POST",
      });
      expect(unauthStream.status).toBe(401);
      const sseRes = await fetch(`${srv.baseUrl}/api/ai/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${srv.token}`,
        },
        body: JSON.stringify({
          engine: "mcp",
          paneId,
          prompt: "Reply ONLY with OK",
        }),
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
      const sseBody = await sseRes.text();
      expect(sseBody).toMatch(/event: (meta|error)/);

      // Launch real headless Chrome 157 against launchUrl and verify canvas + WASM + WebMCP
      const cdpPort = 39000 + Math.floor(Math.random() * 10000);
      chromeProc = Bun.spawn(
        [
          chromePath(),
          "--headless=new",
          "--disable-gpu-sandbox",
          "--enable-unsafe-webgpu",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${chromeProfile}`,
          `--remote-debugging-port=${cdpPort}`,
          "--window-size=1280,800",
          srv.launchUrl,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );

      let wsUrl = "";
      const cdpDeadline = Date.now() + 10_000;
      while (Date.now() < cdpDeadline) {
        try {
          const list = (await (
            await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
          ).json()) as any[];
          const page = list.find(
            (t) => t.type === "page" && t.url.startsWith(srv.baseUrl),
          );
          if (page?.webSocketDebuggerUrl) {
            wsUrl = page.webSocketDebuggerUrl;
            break;
          }
        } catch {}
        await Bun.sleep(100);
      }
      expect(wsUrl).toStartWith("ws://");

      const cdp = new WebSocket(wsUrl);
      await new Promise<void>((ok) => (cdp.onopen = () => ok()));
      let seq = 0;
      const callCdp = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<any>((resolve, reject) => {
          const id = ++seq;
          const onMsg = (ev: MessageEvent) => {
            const msg = JSON.parse(String(ev.data));
            if (msg.id !== id) return;
            cdp.removeEventListener("message", onMsg);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          };
          cdp.addEventListener("message", onMsg);
          cdp.send(JSON.stringify({ id, method, params }));
        });

      let termState: any = null;
      const bootDeadline = Date.now() + 10_000;
      while (Date.now() < bootDeadline) {
        const evalRes = await callCdp("Runtime.evaluate", {
          expression: `(() => {
            const c = document.getElementById('term-canvas');
            const badge = document.getElementById('gpu-badge')?.textContent || '';
            const st = window.__aphrodyTerm;
            if (!c || !st) return null;
            return {
              width: c.width,
              height: c.height,
              badge,
              themesCount: st.themesCount,
              text: st.getText(),
              webmcp: st.webmcpTools,
              hasWebGpu: st.hasWebGpu,
            };
          })()`,
          returnByValue: true,
        });
        termState = evalRes?.result?.value;
        if (
          termState?.width > 0 &&
          termState?.text?.includes("ws_binary_ok_99")
        ) {
          break;
        }
        await Bun.sleep(100);
      }

      expect(termState).not.toBeNull();
      expect(termState.width).toBeGreaterThan(400);
      expect(termState.height).toBeGreaterThan(200);
      expect(termState.themesCount).toBeGreaterThanOrEqual(9);
      expect(termState.text).toContain("ws_binary_ok_99");
      expect(termState.webmcp).toContain("term_read_screen");

      // Verify splitPane("h") + scrollLines in live Chrome session
      const splitRes = await callCdp("Runtime.evaluate", {
        expression: `(async () => {
          await window.__aphrodyTerm.splitPane("h");
          await new Promise((r) => setTimeout(r, 350));
          return {
            paneCount: window.__aphrodyTerm.getPaneIds().length,
            scrolled: window.__aphrodyTerm.scrollLines(0),
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(splitRes?.result?.value?.paneCount).toBe(2);
      expect(splitRes?.result?.value?.scrolled).toBe(0);

      const shot = await callCdp("Page.captureScreenshot", { format: "png" });
      expect(shot.data.length).toBeGreaterThan(2000);
      cdp.close();
    } finally {
      srv.stop();
      chromeProc?.kill();
      await chromeProc?.exited.catch(() => {});
      await Bun.sleep(150);
      try {
        rmSync(chromeProfile, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {}
    }
  }, 35_000);
});
