// Relay tools for the Jules agent (absorbed client src/google/jules). Stitch has no tool here: its official tools
// are relayed as is by the MCP hub (stitch__<tool>, src/relay/mcp-hub.ts).
import type { Tool } from "../relay/tools.ts";
import { DEFAULT_REPO, julesClient } from "./cli.ts";

const str = (description: string) => ({ type: "string", description });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

export const GOOGLE_TOOLS: Tool[] = [
  {
    name: "jules_run",
    description: `Start a Jules cloud coding session on a GitHub repo (default ${DEFAULT_REPO}, branch main); Jules opens a PR unless autoPr=false. Returns the session id; poll with jules_status.`,
    inputSchema: obj(
      {
        prompt: str("Task for Jules"),
        repo: str("owner/repo (optional)"),
        branch: str("Starting branch (optional, main)"),
        autoPr: {
          type: "boolean",
          description: "Open a PR at the end (default true)",
        },
      },
      ["prompt"],
    ),
    readOnly: false,
    run: async (a) => {
      const run = await (
        await julesClient()
      ).run({
        prompt: String(a.prompt),
        source: {
          github: a.repo ?? DEFAULT_REPO,
          baseBranch: a.branch ?? "main",
        },
        autoPr: a.autoPr !== false,
      });
      return { id: run.id };
    },
  },
  {
    name: "jules_status",
    description:
      "Read-only state of a Jules session: title, state, url, and the pull request once completed.",
    inputSchema: obj({ id: str("Session id") }, ["id"]),
    readOnly: true,
    run: async (a) => {
      const s = await (await julesClient()).session(String(a.id)).info();
      const pr = (s.outputs ?? []).find(
        (o: any) => o.type === "pullRequest",
      ) as any;
      return {
        id: s.id,
        title: s.title,
        state: s.state,
        url: s.url,
        pullRequest: pr?.pullRequest,
      };
    },
  },
  {
    name: "jules_sessions",
    description:
      "Read-only list of recent Jules sessions (id, title, state, url).",
    inputSchema: obj({
      limit: { type: "number", description: "Max sessions (default 20)" },
    }),
    readOnly: true,
    run: async (a) => {
      const out = [];
      for await (const s of (await julesClient()).sessions({
        limit: Number(a.limit ?? 20),
      }))
        out.push({ id: s.id, title: s.title, state: s.state, url: s.url });
      return out;
    },
  },
];
