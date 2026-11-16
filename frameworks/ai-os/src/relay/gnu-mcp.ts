// GNU upstream tracker as a stdio MCP server (protocol 2025-11-25, one JSON message per line), reached through the
// relay hub: hub_tools server=gnu, hub_call name=gnu__gnu_status | gnu__gnu_search | gnu__gnu_package | gnu__gnu_feed |
// gnu__gnu_kernel. Registered by [[hub.mcp]] gnu in tools/agents/toolchain.toml (hub.json). Data: system/gnu-ts feed.
import { GNU_TOOLS } from "../../../../system/gnu-ts/src/tools.ts";

type Rpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
};

const send = (m: unknown): void =>
  void process.stdout.write(`${JSON.stringify(m)}\n`);
const ok = (id: Rpc["id"], result: unknown) =>
  send({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

export async function handle(m: Rpc): Promise<void> {
  if (m.id === undefined) return; // notification
  switch (m.method) {
    case "initialize":
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "aphrody-gnu", version: "0.1.0" },
      });
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, {
        tools: GNU_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true },
        })),
      });
    case "tools/call": {
      const t = GNU_TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return fail(m.id, -32602, `unknown tool ${m.params?.name}`);
      try {
        const r = await t.run(m.params?.arguments ?? {});
        return ok(m.id, {
          content: [{ type: "text", text: JSON.stringify(r) }],
        });
      } catch (e) {
        return ok(m.id, {
          isError: true,
          content: [{ type: "text", text: String(e) }],
        });
      }
    }
    default:
      return fail(m.id, -32601, `method not found: ${m.method}`);
  }
}

if (import.meta.main) {
  let buf = "";
  for await (const c of Bun.stdin.stream()) {
    buf += Buffer.from(c).toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) await handle(JSON.parse(line) as Rpc);
    }
  }
}
