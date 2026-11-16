// WebMCP (webmachinelearning/webmcp, document.modelContext.registerTool ; essai d'origine Chrome 149+, drapeau
// about:flags#enable-webmcp-testing locally): the relay's /webmcp page exposes its tools (and those of the MCP servers
// aggregated) to the browser agent, for example Gemini in Chrome. Each call goes back through POST /mcp tools/call.
import { TOOLS } from "./tools.ts";
import { hubTools } from "./mcp-hub.ts";

export async function webmcpPage(): Promise<string> {
  const tools = [
    ...TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    ...(Bun.env.RELAY_HUB === "0"
      ? []
      : (await hubTools()).map((t) => ({
          name: t.name,
          description: `[${t.server}] ${t.description ?? ""}`,
          inputSchema: t.inputSchema ?? { type: "object" },
        }))),
  ];
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><title>aphrody relay — WebMCP</title>
<body><pre id="s">WebMCP : enregistrement…</pre><script type="module">
const tools = ${JSON.stringify(tools).replace(/</g, "\\u003c")};
const s = document.getElementById("s");
const mc = document.modelContext ?? navigator.modelContext;
if (!mc?.registerTool) { s.textContent = "WebMCP unavailable: Chrome 149+ with about:flags#enable-webmcp-testing"; }
else {
  let id = 0;
  for (const t of tools) {
    await mc.registerTool({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      async execute(args) {
        const r = await fetch("/mcp", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: t.name, arguments: args ?? {} } }) });
        const j = await r.json();
        return j.result ?? { content: [{ type: "text", text: j.error?.message ?? "error" }], isError: true };
      },
    });
  }
  s.textContent = "WebMCP: " + tools.length + " tools registered";
}
</script></body></html>`;
}
