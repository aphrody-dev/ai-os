// Orchestrator: workflow = graph of steps computed at run time, executed in parallel on the fleet hosts.
//   - `cmd` steps (sh line, low priority), `tool` (relay tool), `agent` (sub-agent: tools/agents/runner.ts queue
//     if a worker of the role is beating on the host, otherwise direct read-only execution);
//   - `expand`: a step's output may add steps ({"steps":[…]}), bounded in count and depth;
//   - fallback: each failure is classified (classify.ts); quota/auth/missing -> next provider (`providers` list
//     computed by select.ts), then next host; throttle/overload/timeout -> one retry after a wait;
//   - repair: a failing command opens a fix ticket (coder sub-agent, `check` = the command),
//     dependent steps wait for the ticket; at most `fixRounds` tickets per step;
//   - guardrails: steps, depth, budget in $ (sum of delegated budget_usd), tokens, deadline, stop after N consecutive
//     failures, external effects refused without an owner rule (policy.ts).
// Journal JSONL : $AGENT_HOME/orch/runs/<run>.jsonl ; rapport JSON en retour.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { classify, type FailClass, retryAfterMs, switches } from "./classify";
import { type Host, hosts as fleetHosts, shell, srcRoot } from "./fleet";
import { Health } from "./health";
import { inline } from "./inline";
import { allowExternal, hold } from "./policy";
import * as Q from "./queue";
import { candidates, type Needs, rank } from "./select";

export type Role = Q.QueueTask["role"];

export type Step = {
  id: string;
  deps?: string[];
  do: "agent" | "cmd" | "tool";
  /** agent: instruction; {{id}} = output of step id. */
  prompt?: string;
  role?: Role;
  /** cmd: sh line run from the host checkout (or its home directory if repo: false). */
  run?: string;
  repo?: boolean;
  /** tool: relay tool (relay/tools.ts) and its arguments. */
  tool?: string;
  args?: Record<string, unknown>;
  /** Allowed hosts, by preference (default: hosts whose fleet.toml lists the role, local first). */
  hosts?: string[];
  needs?: Needs;
  check?: string;
  commit?: { paths: string[]; message: string };
  effect?: "external";
  expand?: boolean;
  /** File to write the output to (under docs/reviews/ or var/ only). */
  out?: string;
  onFail?: "fix" | "stop" | "continue";
  timeout_s?: number;
  budget_usd?: number;
};

export type Workflow = {
  /** Prefixes the fix tickets may commit (default: no commit). */
  paths?: string[];
  name: string;
  steps: Step[];
  limits?: Partial<Limits>;
};

export type Limits = {
  maxSteps: number;
  maxDepth: number;
  budgetUsd: number;
  tokenBudget: number;
  deadlineMs: number;
  maxConsecutiveFailures: number;
  fixRounds: number;
  pollMs: number;
};

const env = (k: string, d: number) => Number(Bun.env[k] ?? d);
export const defaultLimits = (): Limits => ({
  maxSteps: env("ORCH_MAX_STEPS", 48),
  maxDepth: env("ORCH_MAX_DEPTH", 3),
  budgetUsd: env("ORCH_BUDGET_USD", 20),
  tokenBudget: env("ORCH_TOKEN_BUDGET", 2_000_000),
  deadlineMs: env("ORCH_DEADLINE_MS", 4 * 3600_000),
  maxConsecutiveFailures: env("ORCH_MAX_FAILS", 4),
  fixRounds: env("ORCH_FIX_ROUNDS", 1),
  pollMs: env("ORCH_POLL_MS", 10_000),
});

type Status = "pending" | "running" | "done" | "failed" | "skipped" | "held";
export type Try = {
  host: string;
  provider?: string;
  ok: boolean;
  cls?: FailClass;
  ms: number;
  via: "queue" | "inline" | "cmd" | "tool";
};
type State = {
  step: Step;
  depth: number;
  status: Status;
  host?: string;
  provider?: string;
  output: string;
  tries: Try[];
  fixes: number;
  /** Fix ticket that replaces this step for its dependents. */
  fixedBy?: string;
  note?: string;
  t0?: number;
  ms?: number;
};

