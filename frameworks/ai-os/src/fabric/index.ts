// Distributed inference fabric: a coordinator llama-server (the PC's CUDA GPU) that delegates layers to
// ggml-rpc-server reached only over WireGuard (llama.cpp RPC backend, upstream tools/rpc/README.md).
// Configuration: tools/ai/fabric.toml. Linux nodes: tools/ai/fabric/node.sh (capped transient systemd unit,
// admission condition checked continuously). Health: orch/health.ts (host = node, provider = "fabric-rpc").
// The served model appears in llm_models as `fabric/<alias>` (llm/models.ts), gone as soon as the coordinator drops.
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { selfId, shq, srcRoot } from "../orch/fleet";
import { Health } from "../orch/health";
import { expandSync } from "../../../../system/env-kit/src/discover.ts";

export type Asset = { asset: string; sha256: string };
export type FabricNode = {
  id: string;
  os: "windows" | "linux";
  role?: "coordinator";
  ssh?: string;
  bind?: string;
  reach?: string;
  port?: number;
  threads?: number;
  cpu_quota?: string;
  memory_max?: string;
  gate?: string;
  heavy_lock?: string;
  priority_url?: string;
  watch_s?: number;
  enabled?: boolean;
  /** Relative share of the layers handed to this node (coordinator: local devices). */
  share?: number;
};
export type Fabric = {
  coordinator: {
    node: string;
    host: string;
    port: number;
    model: string;
    ctx: number;
    cache: string;
    mesh: string[];
  };
  release: { tag: string; commit: string } & Record<string, Asset | string>;
  model: Record<
    string,
    { path: string; bytes: number; sha256: string; url?: string }
  >;
  node: FabricNode[];
  /** Short distributed trial launched by `ensure` as soon as a listed node passes admission (once per node). */
  trial?: { nodes: string[]; model: string; split: number[]; tokens: number };
};
export type NodeState = {
  id: string;
  admitted: boolean;
  reason?: string;
  endpoint?: string;
  status?: any;
};

const PROVIDER = "fabric-rpc";
const expand = (p: string) => p.replace(/^~(?=$|[\\/])/, homedir());
const dataDir = () => expand("~/.local/share/ay/ai");
const statePath = () => join(dataDir(), "fabric.json");

export function loadFabric(root = srcRoot()): Fabric {
  const p = Bun.env.AI_FABRIC_CONFIG ?? join(root, "tools/ai/fabric.toml");
  const f = Bun.TOML.parse(expandSync(readFileSync(p, "utf8"))) as any;
  f.coordinator.mesh ??= [];
  f.node ??= [];
  return f as Fabric;
}

/** OpenAI-compatible URL of the coordinator (llm/models.ts also reads it through AI_FABRIC_URL). */
export const coordinatorUrl = (f: Fabric) =>
  `http://${f.coordinator.host}:${f.coordinator.port}`;

// ------------------------------------------------------------------------------------------------
// Linux nodes: node.sh sent on stdin, then run with the node's parameters.

function nodeEnv(f: Fabric, n: FabricNode): Record<string, string> {
  const rel = f.release[`${n.os}-x86_64`] as Asset;
  return {
    TAG: f.release.tag,
    ASSET: rel.asset,
    SHA: rel.sha256,
    BIND: n.bind ?? "",
    PORT: String(n.port ?? 50052),
    THREADS: String(n.threads ?? 2),
    CPU: n.cpu_quota ?? "100%",
    MEM: n.memory_max ?? "2G",
    GATE: n.gate ?? "always",
    LOCK: n.heavy_lock ?? "",
    PRIO: n.priority_url ?? "",
    WATCH: String(n.watch_s ?? 10),
    COORD: f.coordinator.mesh.join(", "),
    ...modelEnv(f),
  };
}

