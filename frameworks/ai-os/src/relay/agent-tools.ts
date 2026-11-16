// Agent core tools served by the relay, the single MCP server and A2A surface of @aphrody/ai-os (it replaces the
// former stdio server of packages/mcp): long-term memory, skills, council of agent CLIs, and a full agent run on a
// model discovered at run time. Home: AGENT_HOME, default ~/.agent (same store as the agent CLI).
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  lookupBaselineStatus,
  mwgCapabilities,
  retrieveUseCase,
  scanLegacyPatterns,
  searchUseCases,
  validateWeb,
} from "@aphrody/wck";
import { run } from "../core/agent";
import { CLI, council } from "../core/council";
import { layout } from "../core/home";
import { Memory } from "../core/memory";
import { Skills } from "../core/skills";
import { resolveExe } from "../llm/agents";
import { resolveModel } from "../llm/model";
import { s } from "../llm/schema";
import type { Tool } from "./tools.ts";

const home = () => Bun.env.AGENT_HOME ?? join(homedir(), ".agent");
const skillStores = () => {
  const dirs = [layout(home()).skills];
  const srcSkills = join(
    Bun.env.SRC_ROOT ?? resolve(import.meta.dir, "..", "..", "..", ".."),
    ".agents",
    "skills",
  );
  if (existsSync(srcSkills) && !dirs.includes(srcSkills)) dirs.push(srcSkills);
  return dirs.map((d) => new Skills(d));
};
const str = s.string;
const withMemory = async <T>(f: (m: Memory) => Promise<T>) => {
  const m = Memory.acquire(layout(home()).memoryDb);
  try {
    return await f(m);
  } finally {
    Memory.release(m);
  }
};
const MEMBERS = Object.keys(CLI);
const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};
/** Remote callers may only pick a workspace inside AGENT_HOME, symlinks resolved on disk. */
export const workspace = (cwd?: string) => {
  mkdirSync(home(), { recursive: true });
  const root = realpathSync(home());
  const abs = resolve(root, cwd ?? ".");
  if (!inside(root, abs)) throw new Error(`cwd hors de AGENT_HOME : ${cwd}`);
  // Every existing prefix must resolve inside the root before anything is created below it.
  let cur = root;
  for (const part of relative(root, abs).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // the rest does not exist yet
    }
    if (st.isSymbolicLink() || !inside(root, realpathSync(cur)))
      throw new Error(`symbolic link forbidden in cwd: ${cwd}`);
  }
  mkdirSync(abs, { recursive: true });
  const real = realpathSync(abs);
  if (!inside(root, real)) throw new Error(`cwd hors de AGENT_HOME : ${cwd}`);
  return real;
};

