// ai-os run <task> | schedule add <name> <task> --every 1h | schedule list | heartbeat [--once] | relay <cmd>
// ai-os skills lint|curate | gateway | tui   (common flags: --home DIR --model provider/model --allow-shell)
// Models are discovered at run time (src/llm).
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { run } from "./core/agent";
import { resolveModel } from "./core/model";
import { lintContent } from "./core/skill-lint";
import { Skills } from "./core/skills";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "allow-shell": { type: "boolean" },
    home: { type: "string" },
    model: { type: "string" },
    "max-steps": { type: "string" },
    every: { type: "string" },
    interval: { type: "string" },
    once: { type: "boolean" },
    "require-tool": { type: "boolean" },
    validate: { type: "boolean" },
    batch: { type: "string" },
    "no-web": { type: "boolean" },
  },
});
const home = values.home ?? Bun.env.AGENT_HOME ?? join(homedir(), ".agent");
const [cmd, sub, ...rest] = positionals;
const usage = () => {
  console.error(
    "usage: ai-os init | run <task> | context <query> | skills lint|curate | research <outline.yaml> [--validate] | gateway | relay <cmd>",
  );
  process.exit(2);
};

switch (cmd) {
  case "init": {
    const { init } = await import("./core/home");
    for (const p of await init(home)) console.log(`created ${p}`);
    console.log(`home: ${home}`);
    break;
  }
  case "context": {
    const q = [sub, ...rest].filter(Boolean).join(" ");
    if (!q) usage();
    const { Memory } = await import("./core/memory");
    const m = new Memory(join(home, "memory.sqlite"));
    for (const s of await m.ctx.select(q, { redact: Bun.env }))
      console.log(
        `${s.score.toFixed(3)} ${s.id} [${Object.entries(s.heads)
          .map(([h, v]) => `${h}=${v.toFixed(2)}`)
          .join(" ")}] ${(s.title ?? s.text).slice(0, 80)}`,
      );
    m.close();
    break;
  }
  case "run": {
    const task = [sub, ...rest].filter(Boolean).join(" ");
    if (!task) usage();
    const r = await run({
      task,
      model: await resolveModel(values.model),
      home,
      cwd: process.cwd(),
      allowShell: values["allow-shell"],
      requireTool: values["require-tool"] ?? Bun.env.AGENT_REQUIRE_TOOL === "1",
      maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
    });
    console.log(r.text);
    console.error(
      `[agent] steps=${r.steps} tools=${r.toolCalls.join(",") || "none"}`,
    );
    break;
  }
  case "skills": {
    const skills = new Skills(join(home, "skills"));
    if (sub === "lint") {
      let errors = 0;
      for (const s of await skills.list()) {
        for (const f of lintContent(
          await Bun.file(s.path).text(),
          join(home, "skills", s.name),
        )) {
          if (f.severity === "error") errors++;
          console.log(`${s.name}: ${f.severity} ${f.rule}: ${f.message}`);
        }
      }
      process.exit(errors ? 1 : 0);
    } else if (sub === "curate")
      console.log(JSON.stringify(await skills.curate()));
    else usage();
    break;
  }
  case "research": {
    if (!sub) usage();
    const r = await import("./research/index");
    if (values.validate) {
      const v = await r.validateDir(sub!);
      for (const x of v)
        console.log(
          `${x.ok ? "PASS" : "FAIL"} ${x.file} ${x.errors.join("; ")}`,
        );
      process.exit(v.every((x) => x.ok) ? 0 : 1);
    }
    const out = await r.research({
      outlinePath: sub!,
      model: await resolveModel(values.model),
      home,
      batchSize: values.batch ? Number(values.batch) : undefined,
      web: !values["no-web"],
      onItem: (e) =>
        console.log(
          `${e.ok ? "PASS" : "FAIL"} ${e.item} -> ${e.path} ${e.errors.join("; ")}`,
        ),
    });
    console.error(
      `[research] ${out.topic}: ${out.passed}/${out.results.length} passed, results in ${out.outDir}`,
    );
    process.exit(out.passed === out.results.length ? 0 : 1);
  }
  case "gateway": {
    const { createGateway } = await import("./gateway/index");
    const g = createGateway({
      home,
      model: await resolveModel(values.model),
      port: Number(Bun.env.AGENT_PORT ?? 4000),
      hostname: Bun.env.AGENT_HOST,
      token: Bun.env.AGENT_GATEWAY_TOKEN,
      allowShell: values["allow-shell"],
    });
    console.log(`gateway on ${g.url}`);
    await new Promise(() => {});
    break;
  }
  default:
    usage();
}