/** Coordinator GGUF for `warm`: same bytes everywhere (sha256), pulled by each node from `url`. */
const modelEnv = (f: Fabric): Record<string, string> => {
  const m = f.model[f.coordinator.model];
  return m?.url
    ? { MODEL_URL: m.url, MODEL_SHA: m.sha256, MODEL_FILE: m.path }
    : {};
};

/** Ligne sh distante : root, sinon sudo -n ; installe node.sh puis lance l'action. */
export function remoteLine(env: Record<string, string>, action: string) {
  const kv = Object.entries(env)
    .map(([k, v]) => `${k}=${shq(v)}`)
    .join(" ");
  return [
    `S=; [ "$(id -u)" = 0 ] || S="sudo -n"`,
    `$S mkdir -p /opt/aphrody/fabric`,
    // Atomic rename: a running unit still reads the old file (sh reads its script as it goes).
    `$S tee /opt/aphrody/fabric/node.sh.new >/dev/null`,
    `$S mv -f /opt/aphrody/fabric/node.sh.new /opt/aphrody/fabric/node.sh`,
    `exec $S env ${kv} sh /opt/aphrody/fabric/node.sh ${shq(action)}`,
  ].join(" && ");
}

async function nodeSh(
  root: string,
  f: Fabric,
  n: FabricNode,
  action: string,
  timeoutMs = 180_000,
) {
  const script = readFileSync(join(root, "tools/ai/fabric/node.sh"));
  const p = Bun.spawn(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      n.ssh ?? n.id,
      remoteLine(nodeEnv(f, n), action),
    ],
    { stdin: script, stdout: "pipe", stderr: "pipe", timeout: timeoutMs },
  );
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

/** Reachable TCP port (Windows node, or check after startup). */
export async function reachable(host: string, port: number, ms = 3000) {
  if (!host) return false;
  return await new Promise<boolean>((done) => {
    const t = setTimeout(() => done(false), ms);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(s) {
          clearTimeout(t);
          s.end();
          done(true);
        },
        error() {
          clearTimeout(t);
          done(false);
        },
        data() {},
      },
    }).catch(() => {
      clearTimeout(t);
      done(false);
    });
  });
}

const enabledIds = (f: Fabric) =>
  f.node.filter((n) => n.enabled !== false).map((n) => n.id);
const workers = (f: Fabric, only?: string[]) =>
  f.node.filter(
    (n) =>
      n.role !== "coordinator" &&
      // --only names a node explicitly: it is tried even when disabled by default (fr2).
      (only?.length ? only.includes(n.id) : n.enabled !== false),
  );

// ------------------------------------------------------------------------------------------------
// Coordinator: verified official CUDA binary (sha256 = GitHub digest), never compiled here.

const toolDir = (f: Fabric) =>
  expand(
    `~/.local/share/ay/tools/llama.cpp/${f.release.tag.replace(/^b/, "")}-cuda`,
  );

async function sha256File(p: string) {
  const h = new Bun.CryptoHasher("sha256");
  for await (const c of createReadStream(p)) h.update(c as Buffer);
  return h.digest("hex");
}

export async function ensureCoordinatorBin(f: Fabric): Promise<string> {
  const dir = toolDir(f);
  const exe = join(
    dir,
    process.platform === "win32" ? "llama-server.exe" : "llama-server",
  );
  if (existsSync(exe)) return exe;
  if (process.platform !== "win32")
    throw new Error(
      "coordinator planned on the Windows GPU host (fabric.toml [coordinator])",
    );
  mkdirSync(dir, { recursive: true });
  for (const key of ["windows-x86_64", "windows-x86_64-cudart"]) {
    const a = f.release[key] as Asset;
    const zip = join(dir, a.asset);
    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${f.release.tag}/${a.asset}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
    await Bun.write(zip, r);
    const got = await sha256File(zip);
    if (got !== a.sha256) {
      rmSync(zip);
      throw new Error(`${a.asset} : sha256 ${got} != ${a.sha256}`);
    }
    const x = Bun.spawnSync(["tar", "-xf", zip, "-C", dir]);
    rmSync(zip);
    if (x.exitCode !== 0)
      throw new Error(`extraction de ${a.asset} : ${x.stderr}`);
  }
  return exe;
}

