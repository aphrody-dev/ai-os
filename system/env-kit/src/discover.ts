// SPDX-License-Identifier: Apache-2.0
/**
 * Live discovery of the site: who the owner is, which hosts exist and how to reach them, from the protocols that
 * already answer (ssh config, ssh itself, WireGuard interfaces, DNS, TLS, HTTP, git, gh, gcloud). Nothing is stored in
 * the repository and nothing needs a hand-written inventory: the only per-machine input is ~/.ssh/config, where a
 * role (fr1, fr2, prd) is a `Host` alias. Results are cached in ~/.cache/aphrody/discover.json (TTL, stale on offline).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname, networkInterfaces, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "node:tls";

export interface Resolved {
  role: string;
  /** the ssh alias to dial: the role itself, a `Host` entry of ~/.ssh/config */
  ssh: string;
  /** address or name `ssh -G` resolves the alias to */
  address: string;
  user: string;
  port: number;
  proxyjump?: string;
  /** remote facts (need a reachable host) */
  hostname?: string;
  remoteRole?: string;
  public?: string;
  public6?: string;
  mesh?: string;
  meshAll?: string[];
}

export interface Run {
  (cmd: string[], timeoutMs?: number, env?: Record<string, string | undefined>): Promise<{ code: number; out: string }>;
}
export interface Dns {
  lookup(name: string): Promise<{ address: string; family: number }[]>;
  resolveSrv(name: string): Promise<{ name: string; port: number; priority: number; weight: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}
export interface Deps {
  run: Run;
  dns: Dns;
  cachePath: string;
  ttlMs: number;
  now: () => number;
  env: Record<string, string | undefined>;
}

export const realRun: Run = async (cmd, timeoutMs = 20_000, env) => {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, ...(env ? { env: env as Record<string, string> } : {}) });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  } catch {
    return { code: 127, out: "" };
  }
};

export async function realDns(): Promise<Dns> {
  const d = await import("node:dns/promises");
  return {
    lookup: (n) => d.lookup(n, { all: true }),
    resolveSrv: (n) => d.resolveSrv(n),
    resolveTxt: (n) => d.resolveTxt(n),
  };
}

export const defaultCachePath = (env: Record<string, string | undefined> = process.env) =>
  env.APHRODY_DISCOVER_CACHE || join(env.HOME || env.USERPROFILE || homedir(), ".cache", "aphrody", "discover.json");

export async function defaultDeps(): Promise<Deps> {
  return { run: realRun, dns: await realDns(), cachePath: defaultCachePath(), ttlMs: 3_600_000, now: Date.now, env: process.env };
}

/** `ssh -G <alias>` output -> the effective client configuration. */
export function parseSshG(out: string): { hostname?: string; user?: string; port?: number; proxyjump?: string } {
  const m = new Map<string, string>();
  for (const l of out.split(/\r?\n/)) {
    const i = l.indexOf(" ");
    if (i > 0 && !m.has(l.slice(0, i))) m.set(l.slice(0, i), l.slice(i + 1).trim());
  }
  const pj = m.get("proxyjump");
  return {
    hostname: m.get("hostname"),
    user: m.get("user"),
    port: m.has("port") ? Number(m.get("port")) : undefined,
    proxyjump: pj && pj !== "none" ? pj : undefined,
  };
}

const isPrivate4 = (a: string) => /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);

/** `ip -j addr` -> public addresses (global scope, not RFC 1918) and mesh addresses (tunnel interfaces: WireGuard has link_type none). */
export function parseIpAddr(json: string): { public?: string; public6?: string; mesh: string[] } {
  let ifs: any[] = [];
  try {
    ifs = JSON.parse(json);
  } catch {
    return { mesh: [] };
  }
  const out: { public?: string; public6?: string; mesh: string[] } = { mesh: [] };
  for (const itf of ifs) {
    const tunnel = itf.link_type === "none" || /^(wg|prod|tun)/.test(itf.ifname ?? "");
    for (const a of itf.addr_info ?? []) {
      if (a.scope !== "global") continue;
      if (tunnel && a.family === "inet") out.mesh.push(a.local);
      else if (!tunnel && a.family === "inet" && !isPrivate4(a.local)) out.public ??= a.local;
      else if (!tunnel && a.family === "inet6" && !/^f[cd]/i.test(a.local)) out.public6 ??= a.local;
    }
  }
  return out;
}

