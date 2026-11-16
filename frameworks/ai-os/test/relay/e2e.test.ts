// E2E against the live relay (service AphrodyRelay, 127.0.0.1:8790): protocols, hub MCP servers, skills, custom
// subagents, CLIs of tools.toml and the Claude PreToolUse guard. Skipped as a whole when the relay is down.
// Run: `just relay-e2e` or `bun test frameworks/ai-os/test/relay/e2e.test.ts`. The bearer token comes from
// `bun src/relay/headers.ts` and is never printed.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "..", "..");
const BASE = `http://${Bun.env.RELAY_HOST ?? "127.0.0.1"}:${Bun.env.RELAY_PORT ?? 8790}`;
const WS_BASE = BASE.replace("http", "ws");
const SENTINEL = /^[A-Za-z0-9._~+/=-]+$/;

const alive = await fetch(`${BASE}/health`, {
  signal: AbortSignal.timeout(3000),
})
  .then((r) => r.ok)
  .catch(() => false);
if (!alive) console.warn(`relay e2e skipped: ${BASE} is not answering`);

let auth: Record<string, string> = {};
let bearer = "";
if (alive) {
  const p = Bun.spawnSync([
    "bun",
    join(SRC, "frameworks/ai-os/src/relay/headers.ts"),
  ]);
  auth = JSON.parse(p.stdout.toString());
  bearer = String(auth.Authorization ?? "").replace(/^Bearer /, "");
}

type Msg = any;
/** POST a JSON-RPC body; the answer is plain JSON or SSE ("event: message" / "data: ..."): both become Msg[]. */
async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  ms = 60_000,
  withAuth = true,
): Promise<{ status: number; msgs: Msg[] }> {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(withAuth ? auth : {}),
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const t = await r.text();
  if (!t.trim()) return { status: r.status, msgs: [] };
  if (/^\s*(event:|data:)/m.test(t) && !t.trimStart().startsWith("{")) {
    const msgs = t
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return { status: r.status, msgs };
  }
  try {
    const j = JSON.parse(t);
    return { status: r.status, msgs: Array.isArray(j) ? j : [j] };
  } catch {
    return { status: r.status, msgs: [{ raw: t }] };
  }
}
let seq = 0;
const rpc = async (
  path: string,
  method: string,
  params?: unknown,
  headers?: Record<string, string>,
  ms?: number,
) =>
  (
    await post(
      path,
      {
        jsonrpc: "2.0",
        id: ++seq,
        method,
        ...(params === undefined ? {} : { params }),
      },
      headers,
      ms,
    )
  ).msgs[0];
/** tools/call on /mcp/core: structured result or the first text block, parsed from JSON when possible. */
async function tool(
  name: string,
  args: unknown = {},
  path = "/mcp/core",
  ms = 90_000,
) {
  const m = await rpc(
    path,
    "tools/call",
    { name, arguments: args },
    undefined,
    ms,
  );
  const r = m?.result;
  const raw = r?.content?.[0]?.text;
  let data: any = r?.structuredContent;
  if (data === undefined && typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  return {
    msg: m,
    result: r,
    error: m?.error,
    isError: r?.isError === true,
    data,
    text: String(raw ?? ""),
  };
}

// ---------------------------------------------------------------- A2A helpers
const A2A = { "A2A-Version": "1.0" };
const a2a = (method: string, params?: unknown, ms?: number) =>
  rpc("/a2a", method, params, A2A, ms);
const userMsg = (text: string, metadata: Record<string, unknown>) => ({
  message: {
    role: "ROLE_USER",
    messageId: crypto.randomUUID(),
    parts: [{ text }],
    metadata,
  },
});
const TERMINAL = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];
async function poll(id: string, ms = 90_000) {
  const end = Date.now() + ms;
  let t: any;
  while (Date.now() < end) {
    t = (await a2a("GetTask", { id })).result;
    if (TERMINAL.includes(t?.status?.state)) return t;
    await Bun.sleep(400);
  }
  return t;
}
const artifactText = (t: any) =>
  (t?.artifacts ?? [])
    .flatMap((a: any) => a.parts.map((p: any) => p.text))
    .join("\n");

