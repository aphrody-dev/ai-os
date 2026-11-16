// unixwin as a stdio MCP server (protocol 2025-11-25, one JSON message per line), reached through the relay hub:
// hub_call unixwin__unixwin_applets | unixwin__unixwin_plugin_manifest | unixwin__unixwin_validate_bundle | unixwin__unixwin_sh.
// Registered by [[hub.mcp]] unixwin in tools/agents/toolchain.toml. Backends: device/os/unixwin/applets.toml (provider table of the
// `ay applet` multicall), system/omniu (plugin host and bundle validator), the `ay` binary ($AY_BIN, else PATH; `ay sh` is the
// embedded Bash engine). Skill: .agents/skills/unixwin.
import { join } from "node:path";
import {
  manifest,
  sh,
  type AyOptions,
} from "../../../../system/omniu/src/ay.ts";
import { validateAll } from "../../../../system/omniu/src/validate.ts";

type Rpc = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
};
type Reply = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
};

const ok = (id: Reply["id"], result: unknown): Reply => ({
  jsonrpc: "2.0",
  id,
  result,
});
const fail = (id: Reply["id"], code: number, message: string): Reply => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const SRC = join(import.meta.dir, "..", "..", "..", "..");

/** The provider table of `ay applet`: `{ name: "winux" | "uutils" | "winux-cxx" }`. */
export async function applets(
  root: string = SRC,
): Promise<Record<string, string>> {
  const doc = Bun.TOML.parse(
    await Bun.file(join(root, "device/os/unixwin/applets.toml")).text(),
  ) as Record<string, { provider: string }>;
  return Object.fromEntries(
    Object.entries(doc).map(([k, v]) => [k, v.provider]),
  );
}

export function unixwinTools(ay: AyOptions = {}, root: string = SRC) {
  return [
    {
      name: "unixwin_applets",
      description:
        "Providers of the `ay applet` multicall (WinuxCmd is the base: winux = Rust applet linked on Windows, uutils = fills the gaps, winux-cxx = C++ Windows bundle). Optional `name` returns one applet.",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      readOnly: true,
      run: async (a: { name?: string }) => {
        const t = await applets(root);
        if (a.name)
          return t[a.name]
            ? { [a.name]: t[a.name] }
            : { error: `unknown applet ${a.name}` };
        const counts: Record<string, number> = {};
        for (const p of Object.values(t)) counts[p] = (counts[p] ?? 0) + 1;
        return { counts, applets: t };
      },
    },
    {
      name: "unixwin_plugin_manifest",
      description:
        "Plugin manifest emitted by the ay binary (`ay plugin manifest`): schema, version, embedded engine, command table and the niu and Bun host entries.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      run: async () => manifest(ay),
    },
    {
      name: "unixwin_validate_bundle",
      description:
        "Validate the oh-my-niu bundle (system/omniu): layout, plugin manifests including [bun] entries, assets, index and release notes. Returns { ok, errors }.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      run: async () => {
        const errors = validateAll(join(root, "system", "omniu"));
        return { ok: errors.length === 0, errors };
      },
    },
    {
      name: "unixwin_sh",
      description:
        "Run a command string in the Bash 5.3 engine embedded in ay (`ay sh -c`); extra `args` become $1.... Returns { code, stdout, stderr }. Not read-only.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
      },
      readOnly: false,
      run: async (a: { command?: string; args?: string[] }) => {
        if (typeof a.command !== "string")
          throw new Error("command (string) required");
        return sh(a.command, a.args ?? [], ay);
      },
    },
  ];
}

/**
 * One JSON-RPC 2.0 message to its reply; `undefined` for a notification (no `id`), which never gets one.
 * Malformed input is a reply (-32700 parse error, -32600 invalid request), never an exception.
 */
export async function respond(
  line: string,
  tools = unixwinTools(),
): Promise<Reply | undefined> {
  let m: Rpc;
  try {
    m = JSON.parse(line) as Rpc;
  } catch {
    return fail(null, -32700, "parse error");
  }
  if (
    typeof m !== "object" ||
    m === null ||
    Array.isArray(m) ||
    typeof m.method !== "string"
  )
    return fail(null, -32600, "invalid request");
  if (m.id === undefined) return undefined;
  const id = m.id;
  try {
    switch (m.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: m.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "aphrody-unixwin", version: "0.1.0" },
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: t.readOnly },
          })),
        });
      case "tools/call": {
        if (typeof m.params?.name !== "string")
          return fail(id, -32602, "params.name (string) required");
        const t = tools.find((x) => x.name === m.params.name);
        if (!t) return fail(id, -32602, `unknown tool ${m.params.name}`);
        try {
          const r = await t.run(m.params.arguments ?? {});
          return ok(id, {
            content: [{ type: "text", text: JSON.stringify(r) }],
          });
        } catch (e) {
          return ok(id, {
            isError: true,
            content: [{ type: "text", text: String(e) }],
          });
        }
      }
      default:
        return fail(id, -32601, `method not found: ${m.method}`);
    }
  } catch (e) {
    return fail(id, -32603, String(e));
  }
}

if (import.meta.main) {
  // Replies are written one at a time, each awaited: a slow reader of stdout applies backpressure instead of growing a queue.
  let out: Promise<unknown> = Promise.resolve();
  const send = (r: Reply) =>
    (out = out.then(() => Bun.write(Bun.stdout, `${JSON.stringify(r)}\n`)));
  let buf = "";
  for await (const c of Bun.stdin.stream()) {
    buf += Buffer.from(c).toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const r = await respond(line);
      if (r) await send(r);
    }
  }
  await out;
}