const SEP = "---aphrody-discover---";
export const REMOTE_PROBE = `hostname -f 2>/dev/null || hostname; echo ${SEP}; cat /etc/aphrody/role 2>/dev/null; echo ${SEP}; ip -j addr 2>/dev/null`;

export function parseRemote(out: string): Partial<Resolved> {
  const [host = "", role = "", ip = ""] = out.split(SEP).map((s) => s.trim());
  const a = parseIpAddr(ip);
  return { hostname: host || undefined, remoteRole: role || undefined, public: a.public, public6: a.public6, mesh: a.mesh[0], meshAll: a.mesh };
}

type Cache = Record<string, { at: number; value: unknown }>;
function readCache(d: Deps): Cache {
  try {
    return JSON.parse(readFileSync(d.cachePath, "utf8"));
  } catch {
    return {};
  }
}
function writeCache(d: Deps, c: Cache) {
  try {
    mkdirSync(dirname(d.cachePath), { recursive: true });
    writeFileSync(d.cachePath, JSON.stringify(c));
  } catch {
    /* a cache that cannot be written only costs a lookup */
  }
}
/** Cached value while fresh; computed value otherwise; the stale value when the computation fails or returns nothing (offline). */
async function cached<T>(d: Deps, key: string, compute: () => Promise<T | undefined>): Promise<T | undefined> {
  const c = readCache(d);
  const hit = c[key];
  if (hit && d.now() - hit.at < d.ttlMs) return hit.value as T;
  let v: T | undefined;
  try {
    v = await compute();
  } catch {
    v = undefined;
  }
  if (v !== undefined) {
    c[key] = { at: d.now(), value: v };
    writeCache(d, c);
    return v;
  }
  return hit?.value as T | undefined;
}

/** Resolves a role: ssh client config always, remote facts when `remote` (one ssh round trip, cached). */
export async function resolve(role: string, opts: { remote?: boolean } = { remote: true }, d?: Deps): Promise<Resolved> {
  d ??= await defaultDeps();
  const dd = d;
  if (role === "pc") return localHost();
  const base = await cached<Resolved>(dd, `role:${role}`, async () => {
    const g = await dd.run(["ssh", "-G", role], 10_000);
    if (g.code !== 0) return undefined;
    const c = parseSshG(g.out);
    const r: Resolved = { role, ssh: role, address: c.hostname ?? role, user: c.user ?? "", port: c.port ?? 22, proxyjump: c.proxyjump };
    if (!opts.remote) return r;
    const q = await dd.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", role, REMOTE_PROBE], 30_000);
    if (q.code === 0) Object.assign(r, parseRemote(q.out));
    return r;
  });
  if (!base) throw new Error(`cannot resolve role "${role}": add a Host ${role} entry to ~/.ssh/config`);
  return base;
}

/** The workstation itself: no ssh, its own interfaces (private 10.x addresses are the mesh tunnels). */
export function localHost(): Resolved {
  const mesh: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && a.address.startsWith("10.")) mesh.push(a.address);
  return { role: "pc", ssh: "pc", address: "localhost", user: userInfo().username, port: 22, hostname: osHostname(), mesh: mesh[0], meshAll: mesh };
}

/** SRV records of `_<service>._tcp.<zone>` as `host:port`, best priority first. */
export async function srv(service: string, zone: string, d?: Deps): Promise<string[]> {
  d ??= await defaultDeps();
  const r = await d.dns.resolveSrv(`_${service}._tcp.${zone}`);
  return r.sort((a, b) => a.priority - b.priority || b.weight - a.weight).map((x) => `${x.name}:${x.port}`);
}