export type RunOptions = {
  hosts?: Host[];
  limits?: Partial<Limits>;
  dryRun?: boolean;
  root?: string;
  onEvent?: (e: Record<string, unknown>) => void;
};

const DEFAULT_ROLE: Record<Step["do"], Role> = {
  agent: "reviewer",
  cmd: "linter",
  tool: "sre",
};

/** First balanced JSON object that contains "steps" (agent output without a ```json block). */
export function balancedSteps(text: string): string | undefined {
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    let depth = 0;
    let str = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (str) {
        if (c === "\\") j++;
        else if (c === '"') str = false;
      } else if (c === '"') str = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        const cand = text.slice(i, j + 1);
        if (cand.includes('"steps"')) return cand;
        break;
      }
    }
  }
  return undefined;
}

export async function runWorkflow(wf: Workflow, o: RunOptions = {}) {
  const root = o.root ?? srcRoot();
  const L = { ...defaultLimits(), ...wf.limits, ...o.limits };
  const fleet = o.hosts ?? fleetHosts(root);
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${wf.name.replace(/[^\w-]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
  const logDir = join(
    Bun.env.AGENT_HOME ?? join(homedir(), ".agent"),
    "orch",
    "runs",
  );
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${runId}.jsonl`);
  const t0 = Date.now();
  const emit = (event: string, data: Record<string, unknown> = {}) => {
    const e = { ts: new Date().toISOString(), run: runId, event, ...data };
    appendFileSync(logFile, `${JSON.stringify(e)}\n`);
    o.onEvent?.(e);
  };

  const st = new Map<string, State>();
  const add = (s: Step, depth: number) => {
    if (st.has(s.id)) throw new Error(`duplicate step: ${s.id}`);
    if (st.size >= L.maxSteps)
      throw new Error(`step limit reached (${L.maxSteps})`);
    st.set(s.id, {
      step: s,
      depth,
      status: "pending",
      output: "",
      tries: [],
      fixes: 0,
    });
  };
  for (const s of wf.steps) add(s, 0);
  for (const s of wf.steps)
    for (const d of s.deps ?? [])
      if (!st.has(d))
        throw new Error(`${s.id} depends on ${d}, which is missing`);
  const health = new Health();

  const busy = new Map<string, number>(fleet.map((h) => [h.id, 0]));
  let spentUsd = 0;
  let tokens = 0;
  let consecutive = 0;
  let stopped: string | undefined;

  // Resolve a dependency through the fix tickets.
  const resolve = (id: string): State => {
    let s = st.get(id)!;
    while (s.fixedBy) s = st.get(s.fixedBy)!;
    return s;
  };
  const outputOf = (id: string) => {
    const s = resolve(id);
    return s.status === "done" ? s.output : "";
  };
  const fill = (text: string) =>
    text.replace(/\{\{([\w.#-]+)\}\}/g, (_, id) =>
      st.has(id) ? outputOf(id).slice(-20_000) : `{{${id}}}`,
    );

  const runnerCache = new Map<string, { at: number; v: Q.RunnerState }>();
  const runner = async (h: Host) => {
    const c = runnerCache.get(h.id);
    if (c && Date.now() - c.at < 60_000) return c.v;
    const v = await Q.runnerState(h).catch(
      () =>
        ({ alive: false, roles: [], clis: {}, cooling: [] }) as Q.RunnerState,
    );
    runnerCache.set(h.id, { at: Date.now(), v });
    return v;
  };

  const hostsFor = (s: Step): Host[] => {
    const role = s.role ?? DEFAULT_ROLE[s.do];
    const pool = s.hosts?.length
      ? s.hosts
          .map((id) => fleet.find((h) => h.id === id))
          .filter((h): h is Host => !!h)
      : [...fleet].sort((a, b) => Number(b.local) - Number(a.local));
    return s.hosts?.length || s.do !== "agent"
      ? pool
      : pool.filter((h) => h.local || h.roles.includes(role));
  };

  // ---------- running one step on a host ----------
  async function cmdStep(s: State, h: Host): Promise<boolean> {
    const r = await shell(
      h,
      fill(s.step.run!),
      (s.step.timeout_s ?? 1800) * 1000,
      s.step.repo === false,
    );
    const ok = r.code === 0;
    s.output = `${r.out}${r.err ? `\n[stderr]\n${r.err}` : ""}`.slice(-20_000);
    const cls = ok
      ? undefined
      : r.code === 127
        ? "missing"
        : r.code === 124
          ? "timeout"
          : "task";
    s.tries.push({ host: h.id, ok, cls, ms: r.ms, via: "cmd" });
    return ok;
  }

  async function toolStep(s: State, h: Host): Promise<boolean> {
    const t1 = performance.now();
    try {
      const { toolByName } = await import("../relay/tools.ts");
      const t = toolByName.get(s.step.tool!);
      if (!t) throw new Error(`unknown tool: ${s.step.tool}`);
      // Interpolate on the structure (an output with quotes or newlines does not break the JSON).
      const fillVal = (v: unknown): unknown =>
        typeof v === "string"
          ? fill(v)
          : Array.isArray(v)
            ? v.map(fillVal)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v).map(([k, x]) => [k, fillVal(x)]),
                )
              : v;
      const args = fillVal(s.step.args ?? {}) as Record<string, unknown>;
      const r = await t.run(args);
      s.output = (typeof r === "string" ? r : JSON.stringify(r, null, 2)).slice(
        -40_000,
      );
      s.tries.push({
        host: h.id,
        ok: true,
        ms: Math.round(performance.now() - t1),
        via: "tool",
      });
      return true;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      s.output = msg;
      s.tries.push({
        host: h.id,
        ok: false,
        cls: classify(msg),
        ms: Math.round(performance.now() - t1),
        via: "tool",
      });
      return false;
    }
  }

  async function agentStep(
    s: State,
    h: Host,
    providers: string[],
  ): Promise<"ok" | "fail" | "reroute"> {
    const step = s.step;
    const role = step.role ?? DEFAULT_ROLE.agent;
    const prompt = fill(step.prompt ?? "");
    const rs = await runner(h);
    if (rs.roles.includes(role)) {
      const id = `${runId}-${step.id}`.replace(/[^\w.-]/g, "_").slice(0, 120);
      const budget = step.budget_usd ?? 2;
      if (spentUsd + budget > L.budgetUsd) {
        s.output = `$ budget exhausted (${spentUsd} + ${budget} > ${L.budgetUsd})`;
        return "fail";
      }
      spentUsd += budget;
      const maxAttempts = Math.min(providers.length, 6);
      const allowed = step.effect === "external"; // execute() only gets here with an owner rule
      const task: Q.QueueTask = {
        v: 1,
        id,
        prompt,
        role,
        host: h.id,
        providers,
        cwd: undefined,
        check: step.check,
        commit: step.commit,
        // An external effect cleared by a rule goes out without approval; growth stays a draft otherwise (runner).
        approval: allowed ? "none" : role === "growth" ? "owner" : "none",
        timeout_s: step.timeout_s,
        budget_usd: budget,
        max_attempts: maxAttempts,
        created_by: `ai-os/orch ${runId}`,
        created_at: new Date().toISOString(),
      };
      await Q.enqueue(h, task);
      emit("enqueue", { step: step.id, host: h.id, task: id, providers });
      const until = Date.now() + ((step.timeout_s ?? 3600) + 600) * 1000;
      while (Date.now() < until && !stopped) {
        await Bun.sleep(L.pollMs);
        const r = await Q.poll(h, id);
        if (r) {
          for (const a of r.attempts) {
            const cls: FailClass | undefined =
              a.reason === "ok"
                ? undefined
                : a.reason === "provider_unavailable"
                  ? "quota"
                  : "task";
            health.record(
              h.id,
              a.provider,
              a.reason === "ok",
              cls ?? null,
              Date.parse(a.ended) - Date.parse(a.started),
            );
            s.tries.push({
              host: h.id,
              provider: a.provider,
              ok: a.reason === "ok",
              cls,
              ms: Date.parse(a.ended) - Date.parse(a.started),
              via: "queue",
            });
          }
          if (r.status === "done") {
            s.provider = r.provider;
            s.output = await Q.output(h, r);
            return "ok";
          }
          s.output = `failed in the queue of ${h.id}: ${r.attempts.map((a) => `${a.provider}:${a.reason}`).join(", ")}`;
          return r.attempts.every((a) => a.reason === "provider_unavailable")
            ? "reroute"
            : "fail";
        }
        // All providers unavailable on this host: withdraw the task and switch host.
        const pend = await Q.pendingAttempts(h, id);
        if (
          pend.length >= maxAttempts &&
          pend.every((a) => a.reason === "provider_unavailable") &&
          (await Q.withdraw(h, id))
        ) {
          for (const a of pend)
            health.record(h.id, a.provider, false, "quota", 0);
          s.output = `providers unavailable on ${h.id}`;
          spentUsd -= budget; // nothing ran
          return "reroute";
        }
        if (Date.now() - t0 > L.deadlineMs) break;
      }
      // No ghost task: withdrawn if still waiting (a claimed task finishes in the runner).
      await Q.withdraw(h, id).catch(() => false);
      s.output = stopped
        ? `stopped (${stopped}) while waiting on the queue of ${h.id}`
        : `timed out in the queue of ${h.id}`;
      return "fail";
    }
    if (step.needs?.edit || step.effect === "external") {
      s.output = `no "${role}" worker on ${h.id}: a step that edits files or acts externally goes through the queue`;
      s.tries.push({
        host: h.id,
        ok: false,
        cls: "missing",
        ms: 0,
        via: "queue",
      });
      return "reroute";
    }
    // Direct execution, provider by provider (router called again after each failure, tried key excluded).
    const failed = new Set<string>();
    for (const p of providers) {
      // Router called again: a discarded CLI (auth, missing, quota) also discards its "cli:model" variants.
      const base = p.includes(":") ? p.split(":")[0]! : p;
      if (failed.has(p) || failed.has(base) || health.cooling(h.id, base))
        continue;
      if (stopped) return "fail";
      if (tokens >= L.tokenBudget) {
        s.output = "token budget exhausted";
        return "fail";
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await inline(h, p, prompt, (step.timeout_s ?? 900) * 1000);
        tokens += r.tokens;
        health.record(h.id, p, r.ok, r.cls ?? null, r.ms);
        s.tries.push({
          host: h.id,
          provider: p,
          ok: r.ok,
          cls: r.cls,
          ms: r.ms,
          via: "inline",
        });
        emit("try", {
          step: step.id,
          host: h.id,
          provider: p,
          ok: r.ok,
          cls: r.cls,
          ms: r.ms,
        });
        if (r.ok) {
          s.provider = p;
          s.output = r.text;
          return "ok";
        }
        s.output = r.text;
        failed.add(p);
        // The task itself fails: no point replaying it on every engine and host.
        if (r.cls === "task") return "fail";
        if (r.cls === "auth" || r.cls === "missing") {
          failed.add(base);
          if (base !== p) health.record(h.id, base, false, r.cls, 0);
        }
        if (!r.cls || switches(r.cls) || attempt === 1) break;
        await Bun.sleep(
          Math.max(retryAfterMs(r.text), r.cls === "throttle" ? 5_000 : 2_000),
        );
      }
    }
    return "reroute";
  }

  async function execute(s: State): Promise<void> {
    const step = s.step;
    s.t0 = Date.now();
    if (
      step.effect === "external" &&
      !allowExternal(root, step.id, step.run ?? step.tool ?? "")
    ) {
      const prompt = step.prompt ? fill(step.prompt) : undefined;
      s.note = hold(root, runId, step.id, { step: { ...step, prompt } });
      s.status = "held";
      return;
    }
    const tried = new Set<string>();
    const pool =
      step.do === "tool"
        ? hostsFor(step).filter((h) => h.local)
        : hostsFor(step);
    if (!pool.length) {
      s.output = `no host available for ${JSON.stringify(step.hosts ?? step.role ?? step.do)} (${step.do === "tool" ? "relay tool: local host" : "fleet.toml"})`;
      s.status = "failed";
      return;
    }
    for (const h of pool) {
      if (tried.has(h.id)) continue;
      tried.add(h.id);
      while ((busy.get(h.id) ?? 0) >= h.maxAgents && !stopped)
        await Bun.sleep(500);
      if (stopped) break;
      busy.set(h.id, (busy.get(h.id) ?? 0) + 1);
      s.host = h.id;
      emit("start", { step: step.id, do: step.do, host: h.id });
      try {
        if (step.do === "cmd") {
          if (await cmdStep(s, h)) return void (s.status = "done");
          const last = s.tries.at(-1)!;
          if (last.cls === "missing") continue; // checkout or tool missing: next host
          s.status = "failed";
          return;
        }
        if (step.do === "tool") {
          s.status = (await toolStep(s, h)) ? "done" : "failed";
          return;
        }
        const rs = await runner(h);
        // Bridge models only in local direct execution; the queue receives CLIs the runner can launch.
        const role = step.role ?? DEFAULT_ROLE.agent;
        const all = await candidates(
          h,
          rs,
          h.local && !rs.roles.includes(role),
        );
        const providers = rank(h.id, all, step.needs ?? {}, health, rs.cooling);
        emit("route", { step: step.id, host: h.id, providers });
        if (!providers.length) {
          s.tries.push({
            host: h.id,
            ok: false,
            cls: "missing",
            ms: 0,
            via: "inline",
          });
          s.output = `no engine fits on ${h.id}`;
          continue;
        }
        const r = await agentStep(s, h, providers);
        if (r === "ok") return void (s.status = "done");
        if (r === "fail") return void (s.status = "failed");
      } finally {
        busy.set(h.id, (busy.get(h.id) ?? 1) - 1);
      }
    }
    s.status = "failed";
  }

  // ---------- after a step ----------
  function expand(s: State) {
    if (!s.step.expand || s.status !== "done") return;
    if (s.depth + 1 > L.maxDepth)
      return emit("expand-refused", { step: s.step.id, reason: "profondeur" });
    const fenced = s.output.match(/```json\s*([\s\S]*?)```/)?.[1];
    const text = fenced ?? balancedSteps(s.output);
    if (!text) return;
    let spec: any;
    try {
      spec = JSON.parse(text);
    } catch {
      return emit("expand-refused", {
        step: s.step.id,
        reason: "JSON invalide",
      });
    }
    const raw: any[] = Array.isArray(spec?.steps) ? spec.steps : [];
    const local = new Set(raw.map((x) => String(x?.id ?? "")));
    const prefix = `${s.step.id}.`;
    const ROLES = [
      "coder",
      "reviewer",
      "tester",
      "linter",
      "designer",
      "deployer",
      "sre",
      "growth",
    ];
    const added: string[] = [];
    let prevEdit: string | undefined;
    for (const x of raw) {
      if (
        !x ||
        typeof x.id !== "string" ||
        !["agent", "cmd", "tool"].includes(x.do)
      )
        continue;
      const child: Step = {
        id: prefix + x.id,
        do: x.do,
        prompt: typeof x.prompt === "string" ? x.prompt : undefined,
        run: typeof x.run === "string" ? x.run : undefined,
        repo: x.repo === false ? false : undefined,
        timeout_s:
          typeof x.timeout_s === "number"
            ? Math.min(x.timeout_s, 7200)
            : undefined,
        tool: typeof x.tool === "string" ? x.tool : undefined,
        args: x.args && typeof x.args === "object" ? x.args : undefined,
        role: ROLES.includes(x.role) ? x.role : undefined,
        hosts: Array.isArray(x.hosts) ? x.hosts.map(String) : undefined,
        needs: x.needs && typeof x.needs === "object" ? x.needs : undefined,
        check: typeof x.check === "string" ? x.check : undefined,
        // A generated step inherits the parent's restrictions: no external effect lifted, no commit outside the parent's.
        effect:
          x.effect === "external" || s.step.effect === "external"
            ? "external"
            : undefined,
        // Commit bounded to the parent's paths, never beyond.
        commit: s.step.commit
          ? {
              paths: s.step.commit.paths,
              message: String(x.commit?.message ?? s.step.commit.message),
            }
          : undefined,
        expand: x.expand === true,
        onFail: ["fix", "stop", "continue"].includes(x.onFail)
          ? x.onFail
          : undefined,
        deps: [
          s.step.id,
          ...(Array.isArray(x.deps)
            ? x.deps
                .filter((d: unknown) => typeof d === "string" && local.has(d))
                .map((d: string) => prefix + d)
            : []),
        ],
      };
      // Generated steps that modify the same checkout run in sequence instead of overwriting each other.
      const edits = child.do === "agent" && child.needs?.edit === true;
      if (edits && prevEdit && !child.deps!.includes(prevEdit))
        child.deps!.push(prevEdit);
      try {
        add(child, s.depth + 1);
        added.push(child.id);
        if (edits) prevEdit = child.id;
        emit("expand", { parent: s.step.id, step: child.id, do: child.do });
      } catch (e: any) {
        emit("expand-refused", { step: child.id, reason: e.message });
        break;
      }
    }
    // Steps that waited on the parent also wait on what it spawned.
    for (const o of st.values())
      if (
        o.status === "pending" &&
        !added.includes(o.step.id) &&
        o.step.deps?.includes(s.step.id)
      )
        o.step = { ...o.step, deps: [...o.step.deps, ...added] };
  }

  function repair(s: State) {
    if (
      s.status !== "failed" ||
      s.step.onFail === "stop" ||
      s.step.onFail === "continue"
    )
      return;
    if (s.step.do !== "cmd" || s.fixes >= L.fixRounds) return;
    if (s.tries.at(-1)?.cls === "missing") return; // host, checkout or tool missing: nothing to fix in the code
    if (s.step.repo === false) return; // outside a checkout: no code to fix
    s.fixes++;
    const fix: Step = {
      id: `${s.step.id}#fix${s.fixes}`,
      do: "agent",
      role: "coder",
      needs: { edit: true },
      // Failing host first, then any host with a coder worker (checkouts synced by git).
      hosts: s.host
        ? [s.host, ...fleet.map((h) => h.id).filter((id) => id !== s.host)]
        : undefined,
      prompt: `The command \`${s.step.run}\` fails on ${s.host} (output below). Fix the cause with the smallest change, without disabling any check.\n\n${s.output.slice(-6000)}`,
      check: s.step.run,
      commit:
        s.step.commit ??
        (wf.paths?.length
          ? {
              paths: wf.paths,
              message: `${wf.paths[0]}: fix for "${s.step.id}"`,
            }
          : undefined),
      onFail: "stop",
    };
    try {
      add(fix, s.depth);
      s.fixedBy = fix.id;
      emit("fix-ticket", { step: s.step.id, ticket: fix.id });
    } catch (e: any) {
      emit("fix-refused", { step: s.step.id, reason: e.message });
    }
  }

  function writeOut(s: State) {
    if (s.status !== "done" || !s.step.out) return;
    const rel = normalize(s.step.out).replace(/\\/g, "/");
    if (!/^(docs\/reviews|var)\//.test(rel) || rel.includes(".."))
      return emit("out-refused", { step: s.step.id, out: rel });
    const f = join(root, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, s.output.endsWith("\n") ? s.output : `${s.output}\n`);
    emit("out", { step: s.step.id, out: rel });
  }

  // ---------- boucle ----------
  const running = new Map<string, Promise<string>>();
  emit("run", {
    workflow: wf.name,
    steps: wf.steps.length,
    hosts: fleet.map((h) => h.id),
    limits: L,
  });
  while (true) {
    let progressed = false;
    if (!stopped && Date.now() - t0 > L.deadlineMs) stopped = "deadline";
    if (!stopped && spentUsd > L.budgetUsd) stopped = "budget $";
    if (!stopped && tokens > L.tokenBudget) stopped = "budget de jetons";
    if (!stopped && consecutive >= L.maxConsecutiveFailures)
      stopped = `${consecutive} consecutive failures`;
    for (const s of st.values()) {
      if (s.status !== "pending" || running.has(s.step.id)) continue;
      if (stopped) {
        s.status = "skipped";
        s.note = stopped;
        continue;
      }
      const deps = (s.step.deps ?? []).map(resolve);
      if (deps.some((d) => d.status === "pending" || d.status === "running"))
        continue;
      // Any other outcome changes the step state (skipped, finished in dry-run, launched).
      progressed = true;
      const blocked = deps.find(
        (d) =>
          d.status !== "done" &&
          !(d.status === "failed" && d.step.onFail === "continue"),
      );
      if (blocked) {
        s.status = "skipped";
        s.note = `dependency ${blocked.step.id}: ${blocked.status}`;
        continue;
      }
      if (o.dryRun) {
        s.status = "done";
        s.output = `[dry-run] ${s.step.do} ${s.step.run ?? s.step.tool ?? (s.step.prompt ?? "").slice(0, 80)}`;
        continue;
      }
      s.status = "running";
      running.set(
        s.step.id,
        execute(s)
          .catch((e) => {
            s.status = "failed";
            s.output = String(e?.message ?? e);
          })
          .then(() => s.step.id),
      );
    }
    if (!running.size) {
      const left = [...st.values()].filter((s) => s.status === "pending");
      if (!left.length) break;
      if (progressed) continue;
      for (const s of left) {
        s.status = "skipped";
        s.note = "circular dependency";
      }
      stopped = "circular dependency";
      break;
    }
    const id = await Promise.race(running.values());
    running.delete(id);
    const s = st.get(id)!;
    s.ms = Date.now() - (s.t0 ?? Date.now());
    emit("end", {
      step: id,
      status: s.status,
      host: s.host,
      provider: s.provider,
      ms: s.ms,
      tries: s.tries.length,
    });
    writeOut(s);
    expand(s);
    repair(s);
    // A failure handled by a fix ticket does not count toward the stop on repeated failures.
    consecutive =
      s.status === "failed" && !s.fixedBy
        ? consecutive + 1
        : s.status === "done"
          ? 0
          : consecutive;
  }
  health.close();

  const steps = [...st.values()].map((s) => ({
    id: s.step.id,
    do: s.step.do,
    status: s.status,
    host: s.host,
    provider: s.provider,
    ms: s.ms,
    tries: s.tries,
    fixedBy: s.fixedBy,
    note: s.note,
    output: s.output.slice(0, 600),
  }));
  const final = (s: State) => resolve(s.step.id).status;
  // A skipped step is never a success; a tolerated failure (onFail: continue) is.
  const ok =
    !stopped &&
    [...st.values()].every(
      (s) =>
        ["done", "held"].includes(final(s)) ||
        (final(s) === "failed" && s.step.onFail === "continue"),
    );
  const report = {
    run: runId,
    workflow: wf.name,
    ok,
    stopped,
    ms: Date.now() - t0,
    spent: { usd_reserved: spentUsd, tokens },
    hosts: [...new Set(steps.map((s) => s.host).filter(Boolean))],
    providers: [
      ...new Set(
        steps.flatMap((s) => s.tries.map((t) => t.provider)).filter(Boolean),
      ),
    ],
    log: logFile,
    steps,
  };
  emit("report", { ok, stopped });
  return report;
}
