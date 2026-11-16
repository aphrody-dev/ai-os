#!/usr/bin/env bun
// relay: Claude Code <-> Gemini bridge and fleet tools.
//   relay serve                  HTTP (rpc, mcp, a2a, ws), TCP, TLS
//   relay browser [--headful]    relay Chrome (dedicated profile, CDP 127.0.0.1:RELAY_CDP_PORT)
//   relay login                  visible relay Chrome: Google sign-in (the owner-facing entry point is `<binary> auth login gemini-web`)
//   relay ask <prompt…>          question to Gemini (Antigravity, --web: gemini.google.com); --claude for headless Claude Code
//   relay review <file>          Gemini review of a file, scored /20
//   relay inspect                survey of the Gemini selectors (diagnostic)
//   relay acp                    ACP agent over stdio
//   relay mcp-stdio              same MCP server as POST /mcp, over stdio (line-delimited JSON-RPC)
//   relay token                  prints the token (for claude mcp add)
//   relay mcp-add [--bearer]     registers the relay in Claude Code (user scope): OAuth 2.1 (DCR + PKCE,
//                                automatic approval on loopback, zero clicks); --bearer: fixed token in a header
//   relay approve <code> [--deny]  consent d'une demande OAuth en attente (code utilisateur RFC 8628 ou demande /authorize)
//   relay client add <name> [--scope "mcp a2a"]  confidential client_credentials client; secret written to
//                                <relayHome>/clients/<name>.json (0600), never displayed
import { browserInfo, closeBrowser, launchBrowser } from "./cdp.ts";
import { acp } from "./acp.ts";
import { claude, gemini } from "./backends.ts";
import { dispatch, mcpRpc } from "./protocols.ts";
import { relayToken, serve } from "./server.ts";
import { toolByName } from "./tools.ts";

const [cmd, ...rest] = Bun.argv.slice(2);
const flag = (f: string) => rest.includes(f);
const words = rest.filter((w) => !w.startsWith("--")).join(" ");

switch (cmd) {
  case "serve":
    await serve();
    break;
  case "browser":
    await launchBrowser(!flag("--headful"));
    console.log(await browserInfo());
    break;
  case "login":
    // A headless relay Chrome already holds the profile: close it so the visible one can open.
    await closeBrowser();
    await launchBrowser(false);
    console.log(
      "Relay Chrome opened on gemini.google.com: sign in, then close the window and run `relay browser`.",
    );
    break;
  case "ask": {
    const a = flag("--claude")
      ? await claude(words)
      : await gemini(words, { engine: flag("--web") ? "web" : undefined });
    console.log(a.text);
    console.error(`[${a.engine} ${a.ms} ms${a.chat ? ` ${a.chat}` : ""}]`);
    break;
  }
  case "review": {
    const f = rest[0];
    if (!f) throw new Error("usage: relay review <file>");
    const a: any = await toolByName
      .get("gemini_review")!
      .run({ title: f, content: await Bun.file(f).text() });
    console.log(a.text);
    break;
  }
  case "recon":
    console.log(
      JSON.stringify(
        await (await import("./recon.ts")).recon(rest[0]),
        null,
        1,
      ),
    );
    break;
  case "inspect":
    await import("./inspect.ts");
    break;
  case "acp":
    await acp();
    break;
  case "mcp-stdio": {
    // UTF-8 decoded as a stream (characters split across two chunks); requests handled in parallel.
    const dec = new TextDecoder("utf-8");
    const pending = new Set<Promise<void>>();
    const send = (o: unknown) =>
      void process.stdout.write(`${JSON.stringify(o)}\n`);
    let buf = "";
    for await (const chunk of process.stdin) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let body: unknown;
        try {
          body = JSON.parse(line);
        } catch {
          send({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
          continue;
        }
        const p = dispatch(body, mcpRpc).then((out) => {
          if (out) send(out);
        });
        pending.add(p);
        p.finally(() => pending.delete(p));
      }
    }
    await Promise.all(pending);
    break;
  }
  case "token":
    console.log(await relayToken());
    break;
  case "mcp-add": {
    const port = Bun.env.RELAY_PORT ?? "8790";
    const args = [
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "relay",
      `http://127.0.0.1:${port}/mcp`,
    ];
    if (flag("--bearer"))
      args.push("--header", `Authorization: Bearer ${await relayToken()}`);
    const p = Bun.spawnSync(args);
    console.log(p.stdout.toString() || p.stderr.toString());
    break;
  }
  case "approve": {
    const port = Bun.env.RELAY_PORT ?? "8790";
    const r = await fetch(`http://127.0.0.1:${port}/oauth/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await relayToken()}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        user_code: rest[0] ?? "",
        request: rest[0] ?? "",
        decision: flag("--deny") ? "deny" : "allow",
      }),
    });
    console.log(r.ok ? "approved" : `refused: ${await r.text()}`);
    process.exit(r.ok ? 0 : 1);
  }
  case "client": {
    const name = rest[1];
    if (rest[0] !== "add" || !name || !/^[\w.-]+$/.test(name))
      throw new Error('usage : relay client add <nom> [--scope "mcp a2a"]');
    const port = Bun.env.RELAY_PORT ?? "8790";
    const i = rest.indexOf("--scope");
    const scope = i >= 0 ? rest[i + 1] : "mcp a2a";
    const r = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await relayToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_name: name,
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "client_secret_basic",
        scope,
      }),
    });
    if (!r.ok) throw new Error(`registration refused: ${await r.text()}`);
    const { join } = await import("node:path");
    const { mkdirSync } = await import("node:fs");
    const { relayHome } = await import("./cdp.ts");
    const dir = join(relayHome(), "clients");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${name}.json`);
    const j = (await r.json()) as { client_id: string };
    await Bun.write(
      f,
      JSON.stringify({
        ...j,
        token_endpoint: `http://127.0.0.1:${port}/oauth/token`,
      }),
    );
    if (process.platform !== "win32") Bun.spawnSync(["chmod", "600", f]);
    console.log(`client ${j.client_id}: credentials in ${f}`);
    break;
  }
  default:
    console.error(
      "usage: relay serve | browser [--headful] | login | ask <prompt> [--claude|--web] | review <file> | inspect | recon [url] | acp | mcp-stdio | token | mcp-add [--bearer] | approve <code> | client add <name>",
    );
    process.exit(2);
}