/** The zone public names live in: APHRODY_ZONE, else the domain part of an ssh-resolved FQDN. */
export async function zone(d?: Deps): Promise<string | undefined> {
  d ??= await defaultDeps();
  if (d.env.APHRODY_ZONE) return d.env.APHRODY_ZONE;
  const fr = await resolve("fr2", { remote: true }, d).catch(() => undefined);
  const fq = fr?.hostname?.includes(".") ? fr.hostname : undefined;
  return fq?.split(".").slice(1).join(".") || undefined;
}

/** True when the TLS certificate served by `host:port` (SNI `servername`) covers `name` through its SAN. */
export async function certCovers(host: string, port: number, servername: string, name: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const san = String(s.getPeerCertificate().subjectaltname ?? "");
      s.end();
      const names = san.split(/,\s*/).map((x) => x.replace(/^DNS:/, ""));
      res(names.some((n) => n === name || (n.startsWith("*.") && name.endsWith(n.slice(1)) && !name.slice(0, -n.length + 1).includes("."))));
    });
    s.on("error", () => res(false));
    s.on("timeout", () => {
      s.destroy();
      res(false);
    });
  });
}

/** `/.well-known/aphrody/host` of a host: role, hostname, mesh, services (served by every host). */
export async function wellKnown(base: string, timeoutMs = 8000): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/.well-known/aphrody/host`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface Accounts {
  /** OVH /me: account id without the -ovh suffix, first and last name, e-mail */
  ovh?: { account: string; firstName?: string; lastName?: string; email?: string };
  cloudflareAccounts: string[];
  /** zone name -> zone id */
  zones: Record<string, string>;
  gcpProjectNumbers: Record<string, string>;
}

/** The well-known document of a role (served by nginx on the mesh, port 8399): role, hostname, mesh addresses, services. */
export async function hostInfo(role: string, d?: Deps): Promise<Record<string, unknown> | undefined> {
  const r = await resolve(role, { remote: true }, d).catch(() => undefined);
  const mesh = r?.mesh ?? r?.address;
  return mesh ? wellKnown(`http://${mesh}:8399`) : undefined;
}

/** A service endpoint `address:port`: SRV `_<service>._tcp.<zone>` whose `<role>.mesh` target is resolved through the role's mesh address. */
export async function serviceEndpoint(service: string, zoneName: string, d?: Deps): Promise<string | undefined> {
  d ??= await defaultDeps();
  const first = (await srv(service, zoneName, d).catch(() => []))[0];
  if (!first) return undefined;
  const [target, port] = first.split(":");
  const role = target!.replace(/\.mesh\.?$/, "");
  const r = await resolve(role, { remote: true }, d).catch(() => undefined);
  return r?.mesh ? `${r.mesh}:${port}` : undefined;
}

export interface Identity {
  name?: string;
  firstName?: string;
  email?: string;
  github?: string;
  orgs: string[];
  windows: { user?: string; home?: string; machine?: string };
  gcpProject?: string;
  emails?: string[];
  gcpProjects?: string[];
}

/** Owner identity from git, gh, gcloud and the OS; never stored in the repository. */
export async function identity(d?: Deps): Promise<Identity> {
  d ??= await defaultDeps();
  const dd = d;
  const v = await cached<Identity>(dd, "identity", async () => {
    // gh answers for the logged-in user only without an app installation token in the environment
    const userEnv = Object.fromEntries(Object.entries(dd.env).filter(([k]) => !/^(GH|GITHUB)_TOKEN$/.test(k)));
    const one = async (cmd: string[]) => {
      const r = await dd.run(cmd, 15_000, cmd[0] === "gh" ? userEnv : undefined);
      return r.code === 0 ? r.out.trim() || undefined : undefined;
    };
    const name = await one(["git", "config", "--global", "user.name"]);
    const gh = await one(["gh", "api", "user", "--jq", ".login"]);
    const orgs = ((await one(["gh", "api", "user/orgs", "--jq", ".[].login"])) ?? "").split(/\s+/).filter(Boolean);
    const gcp = await one(["gcloud", "config", "get-value", "project"]);
    const gcps = ((await one(["gcloud", "projects", "list", "--format=value(projectId)"])) ?? "").split(/\s+/).filter(Boolean);
    const env = dd.env;
    return {
      name,
      firstName: name?.split(/\s+/)[0],
      email: await one(["git", "config", "--global", "user.email"]),
      // an installation token cannot read /user: the git handle (user.name without spaces) stands in
      github: gh ?? (name && !/\s/.test(name) ? name : undefined),
      orgs,
      windows: { user: env.USERNAME ?? env.USER ?? userInfo().username, home: env.USERPROFILE ?? env.HOME ?? homedir(), machine: env.COMPUTERNAME ?? osHostname() },
      gcpProject: gcp,
      gcpProjects: gcps,
    } satisfies Identity;
  });
  return v ?? { orgs: [], windows: {} };
}

