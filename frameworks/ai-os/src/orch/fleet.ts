// Orchestrator hosts and bounded execution on each.
// Sources: tools/agents/fleet.toml (hosts, roles, runner `src` checkout, labs-1b layer) and device/deploy.toml
// (`ssh_alias`). fr1 (`build` role in fleet.toml) receives builds, containers and heavy agents; prd: production backends.
// Everything runs at low priority: `nice -n 19` + `timeout` remotely, BELOW_NORMAL locally (inherited by children).
import { existsSync, readFileSync } from "node:fs";
import { constants, hostname, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandSync } from "../../../../system/env-kit/src/discover.ts";

export type Host = {
  id: string; // nom de fleet.toml : pc, prd, fr2
  local: boolean;
  ssh?: string; // alias ssh (deploy.toml ssh_alias)
  // ssh targets tried in order (fleet.toml `ssh`: <host>-mesh = sshd over the mTLS TCP mesh 7444,
  // device/cluster, independent of WireGuard; then direct ssh). Fallback only if ssh fails to connect (255).
  sshTargets?: string[];
  src: string; // runner checkout on the host
  roles: string[];
  maxAgents: number; // simultaneous tasks handed out by the orchestrator
};

export type ExecResult = {
  code: number;
  out: string;
  err: string;
  ms: number;
};

/** src root: $SRC_ROOT, otherwise the ancestor that contains src.lock.json. */
export function srcRoot(): string {
  if (Bun.env.SRC_ROOT) return resolve(Bun.env.SRC_ROOT);
  let d = import.meta.dir;
  while (!existsSync(join(d, "src.lock.json"))) {
    const up = dirname(d);
    if (up === d) return resolve(import.meta.dir, "../../../..");
    d = up;
  }
  return d;
}

const toml = (p: string): any =>
  existsSync(p) ? Bun.TOML.parse(expandSync(readFileSync(p, "utf8"))) : {};

const WIN = process.platform === "win32";
/** fleet.toml id of the current machine (AGENTS_HOST takes precedence). */
export const selfId = () => Bun.env.AGENTS_HOST ?? (WIN ? "pc" : hostname());

/** Strictly positive integer, otherwise the default value. */
const posInt = (v: unknown, d: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : d;
};

export function hosts(root = srcRoot()): Host[] {
  const fleet = toml(join(root, "tools/agents/fleet.toml"));
  const deploy = toml(join(root, "device/deploy.toml"));
  const nodes = Object.entries<any>(deploy.nodes ?? {});
  const me = selfId();
  const out: Host[] = [];
  for (const [id, h] of Object.entries<any>(fleet.hosts ?? {})) {
    const node =
      nodes.find(([n]) => n === id) ??
      nodes.find(([, n]) => n.ssh_alias === id);
    const local = id === me;
    if (!local && typeof h.src !== "string") continue; // runner checkout unknown
    const cap = posInt(
      Bun.env[`ORCH_MAX_AGENTS_${id.toUpperCase()}`] ?? Bun.env.ORCH_MAX_AGENTS,
      local ? 3 : 2,
    );
    out.push({
      id,
      local,
      ssh: local ? undefined : (node?.[1].ssh_alias ?? id),
      sshTargets: local
        ? undefined
        : [
            ...new Set<string>([
              ...(Array.isArray(h.ssh) ? h.ssh : []),
              node?.[1].ssh_alias ?? id,
            ]),
          ],
      src: local ? root : h.src,
      roles: h.roles ?? [],
      maxAgents: cap,
    });
  }
  // Machine missing from fleet.toml: added locally.
  if (!out.some((h) => h.local))
    out.unshift({
      id: me,
      local: true,
      src: root,
      roles: [],
      maxAgents: posInt(Bun.env.ORCH_MAX_AGENTS, 3),
    });
  return out;
}

/** Build and container host: first fleet.toml host that carries the `build` role (fr1). */
export function buildHost(root = srcRoot()): string {
  const fleet = toml(join(root, "tools/agents/fleet.toml"));
  const id = Object.entries<any>(fleet.hosts ?? {}).find(
    ([, h]) => Array.isArray(h.roles) && h.roles.includes("build"),
  )?.[0];
  if (!id) throw new Error("fleet.toml: no host with the build role");
  return id;
}

/** Guillemets sh : 'a'\''b'. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** argv command on a host, from its `src` checkout (or relative `cwd`), bounded timeout, low priority. */
export async function exec(
  h: Host,
  argv: string[],
  o: {
    cwd?: string;
    stdin?: string;
    timeoutMs?: number;
    raw?: boolean;
    home?: boolean;
  } = {},
): Promise<ExecResult> {
  const t0 = performance.now();
  const timeoutMs = o.timeoutMs ?? 600_000;
  let cmds: string[][];
  let cwd: string | undefined;
  if (h.local) {
    cmds = [argv];
    cwd = o.home ? undefined : resolve(h.src, o.cwd ?? ".");
  } else {
    const dir = o.cwd ? `${h.src}/${o.cwd}` : h.src;
    const body = o.raw
      ? argv.join(" ")
      : `exec nice -n 19 timeout -k 10 ${Math.ceil(timeoutMs / 1000)} ${argv.map(shq).join(" ")}`;
    const remote = o.home
      ? `cd; ${body}`
      : o.raw
        ? `cd ${shq(dir)} 2>/dev/null; ${body}`
        : `cd ${shq(dir)} || { printf 'checkout missing: %s\\n' ${shq(dir)} >&2; exit 127; }; ${body}`;
    cmds = (h.sshTargets ?? [h.ssh!]).map((t) => [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      t,
      remote,
    ]);
  }
  let r: ExecResult = { code: 255, out: "", err: "no ssh target", ms: 0 };
  for (const cmd of cmds) {
    r = await run(cmd);
    if (h.local || r.code !== 255) return r; // 255 = connexion ssh impossible : cible suivante
  }
  return r;

  async function run(cmd: string[]): Promise<ExecResult> {
    try {
      const p = Bun.spawn(cmd, {
        cwd,
        stdin: o.stdin !== undefined ? Buffer.from(o.stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs + 15_000,
      });
      if (h.local && p.pid)
        try {
          setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {}
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      // 124 only if the timeout is reached; another signal (OOM, crash) stays an ordinary failure.
      const late = performance.now() - t0 >= timeoutMs;
      return {
        code: p.signalCode ? (late ? 124 : 128 + 9) : code,
        out,
        err,
        ms: Math.round(performance.now() - t0),
      };
    } catch (e) {
      return {
        code: 127,
        out: "",
        err: e instanceof Error ? e.message : String(e),
        ms: Math.round(performance.now() - t0),
      };
    }
  }
}

/** sh command line (for `check` and `cmd` steps written as text). */
export const shell = (
  h: Host,
  line: string,
  timeoutMs?: number,
  home = false,
) =>
  h.local
    ? exec(
        h,
        WIN ? [Bun.which("niu") ?? "sh", "-c", line] : ["sh", "-c", line],
        {
          timeoutMs,
          home,
        },
      )
    : exec(h, ["sh", "-c", line], { timeoutMs, home });

/** Agent CLIs present on the host (a single ssh connection). */
export async function clisOn(h: Host, names: string[]): Promise<string[]> {
  if (h.local) return names.filter((n) => Bun.which(n));
  const r = await exec(
    h,
    [
      `for c in ${names.map(shq).join(" ")}; do command -v $c >/dev/null 2>&1 && echo $c; done`,
    ],
    { raw: true, timeoutMs: 20_000 },
  );
  return r.out.split(/\s+/).filter((n) => names.includes(n));
}
