// Zero-dependency Bun HTTP + WebSocket server for Aphrody AI-First WebGPU Terminal.
import { listTermThemes } from "@aphrody/core";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { a2aHttp, agentCard } from "../relay/a2a.ts";
import { handle as acpHandle } from "../relay/acp.ts";
import { chromePath } from "../relay/cdp.ts";
import { dispatch, mcpRpc } from "../relay/protocols.ts";
import {
  askTerminalAgent,
  discoverAiCatalog,
  discoverAiCatalogFast,
  streamTerminalAgent,
} from "./agent-bridge.ts";
import { sharedTermManager, type TermEvent, type TermManager } from "./pty.ts";

export interface TermServerOptions {
  port?: number;
  host?: string;
  token?: string;
  defaultProfile?: string;
  theme?: string;
  manager?: TermManager;
}

const MIME: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "term-host.js": "application/javascript; charset=utf-8",
  "vterm-wasm.js": "application/javascript; charset=utf-8",
  "term.wgsl": "text/plain; charset=utf-8",
};

function makeSessionHmac(token: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`ay-term:${token}`)
    .digest("hex");
}

function findSrcRoot(): string {
  return Bun.env.SRC_ROOT ?? join(import.meta.dir, "..", "..", "..", "..");
}

export async function startTermServer(opts: TermServerOptions = {}) {
  const host = opts.host ?? Bun.env.AY_TERM_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(Bun.env.AY_TERM_PORT ?? 8795);
  const token =
    opts.token ??
    Bun.env.AY_TERM_TOKEN ??
    Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const sessionSecret = makeSessionHmac(token);
  const manager = opts.manager ?? sharedTermManager();
  const webDir = join(import.meta.dir, "web");
  const wasmPath = join(findSrcRoot(), "target", "sys", "aysys.wasm");
  if (!existsSync(wasmPath)) {
    throw new Error(`aysys.wasm not found: ${wasmPath} (run make -C src wasm)`);
  }

  // Ensure at least one initial PTY pane exists ready for instant zero-wait attach
  if (manager.list().length === 0) {
    manager.spawn({
      profile: opts.defaultProfile,
      theme: opts.theme ?? "aphrody-m3-dark",
    });
  }

  const hasCookie = (req: Request) =>
    (req.headers.get("cookie") ?? "")
      .split(/;\s*/)
      .includes(`ayterm=${sessionSecret}`);
  const hasBearer = (req: Request) =>
    req.headers.get("authorization") === `Bearer ${token}`;
  const isAuthed = (req: Request) => hasCookie(req) || hasBearer(req);
  const deny = () => new Response("Unauthorized", { status: 401 });

  const serveWebAsset = (name: string) =>
    new Response(Bun.file(join(webDir, name)), {
      headers: {
        "content-type": MIME[name] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });

  type WsData = { paneId: string; unsub?: () => void };

  const server = Bun.serve<WsData>({
    hostname: host,
    port,
    idleTimeout: 255,
    async fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname === "/health") {
        return Response.json({ ok: true, panes: manager.list().length });
      }
      if (u.pathname === "/.well-known/agent-card.json") {
        return Response.json(agentCard(`${u.protocol}//${u.host}`));
      }

      // Token bootstrap: strip token from URL via 303 redirect and store HttpOnly session cookie
      if (u.pathname === "/" && u.searchParams.get("token") === token) {
        const clean = new URL(req.url);
        clean.searchParams.delete("token");
        return new Response(null, {
          status: 303,
          headers: {
            location: `${clean.pathname}${clean.search}`,
            "set-cookie": `ayterm=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
          },
        });
      }

      // Public browser boot asset check: "/" requires cookie (redirects cleanly when opened without token only if unauthed)
      if (!isAuthed(req)) return deny();

      if (u.pathname === "/") return serveWebAsset("index.html");
      if (u.pathname === "/term-host.js") return serveWebAsset("term-host.js");
      if (u.pathname === "/vterm-wasm.js")
        return serveWebAsset("vterm-wasm.js");
      if (u.pathname === "/term.wgsl") return serveWebAsset("term.wgsl");
      if (u.pathname === "/aysys.wasm") {
        return new Response(Bun.file(wasmPath), {
          headers: {
            "content-type": "application/wasm",
            "cache-control": "no-store",
          },
        });
      }

      if (u.pathname.startsWith("/ws/pty/")) {
        const paneId = decodeURIComponent(u.pathname.slice("/ws/pty/".length));
        if (!manager.get(paneId))
          return new Response("Unknown pane", { status: 404 });
        if (srv.upgrade(req, { data: { paneId } })) return undefined;
        return new Response("Upgrade required", { status: 426 });
      }

      if (u.pathname === "/api/info" && req.method === "GET") {
        // Return immediately without waiting on remote model catalog fetch
        void discoverAiCatalog().catch(() => {});
        return Response.json({
          profiles: manager.profiles(),
          themes: listTermThemes(),
          ai: discoverAiCatalogFast(),
          panes: manager.list(),
        });
      }

      if (u.pathname === "/api/ai/catalog" && req.method === "GET") {
        return Response.json(await discoverAiCatalog());
      }

      if (u.pathname === "/api/panes") {
        if (req.method === "GET") return Response.json(manager.list());
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const pane = manager.spawn({
            profile: body.profile,
            cwd: body.cwd,
            cols: body.cols,
            rows: body.rows,
            theme: body.theme ?? opts.theme ?? "aphrody-m3-dark",
          });
          return Response.json(pane.summary());
        }
      }

      if (
        u.pathname.endsWith("/text") &&
        u.pathname.startsWith("/api/panes/")
      ) {
        const id = decodeURIComponent(
          u.pathname.slice("/api/panes/".length, -"/text".length),
        );
        const pane = manager.get(id);
        if (!pane) return new Response("Unknown pane", { status: 404 });
        const includeSb = u.searchParams.get("scrollback") === "1";
        const meta = pane.vterm.meta();
        return Response.json({
          meta,
          text: includeSb
            ? pane.scrollbackText(0, meta.scrollbackLen + meta.rows)
            : pane.vterm.text(),
          blocks: pane.vterm.blocks(),
        });
      }

      if (u.pathname.startsWith("/api/panes/") && req.method === "DELETE") {
        const id = decodeURIComponent(u.pathname.slice("/api/panes/".length));
        return Response.json({ closed: manager.close(id) });
      }

      if (u.pathname === "/api/ai/ask" && req.method === "POST") {
        try {
          const body = (await req.json()) as any;
          const res = await askTerminalAgent(manager, body);
          return Response.json(res);
        } catch (e: any) {
          return Response.json(
            { error: String(e?.message ?? e) },
            { status: 500 },
          );
        }
      }

      if (u.pathname === "/api/ai/stream" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const push = (event: string, data: unknown) => {
              try {
                controller.enqueue(
                  enc.encode(
                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                  ),
                );
              } catch {}
            };
            try {
              await streamTerminalAgent(manager, body, (ev) => {
                push(ev.type, ev);
              });
            } catch (e: any) {
              push("error", { error: String(e?.message ?? e) });
            } finally {
              try {
                controller.close();
              } catch {}
            }
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          },
        });
      }

      if (u.pathname === "/mcp" && req.method === "POST") {
        const body = await req.json();
        const out = await dispatch(body, mcpRpc);
        return out === null
          ? new Response(null, { status: 202 })
          : Response.json(out);
      }

      if (u.pathname === "/acp" && req.method === "POST") {
        const body = (await req.json()) as Parameters<typeof acpHandle>[0];
        const msgs: unknown[] = [];
        await acpHandle(body, (m) => msgs.push(m));
        const reply = msgs.find(
          (m: any) =>
            m && typeof m === "object" && "id" in m && m.id !== undefined,
        );
        const updates = msgs.filter((m) => m !== reply);
        return reply
          ? Response.json(
              updates.length
                ? { ...(reply as object), _updates: updates }
                : reply,
            )
          : new Response(null, { status: 202 });
      }

      if (u.pathname === "/a2a" && req.method === "POST") {
        return a2aHttp(req);
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const pane = manager.get(ws.data.paneId);
        if (!pane) {
          ws.close();
          return;
        }
        for (const chunk of pane.replayChunks()) {
          ws.send(chunk);
        }
        ws.data.unsub = pane.subscribe((ev: TermEvent) => {
          try {
            if (ev.type === "data" && ev.chunk) {
              ws.send(ev.chunk);
            } else {
              ws.send(JSON.stringify(ev));
            }
          } catch {}
        });
      },
      message(ws, msg) {
        const pane = manager.get(ws.data.paneId);
        if (!pane) return;
        if (typeof msg === "string" && msg.startsWith("{")) {
          try {
            const ctrl = JSON.parse(msg);
            if (ctrl.type === "resize") {
              pane.resize(Number(ctrl.cols), Number(ctrl.rows));
              return;
            }
            if (ctrl.type === "theme" && ctrl.slug) {
              pane.setTheme(String(ctrl.slug));
              return;
            }
          } catch {}
        }
        pane.write(
          typeof msg === "string"
            ? msg
            : new Uint8Array(msg instanceof ArrayBuffer ? msg : msg.buffer),
        );
      },
      close(ws) {
        ws.data.unsub?.();
      },
    },
  });

  const baseUrl = `http://${host}:${server.port}`;
  const launchUrl = `${baseUrl}/?token=${token}`;
  return {
    server,
    port: server.port,
    baseUrl,
    launchUrl,
    token,
    manager,
    stop: () => {
      server.stop(true);
      manager.closeAll();
    },
  };
}

export function launchTermDesktopWindow(url: string) {
  const exe = chromePath();
  const dataDir =
    process.platform === "win32"
      ? join(Bun.env.LOCALAPPDATA ?? homedir(), "aphrody", "term-app")
      : join(homedir(), ".local", "state", "aphrody", "term-app");
  mkdirSync(dataDir, { recursive: true });
  return Bun.spawn(
    [
      exe,
      `--app=${url}`,
      `--user-data-dir=${dataDir}`,
      "--window-size=1440,900",
      "--force-renderer-accessibility",
      "--no-first-run",
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    },
  );
}