/** Cloudflare accounts and zones from the API (token from CLOUDFLARE_API_TOKEN) and GCP project numbers from gcloud. */
export async function accounts(d?: Deps): Promise<Accounts> {
  d ??= await defaultDeps();
  const dd = d;
  const v = await cached<Accounts>(dd, "accounts", async () => {
    const out: Accounts = { cloudflareAccounts: [], zones: {}, gcpProjectNumbers: {} };
    const token = dd.env.CLOUDFLARE_API_TOKEN;
    if (token) {
      const get = async (path: string) => {
        const r = await fetch("https://api.cloudflare.com/client/v4" + path, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(15_000) });
        return r.ok ? ((await r.json()) as { result?: any[] }).result ?? [] : [];
      };
      out.cloudflareAccounts = (await get("/accounts")).map((a) => a.id);
      for (const z of await get("/zones?per_page=50")) out.zones[z.name] = z.id;
    }
    // the CLI refuses to mix its own login with OVH_* application variables of the environment
    const noOvhEnv = Object.fromEntries(Object.entries(dd.env).filter(([k]) => !k.startsWith("OVH_")));
    const me = await dd.run(["ovhcloud", "account", "get", "-o", "json"], 20_000, noOvhEnv);
    if (me.code === 0) {
      try {
        const j = JSON.parse(me.out);
        if (j.nichandle) out.ovh = { account: String(j.nichandle).replace(/-ovh$/, ""), firstName: j.firstname || undefined, lastName: j.name || undefined, email: j.email || undefined };
      } catch {
        /* not logged in */
      }
    }
    const id = await identity(dd);
    for (const p of [id.gcpProject, ...(id.gcpProjects ?? [])].filter(Boolean) as string[]) {
      const r = await dd.run(["gcloud", "projects", "describe", p, "--format=value(projectNumber)"], 20_000);
      if (r.code === 0 && r.out.trim()) out.gcpProjectNumbers[p] = r.out.trim();
    }
    return Object.keys(out.zones).length || out.cloudflareAccounts.length || out.ovh ? out : undefined;
  });
  return v ?? { cloudflareAccounts: [], zones: {}, gcpProjectNumbers: {} };
}

const HOST_KEYS: Record<string, (r: Resolved) => string | undefined> = {
  ssh: (r) => r.ssh,
  user: (r) => r.user,
  port: (r) => String(r.port),
  address: (r) => r.address,
  hostname: (r) => r.hostname,
  public_ip: (r) => r.public ?? (/^\d+\.\d+\.\d+\.\d+$/.test(r.address) && !isPrivate4(r.address) ? r.address : undefined),
  public_ipv6: (r) => r.public6,
  mesh_ip: (r) => r.mesh,
  link_ip: (r) => r.meshAll?.[1],
  extra_mesh_ip: (r) => r.meshAll?.[1],
  src_root: () => "/srv/src",
};

/**
 * One value by dotted path, the vocabulary tokens and docs use: `hosts.<role>.<key>`, `identity.<key>`, `windows.<key>`.
 * Values are discovered, never read from a file.
 */
