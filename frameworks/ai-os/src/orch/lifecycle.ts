// Reproducible src lifecycle workflows, no human involved: they pin neither engine nor model (selection by
// select.ts), only the steps, their hosts and their guardrails. Compilation and containers on the host with the role
// build role of fleet.toml (fr1; nice -n 19, -j 4); prd keeps production only; the workstation only formats, type-checks, runs bun tests and judges.
//   software : code -> fmt -> check/clippy -> tests -> tribunal (ai-os review) -> correction -> build/docker
//              -> deployment (dry-run unless --apply) -> monitoring -> optimization (generated steps)
//   design   : PRD + DESIGN.md (gds plan) -> gds verify -> wck 100/100 -> juge
//   market   : drafts written and queued; publishing is a withheld external effect (policy.ts)
import { buildHost, shq } from "./fleet";
import type { Step, Workflow } from "./run";

export type LifecycleOptions = {
  task?: string;
  /** Path prefixes the code may touch and commit (runner: bounded commit). */
  paths?: string[];
  apply?: boolean;
  /** Bun packages to test (default: frameworks/ai-os). */
  bunTests?: string[];
  /** Build host (default: the fleet.toml host with the build role). */
  build?: string;
  slug?: string;
};

const day = () => new Date().toISOString().slice(0, 10);
const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "run";
// Runner checkout on the remote host: main up to date before compiling.
const synced = (cmd: string) => `git pull -q --ff-only origin main && ${cmd}`;
const heavy = (cmd: string) => `nice -n 19 ${cmd}`;
const q = (xs: string[]) => xs.map(shq).join(" ");

export function software(o: LifecycleOptions = {}): Workflow {
  const paths = o.paths?.length ? o.paths : ["frameworks/ai-os"];
  const build = o.build ?? buildHost();
  const slug = o.slug ?? slugOf(o.task ?? paths.join("-"));
  const msg = (what: string) => `${paths[0]} : ${what}`;
  const steps: Step[] = [];
  const after = (ids: string[]) =>
    ids.filter((id) => steps.some((s) => s.id === id));
  if (o.task)
    steps.push({
      id: "code",
      do: "agent",
      role: "coder",
      needs: { edit: true },
      prompt: `${o.task}\n\nsrc rules: read AGENTS.md and CLAUDE.md; touch only ${paths.join(", ")}; zero emoji; show no secret; finish with bun fmt on your files.`,
      check: `bun check && bun fmt --check ${q(paths)}`,
      commit: { paths, message: msg(o.task.slice(0, 60)) },
      budget_usd: 5,
    });
  steps.push(
    {
      id: "fmt",
      do: "cmd",
      deps: after(["code"]),
      hosts: ["pc"],
      // Check only: a diff opens a coder ticket that formats and commits within `paths` (no
      // uncommitted local change that prd would not see).
      run: `bun fmt --check ${q(paths)}`,
    },
    {
      // A single git sync on the build host, before any compilation (no concurrent index.lock).
      id: "sync",
      do: "cmd",
      deps: ["fmt"],
      hosts: [build],
      run: "git pull -q --ff-only origin main",
      onFail: "stop",
    },
    { id: "check", do: "cmd", deps: ["fmt"], hosts: ["pc"], run: "bun check" },
    {
      id: "clippy",
      do: "cmd",
      deps: ["sync"],
      hosts: [build],
      run: heavy("cargo clippy --workspace -j 4 --quiet -- -D warnings"),
      timeout_s: 5400,
    },
    {
      id: "test-bun",
      do: "cmd",
      deps: ["check"],
      hosts: ["pc"],
      run: (o.bunTests ?? ["frameworks/ai-os"])
        .map((p) => `bun test ${shq(p)}`)
        .join(" && "),
    },
    {
      id: "test-cargo",
      do: "cmd",
      deps: ["clippy"],
      hosts: [build],
      run: heavy("cargo test --workspace -j 4 --quiet"),
      timeout_s: 5400,
    },
    {
      id: "diff",
      do: "cmd",
      deps: ["test-bun"],
      hosts: ["pc"],
      // Git failure propagated (not masked by head's exit code).
      run: `out=$(git log -3 -p --stat -- ${q(paths)}) && printf '%s' "$out" | head -c 100000`,
      onFail: "stop",
    },
    {
      // Three-voice tribunal (src/review: Gemini and Claude in parallel, neutral judge who decides), engines from the
      // registry with fallback, anchored on the official Google sources and docs/reviews/CHECKLISTS.md; verdicts
      // docs/reviews/<voice>-<date>-<slug>.md and INDEX.md line written by the tool.
      id: "review",
      do: "tool",
      deps: ["diff"],
      hosts: ["pc"],
      tool: "review",
      args: {
        title: `${paths.join(", ")} (${day()})`,
        content: "{{diff}}",
        slug,
      },
      onFail: "continue",
    },
    {
      id: "fix",
      do: "agent",
      role: "coder",
      deps: ["review"],
      needs: { edit: true },
      prompt:
        'The ai-os review tribunal (two voices and a judge) reviewed the change. Check each defect the judge kept against the code; fix the real ones, ignore the others and say so. Nothing to do if the status is "compliant".\n\n{{review}}',
      check: "bun check",
      commit: {
        paths: [...paths, "docs/reviews"],
        message: msg("tribunal fixes"),
      },
      onFail: "continue",
      budget_usd: 5,
    },
    {
      id: "docker",
      do: "cmd",
      deps: ["fix", "test-cargo"],
      hosts: [build],
      // Resynced: the judges' fixes were pushed by the runner from "sync".
      run: synced(
        heavy("docker build --target runtime -t aphrody/src:agents ."),
      ),
      timeout_s: 5400,
    },
    {
      id: "deploy",
      do: "cmd",
      deps: ["docker"],
      hosts: ["pc"],
      run: o.apply ? "ay deploy up --all" : "ay deploy up --all --dry-run",
    },
    {
      id: "monitor",
      do: "tool",
      deps: ["deploy"],
      hosts: ["pc"],
      tool: "fleet_status",
      args: {},
    },
    {
      id: "optimize",
      do: "agent",
      role: "sre",
      deps: ["monitor"],
      prompt:
        'Fleet state after deployment:\n{{monitor}}\n\nPropose at most 3 measurable optimizations of src (performance, reliability, cost), each as a task for a coder agent. Answer only with a ```json {"steps":[{"id":"o1","do":"agent","role":"coder","needs":{"edit":true},"prompt":"…","check":"…"}]} ``` block; empty list if nothing justifies it.',
      expand: true,
      // Generated tasks commit within the same scope and run in sequence (run.ts).
      commit: { paths, message: msg("optimisation") },
      onFail: "continue",
    },
  );
  return { name: `software-${slug}`, paths, steps };
}

