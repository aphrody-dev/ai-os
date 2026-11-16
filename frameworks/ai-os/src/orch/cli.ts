// ai-os orch: multi-host, multi-engine orchestrator. JSON output on stdout, JSONL journal per run.
//   ai-os orch hosts                              hosts (fleet.toml + deploy.toml), runner state
//   ai-os orch engines [--host H] [--edit]        candidates and `providers` order computed for a need
//   ai-os orch run <workflow.json|->  [--dry-run] step graph (format: docs/ORCHESTRATOR.md)
//   ai-os orch plan "<goal>" [--dry-run]          a planner generates the graph (expand step), then runs it
//   ai-os orch lifecycle [--task T] [--paths a,b] [--apply] [--dry-run]
//   ai-os orch design <produit> [--url U] | market <produit> "<brief>"
//   ai-os orch health                             cooldowns and outcomes observed per host/provider
//   ai-os orch queue [--host H]                   queued tasks (new, claimed) and estimated tokens of their prompts
import { parseArgs } from "node:util";
import { hosts as fleetHosts } from "./fleet";
import { Health } from "./health";
import { design, market, software } from "./lifecycle";
import { runnerState } from "./queue";
import { type Step, type Workflow, runWorkflow } from "./run";
import { candidates, rank, taskModels } from "./select";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    host: { type: "string" },
    edit: { type: "boolean" },
    prefer: { type: "string" },
    model: { type: "string", multiple: true },
    task: { type: "string" },
    paths: { type: "string" },
    url: { type: "string" },
    apply: { type: "boolean" },
    "dry-run": { type: "boolean" },
    quiet: { type: "boolean" },
  },
});
const [cmd, ...rest] = positionals;
const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const exec = async (wf: Workflow) => {
  const r = await runWorkflow(wf, {
    dryRun: values["dry-run"],
    onEvent: values.quiet ? undefined : (e) => console.error(JSON.stringify(e)),
  });
  print(r);
  process.exit(r.ok ? 0 : 1);
};

switch (cmd) {
  case "hosts": {
    const hs = fleetHosts();
    print(
      await Promise.all(
        hs.map(async (h) => ({
          ...h,
          runner: await runnerState(h).catch((e) => ({ error: String(e) })),
        })),
      ),
    );
    break;
  }
  case "engines": {
    const health = new Health();
    const hs = fleetHosts().filter((h) => !values.host || h.id === values.host);
    print(
      await Promise.all(
        hs.map(async (h) => {
          const rs = await runnerState(h).catch(() => undefined);
          const all = await candidates(h, rs);
          return {
            host: h.id,
            candidates: all,
            providers: rank(
              h.id,
              all,
              {
                edit: values.edit,
                prefer: values.prefer as any,
                models: [
                  ...(await taskModels(values.task)),
                  ...(values.model ?? []),
                ],
              },
              health,
              rs?.cooling,
            ),
          };
        }),
      ),
    );
    health.close();
    break;
  }
  case "health": {
    const h = new Health();
    print({
      cooldown: h.db
        .query(
          "SELECT host, provider, class, fails, datetime(until/1000, 'unixepoch') AS until FROM cooldown WHERE until > ?",
        )
        .all(Date.now()),
      outcomes: h.db
        .query(
          "SELECT host, provider, count(*) AS n, sum(ok) AS ok, cast(avg(ms) AS int) AS avg_ms FROM outcome GROUP BY host, provider ORDER BY host, n DESC",
        )
        .all(),
    });
    h.close();
    break;
  }
  case "queue": {
    // Queued tasks (new, claimed) per host and estimated tokens of their prompts (~4 characters per token; the
    // context the CLI loads afterwards is not counted).
    const { exec, shq } = await import("./fleet");
    const hs = fleetHosts().filter((h) => !values.host || h.id === values.host);
    const dump = (d: string) =>
      `for s in new claimed; do for f in ${shq(d)}/queue/$s/*.json; do [ -f "$f" ] && { printf '@@%s\\n' "$s"; head -c 400000 "$f"; printf '\\n'; }; done; done`;
    print(
      await Promise.all(
        hs.map(async (h) => {
          const dir =
            h.local && Bun.env.AGENTS_HOME
              ? Bun.env.AGENTS_HOME
              : `${h.src}/var/agents`;
          const r = h.local
            ? await exec(
                h,
                [
                  Bun.which("niu") ?? Bun.which("bash") ?? "sh",
                  "-c",
                  dump(dir.replaceAll("\\", "/")),
                ],
                { timeoutMs: 30_000 },
              )
            : await exec(h, [dump(dir)], { raw: true, timeoutMs: 60_000 });
          const tasks = r.out
            .split(/^@@/m)
            .filter(Boolean)
            .flatMap((b) => {
              const nl = b.indexOf("\n");
              try {
                const t = JSON.parse(b.slice(nl + 1));
                return [
                  {
                    id: t.id,
                    state: b.slice(0, nl),
                    role: t.role,
                    tokens: Math.ceil(String(t.prompt ?? "").length / 4),
                    budget_usd: t.budget_usd ?? null,
                  },
                ];
              } catch {
                return [];
              }
            });
          return {
            host: h.id,
            error: r.code ? r.err.trim().slice(-200) : undefined,
            tasks,
            tokens: tasks.reduce((n, t) => n + t.tokens, 0),
          };
        }),
      ),
    );
    break;
  }
  case "run": {
    const src = rest[0] ?? "-";
    const text =
      src === "-" ? await Bun.stdin.text() : await Bun.file(src).text();
    const wf = JSON.parse(text) as Workflow;
    if (!wf?.name || !Array.isArray(wf.steps))
      throw new Error("workflow : { name, steps[] } attendu");
    await exec(wf);
    break;
  }
  case "plan": {
    const goal = rest.join(" ");
    if (!goal) throw new Error('usage : ai-os orch plan "<objectif>"');
    const planner: Step = {
      id: "plan",
      do: "agent",
      role: "reviewer",
      expand: true,
      prompt:
        `Plan the following goal for the src monorepo as a graph of steps executable by agents. Goal: ${goal}\n\n` +
        'Answer only with a ```json {"steps":[…]} ``` block where each step has id, do ("agent"|"cmd"|"tool"), deps (ids), ' +
        'and depending on do: prompt + role (coder|reviewer|tester|linter|designer|deployer|sre|growth) + needs ({"edit":true} to modify files) + check, ' +
        'or run (sh line), or tool + args. Hosts: the ones listed in fleet.toml, by role (compilation: nice -n 19, -j 4). Any publication, send or spend: "effect":"external". At most 12 steps.',
    };
    await exec({ name: "plan", steps: [planner] });
    break;
  }
  case "lifecycle":
    await exec(
      software({
        task: values.task,
        paths: values.paths?.split(",").filter(Boolean),
        apply: values.apply,
      }),
    );
    break;
  case "design":
    if (!rest[0]) throw new Error("usage : ai-os orch design <produit>");
    await exec(design(rest[0], { url: values.url }));
    break;
  case "market":
    if (!rest[0] || !rest[1])
      throw new Error('usage : ai-os orch market <produit> "<brief>"');
    await exec(market(rest[0], rest.slice(1).join(" ")));
    break;
  default:
    console.error(
      "usage : ai-os orch hosts | engines [--host H] [--edit] [--prefer cost|latency|reliability] [--model cli:m] | health | queue [--host H] | run <workflow.json|-> [--dry-run] | plan <objectif> | lifecycle [--task T] [--paths a,b] [--apply] | design <produit> [--url U] | market <produit> <brief>",
    );
    process.exit(2);
}