export async function discoverGet(path: string, d?: Deps): Promise<string | undefined> {
  const [sec, a, b] = path.split(".");
  if (sec === "hosts" && a && b) {
    const f = HOST_KEYS[b];
    if (!f) return undefined;
    return f(await resolve(a, { remote: true }, d));
  }
  if (sec === "accounts" && a === "ovh_account") return (await accounts(d)).ovh?.account;
  if (sec === "zones" && a) {
    const ac = await accounts(d);
    return ac.zones[path.slice("zones.".length)];
  }
  if (sec === "accounts" && a === "cloudflare_account_id") return (await accounts(d)).cloudflareAccounts[0];
  if (sec === "network" && a === "mesh_cidr") {
    const m = (await resolve("fr1", { remote: true }, d)).mesh;
    return m ? m.split(".").slice(0, 3).join(".") + ".0/24" : undefined;
  }
  const id = await identity(d);
  if (sec === "identity") {
    const m: Record<string, string | undefined> = { name: id.name, first_name: id.firstName, email: id.email, github_user: id.github };
    return m[a ?? ""];
  }
  if (sec === "windows") return ({ user: id.windows.user, home: id.windows.home, machine: id.windows.machine } as Record<string, string | undefined>)[a ?? ""];
  if (sec === "accounts" && a === "gcp_project") return id.gcpProject;
  if (sec === "accounts" && a === "gcp_project_number") return (await accounts(d)).gcpProjectNumbers[id.gcpProject ?? ""] ?? (d?.env ?? process.env).APHRODY_GCP_PROJECT_NUMBER;
  return undefined;
}

/** Synchronous lookup of a dotted path in the discovery cache (same vocabulary as discoverGet); undefined when never discovered. */
export function getCached(path: string, cachePath = defaultCachePath()): string | undefined {
  let c: Cache;
  try {
    c = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return undefined;
  }
  const [sec, a, b] = path.split(".");
  if (sec === "hosts" && a && b) {
    const r = a === "pc" ? localHost() : (c["role:" + a]?.value as Resolved | undefined);
    return r ? HOST_KEYS[b]?.(r) : undefined;
  }
  if (sec === "accounts" && a === "ovh_account") return (c.accounts?.value as Accounts | undefined)?.ovh?.account;
  if (sec === "zones" && a) return (c.accounts?.value as Accounts | undefined)?.zones[path.slice(6)];
  if (sec === "accounts" && a === "cloudflare_account_id") return (c.accounts?.value as Accounts | undefined)?.cloudflareAccounts[0];
  if (sec === "network" && a === "mesh_cidr") {
    const m = (c["role:fr1"]?.value as Resolved | undefined)?.mesh;
    return m ? m.split(".").slice(0, 3).join(".") + ".0/24" : undefined;
  }
  const id = c.identity?.value as Identity | undefined;
  if (sec === "identity") return ({ name: id?.name, first_name: id?.firstName, email: id?.email, github_user: id?.github } as Record<string, string | undefined>)[a ?? ""];
  if (sec === "windows") return ({ user: id?.windows?.user, home: id?.windows?.home, machine: id?.windows?.machine } as Record<string, string | undefined>)[a ?? ""];
  if (sec === "accounts" && a === "gcp_project") return id?.gcpProject;
  if (sec === "accounts" && a === "gcp_project_number") return (c.accounts?.value as Accounts | undefined)?.gcpProjectNumbers[id?.gcpProject ?? ""] ?? process.env.APHRODY_GCP_PROJECT_NUMBER;
  return undefined;
}

/**
 * Every discovered value that must never appear in a tracked file, read from the cache only (no network): what
 * `resolve` and `identity` last saw. The hygiene rule personal-data matches these, so the list never enters the repository.
 * Where no cache exists (CI), APHRODY_SENSITIVE_VALUES holds the same list, one value per line (a repository secret).
 */
