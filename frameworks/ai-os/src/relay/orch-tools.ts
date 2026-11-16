// Orchestrator exposed by the relay (MCP, A2A, JSON-RPC): multi-host step graph, engine routing, health.
// Same functions as `ai-os orch` (src/orch/cli.ts); JSON output.
import { s } from "../llm/schema";
import type { Tool } from "./tools.ts";

export const ORCH_TOOLS: Tool[] = [
  {
    name: "orch_run",
    description:
      "Run a workflow (task graph: agent, cmd and tool steps with deps, hosts, needs, expand) in parallel across the fleet with automatic engine/host failover, fix tickets and budgets. Format: frameworks/ai-os/docs/ORCHESTRATOR.md.",
    inputSchema: s.object(
      {
        workflow: s.string(
          'Workflow JSON: {"name":…,"steps":[…],"limits":{…}}',
        ),
        dryRun: s.boolean("Resolve the graph without executing (optional)"),
      },
      ["dryRun"],
    ),
    readOnly: false,
    run: async (a) => {
      const { runWorkflow } = await import("../orch/run.ts");
      return runWorkflow(JSON.parse(String(a.workflow)), {
        dryRun: a.dryRun === true,
      });
    },
  },
  {
    name: "orch_engines",
    description:
      "Engines available per fleet host (agent CLIs probed by the runner or on PATH, models discovered by llm_models with models.dev metadata) and the ordered providers list computed for a declared need.",
    inputSchema: s.object(
      {
        host: s.string("Host id from tools/agents/fleet.toml (optional)"),
        edit: s.boolean("Step edits files (optional)"),
        models: s.array(s.string("cli:model or provider/model"), {
          description: "Preferred models, tried first (optional)",
        }),
      },
      ["host", "edit", "models"],
    ),
    readOnly: true,
    run: async (a) => {
      const [{ hosts }, { Health }, { runnerState }, { candidates, rank }] =
        await Promise.all([
          import("../orch/fleet.ts"),
          import("../orch/health.ts"),
          import("../orch/queue.ts"),
          import("../orch/select.ts"),
        ]);
      const health = new Health();
      try {
        return await Promise.all(
          hosts()
            .filter((h) => !a.host || h.id === a.host)
            .map(async (h) => {
              const rs = await runnerState(h).catch(() => undefined);
              const all = await candidates(h, rs);
              return {
                host: h.id,
                runner: rs,
                providers: rank(
                  h.id,
                  all,
                  { edit: a.edit === true, models: a.models },
                  health,
                  rs?.cooling,
                ),
              };
            }),
        );
      } finally {
        health.close();
      }
    },
  },
];
