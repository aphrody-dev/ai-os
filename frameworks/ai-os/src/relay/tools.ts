// Relay tools, shared by all surfaces (JSON-RPC HTTP/WebSocket/TCP/TLS, MCP, A2A, ACP).
import { llmAsk } from "../llm/model.ts";
import { listModels } from "../llm/models.ts";
import { s } from "../llm/schema.ts";
import { AGENT_TOOLS } from "./agent-tools.ts";
import { hubCall, hubTools } from "./mcp-hub.ts";
import { CORE_TOOLS } from "./core-tools.ts";
import { ORCH_TOOLS } from "./orch-tools.ts";
import { ROUTER_TOOLS } from "../router/tools.ts";
import { TERM_TOOLS } from "../term/mcp-tools.ts";
import { SESSION_TOOLS } from "./session-tools.ts";
// frameworks/ai-os/src/google may be absent from a checkout (module not yet on main): the relay then
// starts without these tools instead of crashing (prd rollback 2026-11-13, src-checkout-update).
const GOOGLE_TOOLS: Tool[] = await import("../google/tools.ts").then(
  (m: { GOOGLE_TOOLS: Tool[] }) => m.GOOGLE_TOOLS,
  () => [],
);
import { accountsSync } from "./accounts.ts";
import { outbound } from "./outbound.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  claude,
  claudeWithTools,
  gemini,
  agy,
  notebookAsk,
} from "./backends.ts";

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run: (a: any) => Promise<unknown>;
};

const str = s.string;
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

// User ssh config (RELAY_SSH_CONFIG when the relay runs as a service, otherwise ~/.ssh/config).
const sshConfig = () =>
  Bun.env.RELAY_SSH_CONFIG ?? join(homedir(), ".ssh", "config");

/** ssh aliases of the user config (Host without wildcard). */
export function sshHosts(): string[] {
  const f = sshConfig();
  if (!existsSync(f)) return [];
  const t = readFileSync(f, "utf8");
  return [
    ...new Set(
      [...t.matchAll(/^\s*Host\s+(.+)$/gim)]
        .flatMap((m) => m[1]!.split(/\s+/))
        .filter((h) => h && !/[*?!]/.test(h)),
    ),
  ].sort();
}