export function modelPath(
  f: Fabric,
  alias = f.coordinator.model,
  verify = false,
) {
  const m = f.model[alias];
  if (!m) throw new Error(`unknown model in fabric.toml: ${alias}`);
  const p = join(expand(f.coordinator.cache), m.path);
  if (!existsSync(p))
    throw new Error(`GGUF missing: ${p} (ay ai pull ollama, then hard link)`);
  if (statSync(p).size !== m.bytes)
    throw new Error(`${p} : ${statSync(p).size} octets, attendu ${m.bytes}`);
  return { path: p, sha256: verify ? sha256File(p) : undefined };
}

/** -ts in llama.cpp device order: RPC nodes (--rpc order) then the local device (CUDA0).
 *  Empty if a share is missing: llama.cpp then splits by free memory (a VPS CPU would win). */
export function tensorSplit(f: Fabric, admitted: string[]): number[] {
  const by = (id: string) => f.node.find((n) => n.id === id)?.share;
  const parts = [...admitted.map(by), by(f.coordinator.node)];
  return admitted.length && parts.every((x) => typeof x === "number" && x >= 0)
    ? (parts as number[])
    : [];
}

/** Coordinator arguments for a list of admitted RPC nodes. */
export function coordinatorArgs(
  f: Fabric,
  model: string,
  rpc: string[],
  split: number[] = [],
) {
  const c = f.coordinator;
  return [
    "-m",
    model,
    "--alias",
    c.model,
    "-ngl",
    "999",
    "-c",
    String(c.ctx),
    "--host",
    c.host,
    "--port",
    String(c.port),
    "--jinja",
    "--metrics",
    "--no-webui",
    ...(rpc.length ? ["--rpc", rpc.join(",")] : []),
    ...(split.length ? ["-ts", split.join(",")] : []),
  ];
}

type State = {
  pid: number;
  started: string;
  rpc: string[];
  nodes: NodeState[];
  args: string[];
  tag: string;
  model?: string;
};
const readState = (): State | null => {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitHealthy(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (r?.ok) return true;
    await Bun.sleep(1000);
  }
  return false;
}

async function stopCoordinator() {
  const s = readState();
  if (s && alive(s.pid)) {
    process.kill(s.pid);
    for (let i = 0; i < 20 && alive(s.pid); i++) await Bun.sleep(250);
  }
}

// ------------------------------------------------------------------------------------------------
// Commandes

export type UpOpts = {
  only?: string[];
  split?: number[];
  local?: boolean;
  noWarm?: boolean;
  /** [model.*] alias (default: coordinator.model); kept in the state for status, bench and ensure. */
  model?: string;
};

/** Configuration with the model actually served (state of the last `up`). */
const served = (root: string) => {
  const f = loadFabric(root);
  const m = readState()?.model;
  if (m && f.model[m]) f.coordinator.model = m;
  return f;
};