const product_ = (p: string) => {
  if (!/^[\w.-]+$/.test(p)) throw new Error(`nom de produit invalide : ${p}`);
  return p;
};

export function design(product: string, o: { url?: string } = {}): Workflow {
  const dir = `apps/${product_(product)}`;
  return {
    name: `design-${product}`,
    steps: [
      {
        id: "prd",
        do: "agent",
        role: "designer",
        needs: { edit: true },
        prompt: `src Design-First Gate for ${dir}: update the requirements document (PRD) and DESIGN.md with \`gds plan ${product} --out ${dir}/docs\`, then complete them from the real code. No UI code before these documents.`,
        check: `gds audit-slop ${shq(`${dir}/docs`)}`,
        commit: {
          paths: [`${dir}/docs`],
          message: `${dir} : PRD et DESIGN.md`,
        },
      },
      {
        id: "gds",
        do: "cmd",
        deps: ["prd"],
        hosts: ["pc"],
        run: `gds verify ${shq(dir)}`,
      },
      {
        id: "wck",
        do: "cmd",
        deps: ["prd"],
        hosts: ["pc"],
        run: `wck ${shq(o.url ?? dir)} --quiet`,
      },
      {
        id: "judge",
        do: "tool",
        deps: ["gds", "wck"],
        hosts: ["pc"],
        tool: "review",
        args: {
          title: `${dir} design (${day()})`,
          content: "gds verify :\n{{gds}}\n\nwck :\n{{wck}}",
          slug: `design-${product}`,
        },
      },
    ],
  };
}

export function market(product: string, brief: string): Workflow {
  product_(product);
  return {
    name: `market-${product}`,
    steps: [
      {
        id: "facts",
        do: "cmd",
        hosts: ["pc"],
        run: `git log -20 --format='%h %s' -- ${shq(`apps/${product}`)} ${shq(`frameworks/${product}`)} ${shq(`system/${product}`)}`,
      },
      {
        id: "draft",
        do: "agent",
        role: "growth",
        needs: {},
        prompt: `Write marketing drafts for ${product}: ${brief}\nVerifiable facts only (log below), direct tone, zero emoji, no superlatives or AI vocabulary. One draft per channel, with the channel as the title.\n\n{{facts}}`,
        out: `var/agents/outbox/${product}-${day()}.md`,
      },
      {
        id: "publish",
        do: "agent",
        role: "growth",
        deps: ["draft"],
        effect: "external",
        prompt: "Publish the approved drafts:\n{{draft}}",
      },
    ],
  };
}
