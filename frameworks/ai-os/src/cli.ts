#!/usr/bin/env bun
// @aphrody/ai-os entry point: `ai-os relay <cmd>` runs the relay CLI (src/relay/cli.ts), `ai-os orch <cmd>` the
// orchestrator (src/orch/cli.ts), `ai-os fabric <cmd>` the distributed inference fabric (src/fabric/cli.ts),
// `ai-os nhitl <cmd>` the index of human-in-the-loop violations (src/nhitl/cli.ts), `ai-os review <target>` the
// three-voice review tribunal (src/review/cli.ts, docs/reviews/README.md), `ai-os automate <list|run|tui>` the automations of
// @aphrody/automate (src/automate/cli.ts),
// anything else the agent CLI (src/agent-cli.ts: init, run, context, schedule, heartbeat, skills, research, gateway, tui).
const subs: Record<string, string> = {
  relay: "./relay/cli.ts",
  orch: "./orch/cli.ts",
  fabric: "./fabric/cli.ts",
  brain: "./brain/cli.ts",
  providers: "./providers/cli.ts",
  nhitl: "./nhitl/cli.ts",
  review: "./review/cli.ts",
  automate: "./automate/cli.ts",
  term: "./term/cli.ts",
};
const sub = Bun.argv[2];
if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
  console.log(
    `ai-os <command> [args]\nCommands: ${[...Object.keys(subs), "jules", "stitch", "init", "run", "context", "skills", "research", "gateway"].join(", ")}`,
  );
  process.exitCode = 0;
} else if (sub === "jules" || sub === "stitch") {
  const g = await import("./google/cli.ts");
  const rest = Bun.argv.slice(3);
  process.exit(
    await g.guarded(() =>
      sub === "jules" ? g.julesCli(rest) : g.stitchCli(rest),
    ),
  );
} else if (sub && subs[sub]) {
  const same = Bun.argv === process.argv;
  Bun.argv.splice(2, 1);
  if (!same) process.argv.splice(2, 1);
  await import(subs[sub]);
} else await import("./agent-cli.ts");