/** Admits the nodes (condition + health), starts their rpc-servers, then the coordinator with --rpc. */
export async function up(o: UpOpts = {}, root = srcRoot()) {
  const f = loadFabric(root);
  if (o.model) {
    if (!f.model[o.model])
      throw new Error(`unknown model in fabric.toml: ${o.model}`);
    f.coordinator.model = o.model;
  }
  const health = new Health();
  const nodes: NodeState[] = [];
  if (!o.local)
    for (const n of workers(f, o.only)) {
      const endpoint = `${n.reach}:${n.port ?? 50052}`;
      const cool = health.cooling(n.id, PROVIDER);
      if (cool) {
        nodes.push({
          id: n.id,
          admitted: false,
          reason: `refroidissement (${cool})`,
        });
        continue;
      }
      if (n.os === "windows") {
        const ok = await reachable(n.reach ?? "", n.port ?? 50052);
        nodes.push({
          id: n.id,
          admitted: ok,
          endpoint,
          reason: ok
            ? undefined
            : n.reach
              ? "rpc-server injoignable"
              : "not declared (empty reach)",
        });
        continue;
      }
      const t0 = performance.now();
      const r = await nodeSh(root, f, n, "up");
      let ok =
        r.code === 0 && (await reachable(n.reach ?? "", n.port ?? 50052, 5000));
      // Tensor cache filled from the node's local copy before the coordinator loads the model.
      if (ok && !o.noWarm && modelEnv(f).MODEL_URL) {
        const w = await nodeSh(root, f, n, "warm", 3_600_000);
        if (w.code !== 0) r.out += `\nwarm : ${w.out || w.err}`;
        ok = w.code === 0;
      }
      const ms = Math.round(performance.now() - t0);
      // Refusal by condition (75) = expected, not a health failure; ssh/install failure = cooldown.
      if (r.code !== 75)
        health.record(n.id, PROVIDER, ok, ok ? null : "overload", ms);
      nodes.push({
        id: n.id,
        admitted: ok,
        endpoint,
        reason: ok
          ? undefined
          : (r.out || r.err).split("\n").slice(-3).join(" | "),
      });
    }
  const admitted = nodes.filter((n) => n.admitted);
  const rpc = admitted.map((n) => n.endpoint!);
  await stopCoordinator();
  const exe = await ensureCoordinatorBin(f);
  const model = modelPath(f).path;
  const split =
    o.split ??
    tensorSplit(
      f,
      admitted.map((n) => n.id),
    );
  const args = coordinatorArgs(
    f,
    model,
    rpc,
    split.length === 1 + rpc.length ? split : [],
  );
  mkdirSync(dataDir(), { recursive: true });
  const log = openSync(join(dataDir(), "fabric.log"), "w");
  const p = Bun.spawn([exe, ...args], {
    stdio: ["ignore", log, log],
    detached: true,
    env: { ...Bun.env, GGML_RPC_NO_RDMA: "1" },
  } as any);
  p.unref();
  const state: State = {
    pid: p.pid,
    started: new Date().toISOString(),
    rpc,
    nodes,
    args,
    tag: f.release.tag,
    model: f.coordinator.model,
  };
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
  const ok = await waitHealthy(coordinatorUrl(f), 600_000);
  health.record(
    selfId(),
    `fabric/${f.coordinator.model}`,
    ok,
    ok ? null : "overload",
    0,
  );
  health.close();
  return {
    ok,
    url: `${coordinatorUrl(f)}/v1`,
    model: `fabric/${f.coordinator.model}`,
    ...state,
  };
}

const trialsPath = () => join(dataDir(), "fabric-trials.jsonl");
const lockPath = () => join(dataDir(), "fabric-ensure.lock");