export function sensitiveValues(cachePath = defaultCachePath()): { values: string[]; machine?: string } {
  let c: Cache = {};
  try {
    c = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    const env = (Bun.env.APHRODY_SENSITIVE_VALUES ?? "").split(/\r?\n/).map((v) => v.trim()).filter((v) => v.length >= 5);
    return { values: env, machine: Bun.env.APHRODY_SENSITIVE_MACHINE || undefined };
  }
  const out = new Set<string>();
  const id = c.identity?.value as Identity | undefined;
  for (const s of [id?.name, id?.firstName, id?.email, id?.windows?.user, id?.windows?.home, ...(id?.emails ?? [])]) if (s) out.add(s);
  for (const [k, e] of Object.entries(c)) {
    if (!k.startsWith("role:")) continue;
    const r = e.value as Resolved;
    for (const s of [r.address, r.hostname, r.public, r.public6, ...(r.meshAll ?? [])]) if (s) out.add(s);
  }
  // public handles and brand words (the project, the org, the noreply address) are not personal
  const brand = /^aphrody|users\.noreply\.github\.com$/i;
  const ac = c.accounts?.value as Accounts | undefined;
  for (const s of [ac?.ovh?.account, ac?.ovh?.firstName, ac?.ovh?.lastName, ac?.ovh?.email, ...(ac?.cloudflareAccounts ?? []), ...Object.values(ac?.zones ?? {}), ...Object.values(ac?.gcpProjectNumbers ?? {})]) if (s) out.add(s);
  return { values: [...out].filter((s) => s.length >= 5 && !brand.test(s)), machine: id?.windows?.machine };
}

const TOKEN = /@@([A-Za-z0-9_.-]+)@@/g;

/** One value of the dotted vocabulary from the discovery cache, discovering nothing; `siteGet("hosts.fr1.mesh_ip")`. */
export function siteGet(path: string): string | undefined {
  return getCached(path);
}

/** Replaces every `@@a.b.c@@` token by its discovered value; throws on a value nothing answers. */
export async function expand(text: string): Promise<string> {
  if (!text.includes("@@")) return text;
  const vals = new Map<string, string>();
  for (const m of text.matchAll(TOKEN)) {
    const p = m[1]!;
    if (vals.has(p)) continue;
    const v = await discoverGet(p);
    if (v === undefined) throw new Error(`nothing answers for ${p} (ssh config, interfaces, DNS, gh, gcloud, OVH and Cloudflare APIs)`);
    vals.set(p, v);
  }
  return text.replace(TOKEN, (_, p: string) => vals.get(p)!);
}

/** Text of a tracked config that carries tokens (deploy.toml, cluster.toml, ...), expanded. */
export async function readExpanded(path: string): Promise<string> {
  return expand(readFileSync(path, "utf8"));
}

/**
 * Synchronous expansion for config loaders that cannot await: values come from the discovery cache; when a token is
 * missing, one `discover.ts warm` run fills the cache and the lookup is retried. A token nothing answers stays as written.
 */
export function expandSync(text: string): string {
  if (!text.includes("@@")) return text;
  const fill = (s: string) => s.replace(TOKEN, (m, p: string) => getCached(p) ?? m);
  let out = fill(text);
  if (/@@[A-Za-z0-9_.-]+@@/.test(out)) {
    Bun.spawnSync([process.execPath, import.meta.path, "warm"], { stdout: "ignore", stderr: "ignore", timeout: 120_000 });
    out = fill(out);
  }
  return out;
}

// CLI: bun discover.ts resolve <role> | get <path> | warm [role...] | srv <service> <zone> | info <role> | endpoint <service> <zone>
if (import.meta.main) {
  const [cmd, ...args] = Bun.argv.slice(2);
  if (cmd === "resolve") console.log(JSON.stringify(await resolve(args[0]!), null, 1));
  else if (cmd === "get") {
    const v = await discoverGet(args[0]!);
    if (v === undefined) process.exit(1);
    console.log(v);
  } else if (cmd === "warm") {
    for (const r of args.length ? args : ["fr1", "fr2", "prd"]) await resolve(r).catch((e) => console.error(String(e.message ?? e)));
    await identity();
    await accounts();
  } else if (cmd === "info") console.log(JSON.stringify(await hostInfo(args[0]!), null, 1));
  else if (cmd === "endpoint") console.log((await serviceEndpoint(args[0]!, args[1]!)) ?? "");
  else if (cmd === "srv") console.log((await srv(args[0]!, args[1]!)).join("\n"));
  else {
    console.error("usage: discover.ts resolve <role> | get <path> | warm [role...] | srv <service> <zone> | info <role> | endpoint <service> <zone>");
    process.exit(2);
  }
}