export const AGENT_TOOLS: Tool[] = [
  {
    name: "memory_search",
    description: "Full-text search of the agent long-term memory.",
    inputSchema: s.object({ query: str("Query") }),
    readOnly: true,
    run: (a) =>
      withMemory(async (m) => (await m.search(String(a.query))).join("\n")),
  },
  {
    name: "memory_add",
    description: "Persist a fact to the agent long-term memory.",
    inputSchema: s.object(
      { content: str("Fact"), scope: str("Scope (optional)") },
      ["scope"],
    ),
    readOnly: false,
    run: (a) =>
      withMemory(
        async (m) => `memory #${await m.add(String(a.content), a.scope)}`,
      ),
  },
  {
    name: "skills_list",
    description:
      "List the agent skills (SKILL.md) across AGENT_HOME and monorepo .agents/skills.",
    inputSchema: s.object({}),
    readOnly: true,
    run: async () => {
      const seen = new Map<string, string>();
      for (const store of skillStores())
        for (const sk of await store.list())
          if (!seen.has(sk.name)) seen.set(sk.name, sk.description);
      return [...seen.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([n, d]) => `${n}: ${d}`)
        .join("\n");
    },
  },
  {
    name: "skills_view",
    description:
      "Read a skill (SKILL.md) by name across AGENT_HOME and monorepo .agents/skills.",
    inputSchema: s.object({ name: str("Skill name") }),
    readOnly: true,
    run: async (a) => {
      const name = String(a.name);
      for (const store of skillStores()) {
        const sk = await store.view(name);
        if (sk) return sk.body;
      }
      throw new Error(`skill not found: ${name}`);
    },
  },
  {
    name: "council",
    description: `Ask several agent CLIs (${MEMBERS.join(", ")}) in parallel and return a consensus report.`,
    inputSchema: s.object(
      {
        prompt: str("Prompt"),
        members: s.array(s.enum(MEMBERS), {
          description: "Members (default: all found on PATH)",
        }),
      },
      ["members"],
    ),
    readOnly: false,
    run: async (a) => {
      const ids: string[] =
        Array.isArray(a.members) && a.members.length
          ? a.members
          : MEMBERS.filter((id) => Bun.which(id));
      const members = ids.filter((id) => Object.hasOwn(CLI, id));
      if (!members.length) throw new Error("no agent CLI available");
      const r = await council(
        members.map((id) => ({ id, kind: "cli" as const, argv: CLI[id]! })),
        String(a.prompt),
      );
      return r.summary;
    },
  },
  {
    name: "agent_run",
    description:
      "Run one agent task (tool loop over memory, skills and workspace files) on a model discovered at run time (provider/model from llm_models; default AGENT_MODEL or the first discovered model).",
    inputSchema: s.object(
      {
        task: str("Task"),
        model: str("provider/model (optional)"),
        cwd: str("Workspace directory inside AGENT_HOME (optional)"),
      },
      ["model", "cwd"],
    ),
    readOnly: false,
    run: async (a) => {
      const r = await run({
        task: String(a.task),
        model: await resolveModel(a.model),
        home: home(),
        cwd: workspace(a.cwd),
      });
      return { text: r.text, steps: r.steps, toolCalls: r.toolCalls };
    },
  },
  {
    name: "desktop_use",
    description:
      "Run an agent-desktop (UIA native automation) command via ~/.local/bin/agent-desktop.exe.",
    inputSchema: s.object({
      args: s.array(s.string(), {
        description: "CLI arguments for agent-desktop",
      }),
    }),
    readOnly: false,
    run: async (a) => {
      const exe = resolveExe("agent-desktop");
      const p = Bun.spawn([exe, ...(a.args as string[]).map(String)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (code !== 0)
        throw new Error(`agent-desktop exit ${code}: ${err.slice(0, 400)}`);
      return out.trim();
    },
  },
  {
    name: "browser_use",
    description:
      "Run an agent-browser (headless Chromium CDP) command via ~/.local/bin/agent-browser.exe.",
    inputSchema: s.object({
      args: s.array(s.string(), {
        description: "CLI arguments for agent-browser",
      }),
    }),
    readOnly: false,
    run: async (a) => {
      const exe = resolveExe("agent-browser");
      const p = Bun.spawn([exe, ...(a.args as string[]).map(String)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (code !== 0)
        throw new Error(`agent-browser exit ${code}: ${err.slice(0, 400)}`);
      return out.trim();
    },
  },
  {
    name: "mwg_audit",
    description:
      "Audit a web directory or HTML file with @aphrody/wck (SEO, AISEO, MWG, CWV, Lighthouse, WASM, WebGPU) and legacy-scan.",
    inputSchema: s.object(
      {
        path: str("Target file or directory path (default '.')"),
        mode: s.enum(["validate", "legacy-scan"]),
        spec: str(
          "Optional spec filter (seo, aiseo, mwg, cwv, lh, wasm, webgpu)",
        ),
      },
      ["path", "mode", "spec"],
    ),
    readOnly: true,
    run: async (a) => {
      const target = resolve(
        Bun.env.SRC_ROOT ?? resolve(import.meta.dir, "..", "..", "..", ".."),
        String(a.path ?? "."),
      );
      if (a.mode === "legacy-scan") {
        return JSON.stringify(scanLegacyPatterns(target), null, 2);
      }
      const specFilter = (a.spec ? String(a.spec) : "all") as
        "all" | "seo" | "aiseo" | "mwg" | "cwv" | "lh" | "wasm" | "webgpu";
      return JSON.stringify(
        {
          native: mwgCapabilities(),
          report: validateWeb(target, { specFilter, json: true }),
        },
        null,
        2,
      );
    },
  },
  {
    name: "web_guidance",
    description:
      "Search or retrieve Modern Web Guidance (MWG) via hybrid RAG (BM25 + Int8 256d + RRF) or check Baseline status.",
    inputSchema: s.object(
      {
        action: s.enum(["search", "retrieve", "baseline"]),
        query: str("Search query, guide ID, or web-feature ID"),
      },
      [],
    ),
    readOnly: true,
    run: async (a) => {
      const q = String(a.query ?? "");
      if (a.action === "search") {
        return JSON.stringify(await searchUseCases(q), null, 2);
      }
      if (a.action === "retrieve") {
        return await retrieveUseCase(q);
      }
      return JSON.stringify(lookupBaselineStatus(q), null, 2);
    },
  },
];
