// ai-os fabric: distributed inference fabric (tools/ai/fabric.toml). JSON output on stdout.
//   ai-os fabric up [--only fr1,prd] [--split 1,7] [--local] [--no-warm] [--model alias]  admits the nodes, starts rpc-server then the coordinator
//   ai-os fabric status                                        coordinator, nodes (condition, load, systemd caps)
//   ai-os fabric warm [--only fr1]                            nodes: local GGUF verified, tensor cache filled
//   ai-os fabric ensure                                        failover (silent coordinator -> up), then opportunistic admission [trial]
//   ai-os fabric timer [--remove] [--every 10]                 Windows scheduled task: ensure every N minutes
//   ai-os fabric trials                                        short trials logged by ensure (opportunistic admission)
//   ai-os fabric down                                          stops the coordinator and the rpc-servers
//   ai-os fabric bench [--tokens N] [prompt]                   one real generation, tokens/s
//   ai-os fabric node <id>                                     Windows node: rpc-server in the foreground
import { parseArgs } from "node:util";
import {
  bench,
  down,
  ensure,
  serveNode,
  status,
  timer,
  trials,
  up,
  warm,
} from "./index";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    only: { type: "string" },
    split: { type: "string" },
    local: { type: "boolean" },
    "no-warm": { type: "boolean" },
    tokens: { type: "string" },
    model: { type: "string" },
    remove: { type: "boolean" },
    every: { type: "string" },
  },
});
const [cmd, ...rest] = positionals;
const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const list = (s?: string) => (s ? s.split(",").filter(Boolean) : undefined);

switch (cmd ?? "status") {
  case "up": {
    const r = await up({
      only: list(values.only),
      split: list(values.split)?.map(Number),
      local: values.local,
      noWarm: values["no-warm"],
      model: values.model,
    });
    print(r);
    process.exit(r.ok ? 0 : 1);
  }
  case "status":
    print(await status());
    break;
  case "timer":
    print(timer(!!values.remove, Number(values.every ?? 10)));
    break;
  case "trials":
    print(trials());
    break;
  case "ensure":
    print(await ensure());
    break;
  case "warm":
    print(await warm(list(values.only)));
    break;
  case "down":
    print(await down());
    break;
  case "bench":
    print(
      await bench(
        rest.join(" ") || "Explain how a CPU cache works, in detail.",
        Number(values.tokens ?? 128),
      ),
    );
    break;
  case "node":
    process.exit(await serveNode(rest[0] ?? ""));
  default:
    console.error("usage : ai-os fabric up|status|down|bench|node <id>");
    process.exit(64);
}
