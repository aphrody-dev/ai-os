// Electron migration toolkit as a stdio MCP server (protocol 2025-11-25, one JSON message per line), reached through
// the relay hub: hub_tools server=electron, hub_call name=electron__electron_analyze | electron__electron_migrate |
// electron__electron_optimize | electron__electron_bench. Registered by [[hub.mcp]] electron in tools/agents/toolchain.toml.
// Each tool runs `ay electron <sub> ... --json` (system/electron-migrate through system/ay); AY_BIN overrides the `ay` binary.

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

const MAX_OUT = 400_000;

type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  readOnly: boolean;
  args: (a: Record<string, any>) => string[];
};

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
  return v;
};

export const ELECTRON_TOOLS: Tool[] = [
  {
    name: "electron_analyze",
    description:
      "Unpack an Electron app (dir, install dir or app.asar with its .unpacked sibling) and return the JSON manifest: Electron version and fuses, windows, preloads, IPC channels, contextBridge APIs, Node APIs, native modules, protocols, menus, tray, updater, deep links. Heuristic static scan; see `limits` in the output. Writes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "App directory, install directory or app.asar",
        },
        node_modules: {
          type: "boolean",
          description: "Also scan node_modules JavaScript (slow)",
        },
      },
      required: ["input"],
    },
    readOnly: true,
    args: (a) => [
      "analyze",
      str(a.input, "input"),
      ...(a.node_modules ? ["--node-modules"] : []),
    ],
  },
  {
    name: "electron_migrate",
    description:
      "Generate a Tauri v3 (aphrody-labs/tauri fork) or GPUI project from an Electron app into `out`, with frontend/, shim/, a Bun sidecar, MAPPING.md and coverage.json (1:1 / stubbed / unsupported counts). Returns the coverage report.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", enum: ["tauri", "gpui"] },
        input: { type: "string" },
        out: { type: "string", description: "Output directory (created)" },
        no_sidecar_app: {
          type: "boolean",
          description:
            "Do not copy the original main-process files into sidecar/app/",
        },
      },
      required: ["to", "input", "out"],
    },
    readOnly: false,
    args: (a) => {
      if (a.to !== "tauri" && a.to !== "gpui")
        throw new Error("to must be tauri or gpui");
      return [
        "migrate",
        "--json",
        "--to",
        a.to,
        str(a.input, "input"),
        "--out",
        str(a.out, "out"),
        ...(a.no_sidecar_app ? ["--no-sidecar-app"] : []),
      ];
    },
  },
  {
    name: "electron_optimize",
    description:
      "Write the release profile (fat LTO, codegen-units 1, panic abort, strip), the PGO script and the Bun --compile --minify --bytecode build script into a generated project; reports artifact sizes before (and after with build=true).",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Directory produced by electron_migrate",
        },
        opt_level: { type: "string", enum: ["3", "2", "1", "s", "z"] },
        build: {
          type: "boolean",
          description:
            "Run bun and cargo release builds and measure sizes after",
        },
      },
      required: ["project"],
    },
    readOnly: false,
    args: (a) => [
      "optimize",
      "--json",
      str(a.project, "project"),
      ...(a.opt_level ? ["--opt-level", String(a.opt_level)] : []),
      ...(a.build ? ["--build"] : []),
    ],
  },
  {
    name: "electron_bench",
    description:
      "Compare the original Electron app and the migrated build: hyperfine cold start, RSS of the process tree, binary and install size, IPC round trip over CDP. Launches the executables.",
    inputSchema: {
      type: "object",
      properties: {
        electron: { type: "string", description: "Electron app executable" },
        migrated: { type: "string", description: "Migrated app executable" },
        runs: { type: "integer" },
        warmup: { type: "integer" },
        ipc_expr_electron: {
          type: "string",
          description:
            "Page-side expression awaited for the Electron IPC round trip",
        },
        ready: { type: "string", enum: ["cdp", "alive"] },
      },
    },
    readOnly: false,
    args: (a) => {
      if (!a.electron && !a.migrated)
        throw new Error("electron and/or migrated is required");
      const out = ["bench", "--json"];
      if (a.electron) out.push("--electron", String(a.electron));
      if (a.migrated) out.push("--migrated", String(a.migrated));
      if (a.runs) out.push("--runs", String(a.runs));
      if (a.warmup) out.push("--warmup", String(a.warmup));
      if (a.ipc_expr_electron)
        out.push("--ipc-expr-electron", String(a.ipc_expr_electron));
      if (a.ready) out.push("--ready", String(a.ready));
      return out;
    },
  },
];

async function runAy(args: string[]): Promise<string> {
  const proc = Bun.spawn([process.env.AY_BIN ?? "ay", "electron", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `ay electron ${args[0]} exited ${code}: ${err.trim() || out.trim()}`,
    );
  return out.length > MAX_OUT
    ? `${out.slice(0, MAX_OUT)}\n...truncated (${out.length} bytes); use --out with the CLI for the full manifest`
    : out;
}

export async function handle(m: Rpc): Promise<void> {
  if (m.id === undefined) return; // notification
  switch (m.method) {
    case "initialize":
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "aphrody-electron", version: "0.1.0" },
      });
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, {
        tools: ELECTRON_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly },
        })),
      });
    case "tools/call": {
      const t = ELECTRON_TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return fail(m.id, -32602, `unknown tool ${m.params?.name}`);
      try {
        const text = await runAy(t.args(m.params?.arguments ?? {}));
        return ok(m.id, { content: [{ type: "text", text }] });
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