let modelPick: Promise<{ model: string; task: any } | null> | undefined;
/** First discovered model (local ones first) that answers "pong" through A2A llm_ask. */
const pickModel = () =>
  (modelPick ??= (async () => {
    const { data } = await tool("llm_models");
    const groups: any[] = Array.isArray(data) ? data : [];
    const order = ["ollama", "fabric", "cloudflare", "openrouter"];
    const ids: string[] = groups
      .filter((g) => g.available && g.models?.length)
      .sort(
        (a, b) =>
          ((order.indexOf(a.provider) + 99) % 99) -
          ((order.indexOf(b.provider) + 99) % 99),
      )
      .flatMap((g) => g.models.slice(0, 2).map((m: any) => m.id as string));
    for (const model of ids.slice(0, 6)) {
      const s = await a2a("SendMessage", {
        ...userMsg("Reply with the single word: pong", {
          skill: "llm_ask",
          model,
        }),
        configuration: { returnImmediately: true },
      });
      const id = s.result?.task?.id;
      if (!id) continue;
      const t = await poll(id, 60_000);
      if (
        t?.status?.state === "TASK_STATE_COMPLETED" &&
        /pong/i.test(artifactText(t))
      )
        return { model, task: t };
    }
    return null;
  })());

// ---------------------------------------------------------------- front matter
function frontmatter(file: string): {
  fm: Record<string, any> | null;
  err?: string;
} {
  const s = readFileSync(file, "utf8").replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(s);
  if (!m) return { fm: null, err: "no frontmatter" };
  try {
    const fm = Bun.YAML.parse(m[1]!) as any;
    return fm && typeof fm === "object"
      ? { fm }
      : { fm: null, err: "frontmatter is not a mapping" };
  } catch {
    // Claude Code reads plain scalars containing ": " leniently; so do we (key: rest of line, "- x" items, indented continuation).
    const fm: Record<string, any> = {};
    let key = "";
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (kv) {
        key = kv[1]!;
        const v = kv[2]!.replace(/^(['"])(.*)\1$/, "$2");
        fm[key] = /^[|>][+-]?$/.test(v) ? "" : v;
      } else if (key && /^\s*-\s+/.test(line)) {
        if (!Array.isArray(fm[key])) fm[key] = [];
        fm[key].push(line.replace(/^\s*-\s+/, "").trim());
      } else if (key && /^\s+\S/.test(line) && typeof fm[key] === "string")
        fm[key] = `${fm[key]} ${line.trim()}`.trim();
      else if (line.trim())
        return { fm: null, err: `unparsable line: ${line.slice(0, 60)}` };
    }
    return Object.keys(fm).length
      ? { fm }
      : { fm: null, err: "empty frontmatter" };
  }
}
const skillDirs = () => {
  const roots = [join(SRC, ".agents/skills"), join(SRC, ".claude/skills")];
  const apps = join(SRC, "apps");
  if (existsSync(apps))
    for (const a of readdirSync(apps))
      roots.push(
        join(apps, a, ".claude/skills"),
        join(apps, a, ".agents/skills"),
      );
  return roots.filter(existsSync);
};
const skillFiles = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => join(root, d.name, "SKILL.md"))
    .filter(existsSync);

describe.skipIf(!alive)("relay e2e", () => {
  // ------------------------------------------------------------ 1. protocols
  describe("protocols", () => {
    test("health, metrics and auth gate", async () => {
      const h: any = await (await fetch(`${BASE}/health`)).json();
      expect(h.name).toBe("aphrody-relay");
      const m = await fetch(`${BASE}/metrics`);
      expect(m.status).toBe(200);
      const r = await post(
        "/rpc",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {},
        10_000,
        false,
      );
      expect(r.status).toBe(401);
    });

    test("token never leaks through the headers helper shape", () => {
      expect(Object.keys(auth)).toEqual(["Authorization"]);
      expect(SENTINEL.test(bearer)).toBe(true);
    });

    test("/rpc native: tools/list, call, errors, batch, parse error", async () => {
      const l = await rpc("/rpc", "tools/list", { hub: false });
      expect(Array.isArray(l.result)).toBe(true);
      const names: string[] = l.result.map((t: any) => t.name);
      for (const n of [
        "llm_models",
        "hub_tools",
        "hub_call",
        "skills_list",
        "skills_view",
      ])
        expect(names).toContain(n);
      const call = await rpc("/rpc", "llm_models", {});
      expect(call.error).toBeUndefined();
      expect(Array.isArray(call.result)).toBe(true);
      expect((await rpc("/rpc", "no_such_tool", {})).error.code).toBe(-32601);
      expect((await rpc("/rpc", "hub_tools", [])).error.code).toBe(-32602);
      const batch = await post("/rpc", [
        { jsonrpc: "2.0", id: 1, method: "llm_models" },
        { jsonrpc: "2.0", id: 2, method: "no_such_tool" },
      ]);
      expect(batch.msgs.length).toBe(2);
      const bad = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: auth,
        body: "{not json",
      });
      expect(((await bad.json()) as any).error.code).toBe(-32700);
    }, 90_000);

    test("/mcp and /mcp/core: initialize, discover, tools/list, core blocks aggregated tools/call", async () => {
      for (const path of ["/mcp", "/mcp/core"]) {
        const i = await rpc(path, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "e2e", version: "0" },
        });
        expect(i.result.serverInfo.name).toBe("aphrody-relay");
        expect(i.result.protocolVersion).toBe("2025-11-25");
        expect((await rpc(path, "ping")).result).toEqual({});
      }
      const d = await rpc("/mcp", "server/discover");
      expect(d.result.supportedVersions).toContain("2026-07-28");
      const old = await rpc("/mcp", "tools/list", {
        _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" },
      });
      expect(old.error.code).toBe(-32602);

      const native = (
        await rpc("/rpc", "tools/list", { hub: false })
      ).result.map((t: any) => t.name as string);
      const core = (await rpc("/mcp/core", "tools/list")).result.tools.map(
        (t: any) => t.name as string,
      );
      const full = (
        await rpc("/mcp", "tools/list", undefined, undefined, 120_000)
      ).result.tools.map((t: any) => t.name as string);
      console.log(
        `tools: native ${native.length}, /mcp/core ${core.length}, /mcp ${full.length}`,
      );
      for (const n of native) expect(core).toContain(n);
      expect(full.length).toBeGreaterThanOrEqual(core.length);
      const onlyFull = full.filter(
        (n: string) => !core.includes(n) && n.includes("__"),
      );
      const victim = onlyFull[0] ?? "zz-aggregated__nothing";
      const blocked = await rpc("/mcp/core", "tools/call", {
        name: victim,
        arguments: {},
      });
      expect(blocked.error?.code).toBe(-32602);
      expect(blocked.error?.message).toContain("Unknown tool");
      const noName = await rpc("/mcp/core", "tools/call", { arguments: {} });
      expect(noName.error.code).toBe(-32602);
      const badArgs = await rpc("/mcp/core", "tools/call", {
        name: "llm_models",
        arguments: [],
      });
      expect(badArgs.error.code).toBe(-32602);
      expect((await rpc("/mcp", "no/such")).error.code).toBe(-32601);
    }, 150_000);

    test("A2A card and version gate", async () => {
      const card: any = await (
        await fetch(`${BASE}/.well-known/agent-card.json`)
      ).json();
      expect(card.name).toBe("aphrody-relay");
      const skills = card.skills.map((s: any) => s.id);
      for (const s of [
        "gemini_ask",
        "gemini_review",
        "claude_ask",
        "llm_ask",
        "agy_ask",
        "agent_run",
      ])
        expect(skills).toContain(s);
      expect(card.capabilities.streaming).toBe(true);
      const list = await a2a("ListTasks");
      expect(Array.isArray(list.result.tasks)).toBe(true);
      const v2 = await rpc("/a2a", "ListTasks", undefined, {
        "A2A-Version": "2.0",
      });
      expect(v2.error.code).toBe(-32009);
      expect((await a2a("GetTask", { id: "nope" })).error.code).toBe(-32001);
      expect((await a2a("Nope")).error.code).toBe(-32601);
    });

    test("A2A llm_ask without model is rejected", async () => {
      const r = await a2a(
        "SendMessage",
        userMsg("Reply with the single word: pong", { skill: "llm_ask" }),
      );
      expect(r.error.code).toBe(-32602);
      expect(JSON.stringify(r.error)).toContain("llm_ask needs provider/model");
    });

    test("A2A SendMessage -> GetTask completes with pong", async () => {
      const p = await pickModel();
      expect(
        p,
        "no discovered model answered pong through llm_ask",
      ).not.toBeNull();
      expect(p!.task.status.state).toBe("TASK_STATE_COMPLETED");
      expect(artifactText(p!.task).toLowerCase()).toContain("pong");
    }, 400_000);

    test("A2A SendStreamingMessage streams SSE to completion", async () => {
      const p = await pickModel();
      expect(p).not.toBeNull();
      const { msgs } = await post(
        "/a2a",
        {
          jsonrpc: "2.0",
          id: ++seq,
          method: "SendStreamingMessage",
          params: userMsg("Reply with the single word: pong", {
            skill: "llm_ask",
            model: p!.model,
          }),
        },
        A2A,
        120_000,
      );
      expect(msgs[0].result.task.id).toBeTruthy();
      const states = msgs
        .filter((m) => m.result?.statusUpdate)
        .map((m) => m.result.statusUpdate.status.state);
      expect(states.at(-1)).toBe("TASK_STATE_COMPLETED");
      const art = msgs.find((m) => m.result?.artifactUpdate)?.result
        .artifactUpdate.artifact.parts[0].text;
      expect(String(art).toLowerCase()).toContain("pong");
    }, 150_000);

    test("A2A CancelTask on a long task", async () => {
      const p = await pickModel();
      expect(p).not.toBeNull();
      const s = await a2a("SendMessage", {
        ...userMsg(
          "Write a 1500 word essay about the history of tides, with headings.",
          { skill: "llm_ask", model: p!.model },
        ),
        configuration: { returnImmediately: true },
      });
      const id = s.result.task.id;
      await Bun.sleep(150);
      const c = await a2a("CancelTask", { id });
      expect(c.result?.status?.state).toBe("TASK_STATE_CANCELED");
      await Bun.sleep(1500);
      expect((await a2a("GetTask", { id })).result.status.state).toBe(
        "TASK_STATE_CANCELED",
      );
      expect((await a2a("CancelTask", { id })).error.code).toBe(-32002);
    }, 60_000);

    test("ACP: initialize, session/new, session/list, prompt", async () => {
      const i = await rpc("/acp", "initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(i.result.protocolVersion).toBe(1);
      expect(i.result.agentInfo.name).toBe("aphrody-relay");
      expect((await rpc("/acp", "initialize", {})).error.code).toBe(-32602);
      expect(
        (await rpc("/acp", "session/new", { cwd: "relative", mcpServers: [] }))
          .error.code,
      ).toBe(-32602);
      const p = await pickModel();
      const n = await rpc("/acp", "session/new", {
        cwd: SRC,
        mcpServers: [],
        ...(p ? { _meta: { model: p.model } } : {}),
      });
      expect(typeof n.result.sessionId).toBe("string");
      const l = await rpc("/acp", "session/list", { cwd: SRC });
      expect(
        l.result.sessions.some((s: any) => s.sessionId === n.result.sessionId),
      ).toBe(true);
      if (p) {
        const r = await rpc(
          "/acp",
          "session/prompt",
          {
            sessionId: n.result.sessionId,
            prompt: [
              { type: "text", text: "Reply with the single word: pong" },
            ],
          },
          undefined,
          120_000,
        );
        expect(r.result?.stopReason).toBe("end_turn");
        expect(JSON.stringify(r._updates ?? [])).toMatch(/pong/i);
      }
    }, 200_000);

    test("/webmcp bootstrap page", async () => {
      expect(
        (await fetch(`${BASE}/webmcp`, { redirect: "manual" })).status,
      ).toBe(401);
      const r = await fetch(
        `${BASE}/webmcp?token=${encodeURIComponent(bearer)}`,
        { redirect: "manual" },
      );
      expect(r.status).toBe(303);
      const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect(cookie.startsWith("relay=")).toBe(true);
      const page = await fetch(`${BASE}/webmcp`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect((await page.text()).length).toBeGreaterThan(200);
    });

    test("/ws round trip", async () => {
      const ws = new WebSocket(`${WS_BASE}/ws`, { headers: auth } as any);
      const out = await new Promise<any>((res, rej) => {
        const t = setTimeout(() => rej(new Error("ws timeout")), 15_000);
        ws.onopen = () =>
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: 7, method: "llm_models" }),
          );
        ws.onmessage = (e) => (
          clearTimeout(t),
          res(JSON.parse(String(e.data)))
        );
        ws.onerror = () => (clearTimeout(t), rej(new Error("ws error")));
      });
      ws.close();
      expect(out.id).toBe(7);
      expect(Array.isArray(out.result)).toBe(true);
    });

    test("TCP NDJSON: token line then request", async () => {
      const port = Number(Bun.env.RELAY_TCP_PORT ?? 8791);
      let buf = "";
      const lines: string[] = [];
      let wake: (() => void) | undefined;
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data(_s, d) {
            buf += Buffer.from(d).toString();
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0)
              (lines.push(buf.slice(0, i)), (buf = buf.slice(i + 1)), wake?.());
          },
        },
      });
      const next = async () => {
        const end = Date.now() + 15_000;
        while (!lines.length && Date.now() < end)
          await new Promise<void>((r) => ((wake = r), setTimeout(r, 200)));
        return JSON.parse(lines.shift() ?? "null");
      };
      sock.write(`${bearer}\n`);
      expect((await next()).ok).toBe(true);
      sock.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "llm_models" })}\n`,
      );
      expect((await next()).id).toBe(3);
      sock.end();
    });
  });

  // ------------------------------------------------------------ 2. hub MCP servers
  describe("hub MCP servers", () => {
    const toml = Bun.TOML.parse(
      readFileSync(join(SRC, "tools/agents/toolchain.toml"), "utf8"),
    ) as any;
    const servers: string[] = (toml.hub?.mcp ?? []).map((s: any) => s.name);
    const cheap: Record<string, [string, unknown]> = {
      context7: [
        "context7__resolve-library-id",
        { libraryName: "bun", query: "test runner" },
      ],
      rea: ["rea__binary_session", {}],
      "agent-desktop": ["agent-desktop__desktop_version", {}],
      "agent-browser": ["agent-browser__agent_browser_tools_profiles", {}],
      gnu: ["gnu__gnu_status", {}],
    };
    test("toolchain.toml declares the expected hub servers", () => {
      for (const s of ["context7", "rea", "agent-desktop", "agent-browser"])
        expect(servers).toContain(s);
    });
    for (const s of servers) {
      test(`hub_tools lists ${s}`, async () => {
        const all = await tool("hub_tools");
        expect(all.data[s], `${s} missing from hub_tools`).toBeGreaterThan(0);
        const names = await tool("hub_tools", { server: s });
        expect(Array.isArray(names.data) && names.data.length > 0).toBe(true);
        expect(names.data.every((t: any) => t.name.startsWith(`${s}__`))).toBe(
          true,
        );
      }, 60_000);
      const c = cheap[s];
      if (c)
        test(`hub_call ${c[0]}`, async () => {
          const exists = await tool("hub_tools", { name: c[0] });
          expect(exists.error, `${c[0]} not listed`).toBeUndefined();
          // Twice: the second read-only call may be replayed by the outbound cache (stale JSON-RPC id regression).
          await tool("hub_call", { name: c[0], arguments: c[1] });
          const r = await tool("hub_call", { name: c[0], arguments: c[1] });
          expect(r.error).toBeUndefined();
          // Anonymous Context7 quota: the server answered, the key (CTX7_API_KEY) is what is missing.
          if (
            s === "context7" &&
            !Bun.env.CTX7_API_KEY &&
            /quota exceeded/i.test(r.text)
          )
            return;
          expect(r.isError, r.text.slice(0, 300)).toBe(false);
          if (s === "context7") expect(r.text).toContain("/oven-sh/bun");
          else expect(r.text.length).toBeGreaterThan(2);
        }, 120_000);
    }
  });

  // ------------------------------------------------------------ 3. skills
  describe("skills", () => {
    const roots = skillDirs();
    for (const root of roots) {
      test(`frontmatter of ${root.slice(SRC.length + 1).replaceAll("\\", "/")}`, () => {
        const files = skillFiles(root);
        expect(files.length).toBeGreaterThan(0);
        const seen = new Map<string, string>();
        const problems: string[] = [];
        for (const f of files) {
          const { fm, err } = frontmatter(f);
          const rel = basename(join(f, ".."));
          if (!fm) {
            problems.push(`${rel}: ${err}`);
            continue;
          }
          if (typeof fm.name !== "string" || !fm.name.trim())
            problems.push(`${rel}: name missing`);
          else if (seen.has(fm.name))
            problems.push(
              `${rel}: duplicate name ${fm.name} (${seen.get(fm.name)})`,
            );
          else seen.set(fm.name, rel);
          if (typeof fm.description !== "string" || !fm.description.trim())
            problems.push(`${rel}: description missing`);
          else if (fm.description.length >= 1024)
            problems.push(`${rel}: description ${fm.description.length} chars`);
        }
        expect(problems).toEqual([]);
      });
    }
    test("relay skills_list returns .agents/skills and skills_view reads one", async () => {
      const names = skillFiles(join(SRC, ".agents/skills")).map((f) =>
        String(frontmatter(f).fm?.name),
      );
      const l = await tool("skills_list");
      const listed = new Set(
        l.text.split("\n").map((x) => x.split(":")[0]!.trim()),
      );
      const missing = names.filter((n) => !listed.has(n));
      expect(missing).toEqual([]);
      const v = await tool("skills_view", { name: "bun" });
      expect(v.isError).toBe(false);
      expect(v.text).toContain("bun");
      const none = await tool("skills_view", { name: "zz-no-such-skill" });
      expect(none.isError).toBe(true);
    });
  });

  // ------------------------------------------------------------ 4. custom subagents
  describe("custom subagents", () => {
    const dir = join(SRC, ".claude/agents");
    const known = new Set(
      skillDirs()
        .flatMap(skillFiles)
        .map((f) => String(frontmatter(f).fm?.name)),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    test("agents exist", () => expect(files.length).toBeGreaterThan(0));
    for (const f of files)
      test(`${f}`, () => {
        const { fm, err } = frontmatter(join(dir, f));
        expect(fm, err).not.toBeNull();
        expect(typeof fm!.name).toBe("string");
        expect(basename(f, ".md")).toBe(fm!.name);
        expect(
          typeof fm!.description === "string" && fm!.description.length > 0,
        ).toBe(true);
        if (fm!.model !== undefined)
          expect(["sonnet", "opus", "haiku", "fable", "inherit"]).toContain(
            fm!.model,
          );
        const sk = fm!.skills ?? [];
        expect(Array.isArray(sk)).toBe(true);
        expect((sk as string[]).filter((s) => !known.has(s))).toEqual([]);
      });
  });

  // ------------------------------------------------------------ 6. hook guard (before CLIs: pure, fast)
  describe("Claude PreToolUse guard", () => {
    const settings = JSON.parse(
      readFileSync(join(SRC, "tools/agents/claude/settings.json"), "utf8"),
    );
    const entry = settings.hooks.PreToolUse.find(
      (h: any) => h.matcher === "Bash",
    );
    const command: string = entry.hooks[0].command;
    const bash = Bun.which("bash");
    const run = async (c: string) => {
      const p = Bun.spawn([bash!, "-c", command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      p.stdin.write(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: c, description: "e2e" },
        }),
      );
      p.stdin.end();
      const out = await new Response(p.stdout).text();
      await p.exited;
      if (!out.trim()) return { deny: false, reason: "" };
      const j = JSON.parse(out).hookSpecificOutput;
      return {
        deny: j.permissionDecision === "deny",
        reason: String(j.permissionDecisionReason),
      };
    };
    test.skipIf(!bash)("bash is available", () => expect(bash).toBeTruthy());
    // Only the .env vault is guarded (owner decision 2026-11-15); everything else is allowed.
    const denied = [
      "git add .env",
      "git add -f .env",
      "git commit -m x -- .env",
    ];
    const allowed = [
      "cat x",
      "cd /tmp",
      "git stash",
      "git add -A",
      "git commit -m x",
      "git add .env.example",
      "rg x",
    ];
    for (const c of denied)
      test.skipIf(!bash)(`denies: ${c}`, async () => {
        const r = await run(c);
        expect(r.deny, `expected deny for: ${c}`).toBe(true);
        expect(r.reason.length).toBeGreaterThan(0);
      });
    for (const c of allowed)
      test.skipIf(!bash)(`allows: ${c}`, async () => {
        const r = await run(c);
        expect(r.deny, `unexpected deny for: ${c} (${r.reason})`).toBe(false);
      });
  });
});

// ------------------------------------------------------------ 5. CLIs (no relay needed, but kept in the gated suite below)
describe.skipIf(!alive)("CLIs declared in tools.toml", () => {
  const toml = Bun.TOML.parse(
    readFileSync(join(SRC, "prebuilts/up/tools.toml"), "utf8"),
  ) as any;
  const tools: any[] = (toml.tool ?? []).filter(
    (t: any) => Array.isArray(t.bin) && t.bin.length,
  );
  const PATH = [Bun.env.PATH ?? "", join(homedir(), ".local", "bin")].join(
    delimiter,
  );
  const exe = (n: string) => Bun.which(n.replace(/\.exe$/i, ""), { PATH });
  test("every declared CLI resolves and answers its version flag", async () => {
    const missing: string[] = [];
    const broken: string[] = [];
    await Promise.all(
      tools.map(async (t) => {
        const verify: string[] = t.verify ?? [basename(t.bin[0]), "--version"];
        const path = exe(verify[0]!) ?? exe(basename(t.bin[0]));
        if (!path) return void missing.push(t.name);
        const p = Bun.spawn([path, ...verify.slice(1)], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...Bun.env, PATH },
        });
        const timer = setTimeout(() => p.kill(), 25_000);
        const [o, e, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        clearTimeout(timer);
        if (code !== 0 || !(o + e).trim())
          broken.push(`${t.name} (exit ${code})`);
      }),
    );
    console.log(
      `tools.toml: ${tools.length} tools, missing on PATH/~/.local/bin: ${missing.sort().join(", ") || "none"}`,
    );
    expect(broken.sort()).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------- model router (src/router)
describe.skipIf(!alive)("router e2e", () => {
  const chat = (
    body: unknown,
    headers: Record<string, string> = {},
    ms = 120_000,
  ) =>
    fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
  const ping = {
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
    max_tokens: 1024,
  };

  test("GET /v1/models lists more than 100 offers and the virtual models", async () => {
    const r = await fetch(`${BASE}/v1/models`, { headers: auth });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.data.length).toBeGreaterThan(100);
    const ids = j.data.map((m: any) => m.id);
    for (const v of [
      "auto",
      "auto:cheap",
      "auto:fast",
      "auto:code",
      "auto:long",
      "arena",
    ])
      expect(ids).toContain(v);
  }, 120_000);
  test("/v1/* needs the relay token", async () => {
    expect((await fetch(`${BASE}/v1/models`)).status).toBe(401);
  }, 120_000);
  test("auto:cheap streams pong", async () => {
    const r = await chat({ model: "auto:cheap", stream: true, ...ping });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const t = await r.text();
    const text = t
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(5)).choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(text).toMatch(/pong/i);
    expect(t).toContain("[DONE]");
  }, 120_000);
  test("a forced failure on the first offer falls over to the second", async () => {
    const r = await chat(
      { model: "auto:cheap", ...ping },
      { "x-router-fail": "1" },
    );
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.router.attempts[0].status).toBe(503);
    expect(j.router.attempts.length).toBeGreaterThanOrEqual(2);
    expect(j.router.attempts.at(-1).status).toBe(200);
    expect(j.choices[0].message.content).toMatch(/pong/i);
  }, 120_000);
  test("POST /v1/messages answers in Anthropic format (x-api-key accepted)", async () => {
    const key = String(auth.Authorization ?? "").replace(/^Bearer /, "");
    const r = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "auto:cheap",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Reply with the single word: pong" },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.type).toBe("message");
    expect(j.content[0].type).toBe("text");
    expect(j.content[0].text).toMatch(/pong/i);
  }, 120_000);
  test("router_route explains the order; router_stats and router_leaderboard answer", async () => {
    const route = await tool("router_route", { model: "auto:cheap", limit: 3 });
    expect(route.data.policy).toEqual({ kind: "auto", mode: "cheap" });
    expect(route.data.order.length).toBe(3);
    expect((await tool("router_stats")).data.offers.length).toBeGreaterThan(0);
    expect(
      (await tool("router_leaderboard")).data.arena.length,
    ).toBeGreaterThan(0);
    expect(
      (await tool("router_models", { limit: 5 })).data.total,
    ).toBeGreaterThan(100);
  }, 120_000);
});