const ssh = async (host: string, cmd: string, timeout = 15000) => {
  if (!sshHosts().includes(host))
    throw new Error(
      `unknown ssh host: ${host} (config ${sshConfig()}, ${sshHosts().length} aliases)`,
    );
  const p = Bun.spawn(
    [
      "ssh",
      "-F",
      sshConfig(),
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=6",
      host,
      cmd,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const kill = setTimeout(() => p.kill(), timeout);
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(kill);
  return { host, code, out: out.trim(), err: err.trim().slice(0, 500) };
};

// Network services tracked on the fleet (tunnels, VPN, proxies): read-only.
const NET_UNITS =
  "cloudflared* wg-quick@* tailscaled* caddy* nginx* haproxy* frpc* frps* openvpn* headscale* sshd*";

const skillDirs = () => [
  join(homedir(), ".claude", "skills"),
  join(homedir(), ".gemini", "config", "plugins", "aphrody-skills", "skills"),
  ...(Bun.env.SRC_ROOT ? [join(Bun.env.SRC_ROOT, ".agents", "skills")] : []),
];

export const TOOLS: Tool[] = [
  {
    name: "gemini_ask",
    description:
      "Ask Gemini (gemini.google.com in the relay browser, or Gemini CLI). Returns the answer and the chat URL.",
    inputSchema: obj(
      {
        prompt: str("Prompt"),
        chat: str("Existing chat id or URL (optional)"),
        engine: { type: "string", enum: ["agy", "web"] },
      },
      ["prompt"],
    ),
    readOnly: false,
    run: (a) => gemini(String(a.prompt), { chat: a.chat, engine: a.engine }),
  },
  {
    name: "gemini_review",
    description:
      "Submit a deliverable (file content or diff) to Gemini for a scored review (/20) with concrete defects.",
    inputSchema: obj(
      {
        title: str("What is reviewed"),
        content: str("File content or unified diff"),
        chat: str("Review chat id (optional)"),
      },
      ["title", "content"],
    ),
    readOnly: false,
    run: (a) =>
      gemini(
        `Strict technical review of "${a.title}". Give a score /20, then the list of verifiable defects (file, line, fix). No compliments.\n\n${String(a.content).slice(0, 120_000)}`,
        { chat: a.chat },
      ),
  },
  {
    name: "review",
    description:
      "Three-voice review tribunal of src (ai-os review, docs/reviews/README.md): Gemini and Claude voices in parallel, then a neutral judge; engines from the model registry with fallback, grounded on official Google sources and the checklists of docs/reviews. Writes docs/reviews/<voice>-<date>-<slug>.md and the INDEX.md row. Target = paths, 'diff', A..B or a commit; or content + title (orchestrator step).",
    inputSchema: obj({
      targets: {
        type: "array",
        items: { type: "string" },
        description: "Paths, 'diff', A..B, commit; '--' then path filters",
      },
      content: str("Content or unified diff to review (instead of targets)"),
      title: str("What is reviewed"),
      slug: str("Verdict file slug (optional)"),
      voices: { type: "array", items: { type: "string" } },
      threshold: { type: "number" },
      fix: { type: "boolean", description: "Auto-fix loop (default false)" },
    }),
    readOnly: false,
    run: async (a) => {
      const { review } = await import("../review/index.ts");
      const th = a.threshold;
      if (th !== undefined && !(Number.isFinite(th) && th > 0 && th <= 20))
        throw new Error("threshold: number in ]0, 20]");
      if (
        a.voices !== undefined &&
        (!Array.isArray(a.voices) ||
          a.voices.some((v: unknown) => typeof v !== "string"))
      )
        throw new Error("voices : liste de noms de voix");
      const r = await review({
        spec: a.content ? undefined : (a.targets as string[] | undefined),
        content: a.content
          ? { title: String(a.title ?? "contenu"), text: String(a.content) }
          : undefined,
        title: a.title,
        slug: a.slug,
        voices: a.voices,
        threshold: a.threshold,
        fix: a.fix === true,
      });
      // Judge verdict last: the orchestrator keeps the end of a step's output.
      const { verdict, ...rest } = r;
      return { ...rest, verdict };
    },
  },
  {
    name: "claude_ask",
    description:
      "Ask Claude Code headless (claude -p, plan mode: no edits), using the CLI's existing authentication.",
    inputSchema: obj(
      { prompt: str("Prompt"), model: str("Model alias (optional)") },
      ["prompt"],
    ),
    readOnly: false,
    run: (a) => claude(String(a.prompt), a.model),
  },
  {
    name: "workspace_ask",
    description:
      "Google Workspace through Claude Code's claude.ai connectors (Gmail, Calendar, Drive, Docs, Slides, Sheets): read, write plans and design documents. Only those connector tools are allowed.",
    inputSchema: obj(
      {
        prompt: str("Task for Gmail/Calendar/Drive/Docs/Slides/Sheets"),
        apps: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "Gmail",
              "Google_Calendar",
              "Google_Drive",
              "Google_Docs",
              "Google_Slides",
              "Google_Sheets",
            ],
          },
        },
      },
      ["prompt"],
    ),
    readOnly: false,
    run: (a) =>
      claudeWithTools(
        String(a.prompt),
        (
          (a.apps as string[] | undefined) ?? [
            "Gmail",
            "Google_Calendar",
            "Google_Drive",
            "Google_Docs",
            "Google_Slides",
            "Google_Sheets",
          ]
        ).map((x) => `mcp__claude_ai_${x}`),
      ),
  },
  {
    name: "llm_models",
    description:
      "Models of every active provider, discovered live (Ollama, OpenAI-compatible local servers such as llama.cpp/vLLM/mistral.rs/LiteLLM, OpenRouter, Hugging Face, Vercel AI Gateway, Cloudflare Workers AI, Antigravity, Claude). Nothing hardcoded.",
    inputSchema: obj({ filter: str("Regex on provider/model id (optional)") }),
    readOnly: true,
    run: (a) => listModels(a.filter),
  },
  {
    name: "llm_ask",
    description:
      "Ask any discovered model, addressed as provider/model (see llm_models).",
    inputSchema: obj(
      {
        model: str("provider/model from llm_models"),
        prompt: str("Prompt"),
        system: str("System prompt (optional)"),
        temperature: {
          type: "number",
          description:
            "Sampling temperature (optional); 0 makes the answer cacheable by the relay",
        },
        seed: {
          type: "integer",
          description: "Fixed seed (optional); also makes the answer cacheable",
        },
      },
      ["model", "prompt"],
    ),
    readOnly: false,
    run: (a) =>
      llmAsk(String(a.model), String(a.prompt), a.system, {
        temperature: a.temperature,
        seed: a.seed,
      }),
  },
  {
    name: "relay_cache_stats",
    description:
      "Outbound dedup of the relay: singleflight and response cache counters (hit, miss, coalesced, bypass, stored, Idempotency-Key, mesh routing).",
    inputSchema: obj({}),
    readOnly: true,
    run: async () => outbound().stats(),
  },
  {
    name: "accounts_sync",
    description:
      "Owner sync of the owner's accounts (contact@aphrody.com plus APHRODY_OWNER_GOOGLE_ACCOUNT / APHRODY_AI_GOOGLE_ACCOUNT from the env) on GitHub orgs, gcloud projects and Cloudflare accounts. apply=false (default) only reports the gap.",
    inputSchema: obj({ apply: { type: "boolean" } }),
    readOnly: false,
    run: (a) => accountsSync(Boolean(a.apply)),
  },
  {
    name: "notebook_ask",
    description:
      "Ask a NotebookLM (Gemini Notebook) notebook grounded on its sources, in the relay browser.",
    inputSchema: obj(
      { notebook: str("Notebook id or URL"), prompt: str("Question") },
      ["notebook", "prompt"],
    ),
    readOnly: false,
    run: (a) => notebookAsk(String(a.notebook), String(a.prompt)),
  },
  {
    name: "workspace_api",
    description:
      "Direct Google Workspace API call through gws (googleworkspace/cli, Discovery-based): drive, sheets, docs, slides, gmail, calendar… e.g. service=calendar, path=['events','list'], params={calendarId:'primary'}. Auth: gws auth login, or GOOGLE_WORKSPACE_CLI_TOKEN.",
    inputSchema: obj(
      {
        service: str("drive | sheets | docs | slides | gmail | calendar | …"),
        path: {
          type: "array",
          items: { type: "string" },
          description: "resource [sub-resource] method",
        },
        params: { type: "object", description: "URL/query parameters" },
        body: { type: "object", description: "Request body (POST/PATCH/PUT)" },
      },
      ["service", "path"],
    ),
    readOnly: false,
    run: async (a) => {
      const argv = [
        "gws",
        String(a.service),
        ...(a.path as string[]).map(String),
        ...(a.params ? ["--params", JSON.stringify(a.params)] : []),
        ...(a.body ? ["--json", JSON.stringify(a.body)] : []),
      ];
      if (
        !/^[a-z0-9]+$/.test(String(a.service)) ||
        (a.path as string[]).some((p) => !/^[A-Za-z0-9_.]+$/.test(p))
      )
        throw new Error("service/path invalides");
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (code !== 0) throw new Error(`gws : ${(err || out).slice(0, 400)}`);
      try {
        return JSON.parse(out);
      } catch {
        return out;
      }
    },
  },
  {
    name: "figma_ask",
    description:
      "Figma through Claude Code's Figma remote MCP (https://mcp.figma.com/mcp, OAuth done once in /mcp): design context, variables, Code Connect, canvas writes. Only Figma tools are allowed.",
    inputSchema: obj(
      { prompt: str("Task on a Figma file or frame (include its URL)") },
      ["prompt"],
    ),
    readOnly: false,
    run: (a) => claudeWithTools(String(a.prompt), ["mcp__figma"]),
  },
  {
    name: "agy_ask",
    description:
      "Ask Antigravity (agy CLI, Gemini 4 models) headless in plan mode; optional model and conversation id to continue.",
    inputSchema: obj(
      {
        prompt: str("Prompt"),
        model: str("e.g. gemini-4-carbon-high (optional)"),
        conversation: str("Conversation id to continue (optional)"),
      },
      ["prompt"],
    ),
    readOnly: false,
    run: (a) => agy(String(a.prompt), a.model, a.conversation),
  },
  {
    name: "fleet_status",
    description:
      "Read-only health of the VPS fleet (ssh aliases from ~/.ssh/config): uptime, failed units, tunnel/VPN/proxy units.",
    inputSchema: obj({ host: str("ssh alias (optional, all if omitted)") }),
    readOnly: true,
    run: async (a) =>
      Promise.all(
        (a.host ? [String(a.host)] : sshHosts()).map((h) =>
          ssh(
            h,
            `uptime; systemctl --failed --no-legend --plain | head -20; systemctl list-units --no-legend --plain --type=service ${NET_UNITS} | head -40`,
          ),
        ),
      ),
  },
  {
    name: "claude_inventory",
    description:
      "Read-only inventory of Claude Code: MCP servers (claude mcp list) and skills (SKILL.md names).",
    inputSchema: obj({}),
    readOnly: true,
    run: async () => {
      const p = Bun.spawn(["claude", "mcp", "list"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const mcp = (await new Response(p.stdout).text()).trim();
      await p.exited;
      const skills = skillDirs().flatMap((d) =>
        existsSync(d)
          ? readdirSync(d)
              .filter((s) => existsSync(join(d, s, "SKILL.md")))
              .map((s) => `${d}:${s}`)
          : [],
      );
      return { mcp, skills };
    },
  },
  {
    name: "gcloud_accounts",
    description:
      "Read-only list of gcloud configurations and credentialed accounts.",
    inputSchema: obj({}),
    readOnly: true,
    run: async () => {
      const run = async (argv: string[]) => {
        const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
        const t = await new Response(p.stdout).text();
        await p.exited;
        return JSON.parse(t || "[]");
      };
      return {
        configurations: (
          await run([
            "gcloud",
            "config",
            "configurations",
            "list",
            "--format=json",
          ])
        ).map((c: any) => ({
          name: c.name,
          active: c.is_active,
          account: c.properties?.core?.account,
          project: c.properties?.core?.project,
        })),
        accounts: (await run(["gcloud", "auth", "list", "--format=json"])).map(
          (a: any) => ({ account: a.account, active: a.status === "ACTIVE" }),
        ),
      };
    },
  },
  {
    name: "billing_status",
    description:
      "Read-only Google Cloud billing status via billing-agent (keyless impersonation): billing accounts, linked projects, budgets and spend caps, last notified spend.",
    inputSchema: obj({}),
    readOnly: true,
    run: async () => {
      const cli = join(
        Bun.env.SRC_ROOT ?? resolve(import.meta.dir, "..", "..", "..", ".."),
        "system",
        "env-kit",
        "src",
        "cli.ts",
      );
      const p = Bun.spawn(
        [process.execPath, "run", cli, "billing", "status", "--json"],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err] = [
        await new Response(p.stdout).text(),
        await new Response(p.stderr).text(),
      ];
      if ((await p.exited) !== 0)
        return { error: err.trim().split("\n").pop() };
      return JSON.parse(out);
    },
  },
];

TOOLS.push(
  {
    name: "hub_tools",
    description:
      "List tools of the MCP servers aggregated by the relay (rea, vercel, cloudflare, agent-desktop, ...) without loading them into context. No argument: servers and tool counts. server and/or query: matching tool names with a one-line description. name (exact <server>__<tool>): full description and input schema. Call a tool with hub_call.",
    inputSchema: obj({
      server: str("server name (optional)"),
      query: str(
        "case-insensitive text matched on name and description (optional)",
      ),
      name: str("exact <server>__<tool> for the full schema (optional)"),
    }),
    readOnly: true,
    run: async (a) => {
      const all = await hubTools();
      if (a.name) {
        const t = all.find((x) => x.name === String(a.name));
        if (!t) throw new Error(`unknown tool: ${a.name}`);
        return t;
      }
      if (!a.server && !a.query) {
        const n: Record<string, number> = {};
        for (const t of all) n[t.server] = (n[t.server] ?? 0) + 1;
        return n;
      }
      const terms = a.query
        ? String(a.query)
            .toLowerCase()
            .split(/[\s_]+/)
            .filter(Boolean)
        : [];
      return all
        .filter(
          (t) =>
            (!a.server || t.server === String(a.server)) &&
            terms.every((w) =>
              `${t.name} ${t.description ?? ""}`.toLowerCase().includes(w),
            ),
        )
        .slice(0, 80)
        .map((t) => ({
          name: t.name,
          description: (t.description ?? "").split("\n")[0]!.slice(0, 160),
        }));
    },
  },
  {
    name: "hub_call",
    description:
      "Call one tool of an MCP server aggregated by the relay: name = <server>__<tool> from hub_tools, arguments = its input object.",
    inputSchema: obj(
      {
        name: str("<server>__<tool>"),
        arguments: {
          type: "object",
          description: "tool input",
          additionalProperties: true,
        },
      },
      ["name"],
    ),
    readOnly: false,
    run: (a) => hubCall(String(a.name), a.arguments ?? {}),
  },
  ...SESSION_TOOLS,
  ...AGENT_TOOLS,
  ...CORE_TOOLS,
  ...ORCH_TOOLS,
  ...ROUTER_TOOLS,
  ...TERM_TOOLS,
  ...GOOGLE_TOOLS,
);

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