/** Logged trials (one JSON line per trial). */
export function trials(): any[] {
  try {
    return readFileSync(trialsPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** A single `ensure` at a time (timer every 10 min, trial of several minutes); lock stale after 1 h. */
function takeLock(): boolean {
  mkdirSync(dataDir(), { recursive: true });
  try {
    if (
      existsSync(lockPath()) &&
      Date.now() - statSync(lockPath()).mtimeMs > 3_600_000
    )
      rmSync(lockPath());
    writeFileSync(lockPath(), String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Short distributed trial with an admitted node, then exact return to the previous state; result logged. */
export async function trial(id: string, root = srcRoot()) {
  const f = loadFabric(root);
  const t = f.trial ?? {
    nodes: [],
    model: f.coordinator.model,
    split: [],
    tokens: 16,
  };
  const prev = readState();
  const n = f.node.find((x) => x.id === id)!;
  const t0 = new Date().toISOString();
  const r: any = { node: id, at: t0, model: t.model };
  try {
    const u = await up(
      { only: [id], model: t.model, split: t.split, noWarm: true },
      root,
    );
    r.admitted = u.nodes.find((x) => x.id === id) ?? null;
    r.rpc = u.rpc;
    if (u.ok && u.rpc.length) {
      r.bench = await bench("Explain how a CPU cache works.", t.tokens, root);
      if (n.os === "linux") {
        const st = await nodeSh(root, f, n, "status", 30_000);
        try {
          r.caps = JSON.parse(st.out);
        } catch {
          r.caps = st.out;
        }
      }
    }
    r.ok = !!(u.ok && u.rpc.length && r.bench?.ok);
  } catch (e) {
    r.ok = false;
    r.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (n.os === "linux")
      await nodeSh(root, f, n, "down", 60_000).catch(() => null);
    if (prev)
      await up(
        {
          model: prev.model,
          only: prev.nodes.filter((x) => x.admitted).map((x) => x.id),
          local: !prev.rpc.length,
        },
        root,
      ).catch(() => null);
    else await stopCoordinator();
  }
  r.ms = Date.now() - Date.parse(t0);
  appendFileSync(trialsPath(), JSON.stringify(r) + "\n");
  return r;
}

/** Timer: failover (silent coordinator -> `up` with the still-admitted nodes, otherwise GPU alone; nothing if the fabric was
 *  stopped by `down`), then opportunistic admission: each [trial] node without a successful trial is probed, and the short
 *  trial starts as soon as it passes its condition. */
export async function ensure(root = srcRoot()) {
  if (!takeLock()) return { action: "busy" };
  try {
    const f = loadFabric(root);
    const out: any = { action: "none" };
    const ok = !!(
      await fetch(`${coordinatorUrl(f)}/health`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null)
    )?.ok;
    const prev = readState();
    if (!ok && prev) {
      const h = new Health();
      for (const n of prev.nodes)
        if (n.admitted) h.record(n.id, PROVIDER, false, "overload", 0);
      h.close();
      Object.assign(out, {
        action: "restart",
        previous: prev.rpc,
        ...(await up({ model: prev.model }, root)),
      });
    }
    out.healthy = ok;
    const done = new Set(
      trials()
        .filter((x) => x.ok)
        .map((x) => x.node),
    );
    out.probes = [];
    for (const id of f.trial?.nodes ?? []) {
      if (done.has(id)) continue;
      const n = f.node.find((x) => x.id === id);
      if (!n) continue;
      const g =
        n.os === "linux"
          ? await nodeSh(root, f, n, "gate", 30_000)
          : {
              code: (await reachable(n.reach ?? "", n.port ?? 50052)) ? 0 : 1,
              out: "port muet",
              err: "",
            };
      const admit = g.code === 0;
      out.probes.push({
        id,
        admit,
        reason: admit ? undefined : g.out || g.err,
      });
      if (admit) out.trial = await trial(id, root);
    }
    return out;
  } finally {
    rmSync(lockPath(), { force: true });
  }
}

/** Windows scheduled task (current user, no elevation, `conhost --headless`: no window): `ai-os fabric ensure` every `every` minutes. */
export function timer(remove = false, every = 10, root = srcRoot()) {
  const name = "aphrody-fabric-ensure";
  if (process.platform !== "win32")
    throw new Error("timer planned on the Windows coordinator");
  const argv = remove
    ? ["schtasks", "/Delete", "/TN", name, "/F"]
    : [
        "schtasks",
        "/Create",
        "/F",
        "/SC",
        "MINUTE",
        "/MO",
        String(every),
        "/TN",
        name,
        "/TR",
        `conhost.exe --headless "${process.execPath}" "${join(root, "frameworks/ai-os/src/cli.ts")}" fabric ensure`,
      ];
  const p = Bun.spawnSync(argv);
  return {
    task: name,
    removed: remove,
    code: p.exitCode,
    out: (p.stdout.toString() + p.stderr.toString()).trim(),
  };
}

export async function status(root = srcRoot()) {
  const f = served(root);
  const s = readState();
  const url = coordinatorUrl(f);
  const healthy = !!(
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }).catch(
      () => null,
    )
  )?.ok;
  const nodes = await Promise.all(
    workers(f, [
      ...enabledIds(f),
      ...(s?.nodes ?? []).filter((n) => n.admitted).map((n) => n.id),
    ]).map(async (n) => {
      const port = n.port ?? 50052;
      const listening = await reachable(n.reach ?? "", port);
      if (n.os !== "linux") return { id: n.id, reach: n.reach, listening };
      const r = await nodeSh(root, f, n, "status", 30_000);
      let st: any = r.out;
      try {
        st = JSON.parse(r.out);
      } catch {}
      return {
        id: n.id,
        reach: n.reach,
        listening,
        status: st,
        err: r.err || undefined,
      };
    }),
  );
  return {
    coordinator: {
      url: `${url}/v1`,
      healthy,
      pid: s?.pid,
      alive: s ? alive(s.pid) : false,
      rpc: s?.rpc ?? [],
    },
    model: `fabric/${f.coordinator.model}`,
    nodes,
  };
}

/** Fills the tensor cache of active Linux nodes from their own copy of the GGUF (PC uplink spared). */
export async function warm(only?: string[], root = srcRoot()) {
  const f = loadFabric(root);
  if (!modelEnv(f).MODEL_URL)
    throw new Error(`model ${f.coordinator.model} has no url in fabric.toml`);
  return await Promise.all(
    workers(f, only)
      .filter((n) => n.os === "linux")
      .map(async (n) => ({
        id: n.id,
        ...(await nodeSh(root, f, n, "warm", 3_600_000)),
      })),
  );
}

export async function down(root = srcRoot()) {
  const f = loadFabric(root);
  await stopCoordinator();
  const nodes = await Promise.all(
    workers(
      f,
      f.node.map((n) => n.id),
    )
      .filter((n) => n.os === "linux")
      .map(async (n) => ({
        id: n.id,
        ...(await nodeSh(root, f, n, "down", 60_000)),
      })),
  );
  rmSync(statePath(), { force: true });
  return { stopped: true, nodes };
}

/** One real generation; tokens/s read from llama-server `timings`. */
export async function bench(prompt: string, n = 128, root = srcRoot()) {
  const f = served(root);
  const t0 = performance.now();
  const r = await fetch(`${coordinatorUrl(f)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: f.coordinator.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: n,
      temperature: 0,
      // Fixed length to compare throughputs: no early stop.
      ignore_eos: true,
    }),
    signal: AbortSignal.timeout(900_000),
  });
  const j: any = await r.json();
  const ms = Math.round(performance.now() - t0);
  const h = new Health();
  h.record(
    selfId(),
    `fabric/${f.coordinator.model}`,
    r.ok,
    r.ok ? null : "overload",
    ms,
  );
  h.close();
  return {
    ok: r.ok,
    ms,
    rpc: readState()?.rpc ?? [],
    prompt_tps: j.timings?.prompt_per_second,
    gen_tps: j.timings?.predicted_per_second,
    gen_tokens: j.timings?.predicted_n ?? j.usage?.completion_tokens,
    text: j.choices?.[0]?.message?.content?.slice(0, 120),
  };
}

/** Windows node (second GPU host): rpc-server in the foreground, bound to its WireGuard address. */
export async function serveNode(id: string, root = srcRoot()) {
  const f = loadFabric(root);
  const n = f.node.find((x) => x.id === id);
  if (!n?.bind)
    throw new Error(`node ${id} has no bind address in fabric.toml`);
  const exe = join(toolDir(f), "ggml-rpc-server.exe");
  await ensureCoordinatorBin(f);
  const p = Bun.spawn(
    [
      exe,
      "-H",
      n.bind,
      "-p",
      String(n.port ?? 50052),
      "-c",
      "-t",
      String(n.threads ?? 4),
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...Bun.env, GGML_RPC_NO_RDMA: "1" },
    },
  );
  return await p.exited;
}
