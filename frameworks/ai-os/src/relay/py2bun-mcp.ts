// py2bun as a stdio MCP server (protocol 2025-11-25, one JSON message per line), reached through the relay hub:
// hub_call name=py2bun__py2bun_transpile. Registered by [[hub.mcp]] py2bun in tools/agents/toolchain.toml.
// Backend: system/py2bun-ts (Rust CLI py2bun-rs, $PY2BUN_BIN or system/py2bun/target).
import { transpile } from "../../../../system/py2bun-ts/src/index.ts";

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

export const PY2BUN_TOOLS = [
  {
    name: "py2bun_transpile",
    description:
      "Transpile Python 3 (or Jython-era Python 2 print/except) source to Bun TypeScript, with Ghidra FlatAPI and Java imports mapped to @aphrody/ghidra. Returns {ts, diagnostics, ok}; unsupported constructs are reported, never silently dropped.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string", description: "Python source" } },
      required: ["source"],
    },
    run: async (a: { source?: string }) => {
      if (typeof a.source !== "string")
        throw new Error("source (string) required");
      return transpile(a.source);
    },
  },
];

export async function handle(m: Rpc): Promise<void> {
  if (m.id === undefined) return;
  switch (m.method) {
    case "initialize":
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "aphrody-py2bun", version: "0.1.0" },
      });
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, {
        tools: PY2BUN_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true },
        })),
      });
    case "tools/call": {
      const t = PY2BUN_TOOLS.find((x) => x.name === m.params?.name);
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
