import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Deps, discoverGet, serviceEndpoint, wellKnown, getCached, parseIpAddr, parseSshG, resolve, sensitiveValues, srv } from "../src/discover.ts";

const SSH_G = "user deploy\nhostname 198.51.100.7\nport 2222\nproxyjump none\nidentityfile ~/.ssh/k\n";
const IP_J = JSON.stringify([
  { ifname: "lo", link_type: "loopback", addr_info: [{ family: "inet", local: "127.0.0.1", scope: "host" }] },
  { ifname: "eth0", link_type: "ether", addr_info: [{ family: "inet", local: "198.51.100.7", scope: "global" }, { family: "inet6", local: "2001:db8::7", scope: "global" }] },
  { ifname: "mesh0", link_type: "none", addr_info: [{ family: "inet", local: "192.0.2.7", scope: "global" }, { family: "inet", local: "192.0.2.77", scope: "global" }] },
  { ifname: "docker0", link_type: "ether", addr_info: [{ family: "inet", local: "172.17.0.1", scope: "global" }] },
]);
const REMOTE = `host7.example.net\n---aphrody-discover---\nfr9\n---aphrody-discover---\n${IP_J}`;

function deps(over: Partial<Deps> = {}): Deps {
  const calls: string[][] = [];
  const d: Deps = {
    run: async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "ssh" && cmd[1] === "-G") return { code: 0, out: SSH_G };
      if (cmd[0] === "ssh") return { code: 0, out: REMOTE };
      if (cmd[0] === "git") return { code: 0, out: "Jane Doe\n" };
      return { code: 1, out: "" };
    },
    dns: {
      lookup: async () => [{ address: "192.0.2.7", family: 4 }],
      resolveSrv: async () => [
        { name: "b.example.net", port: 8443, priority: 20, weight: 1 },
        { name: "a.example.net", port: 8443, priority: 10, weight: 1 },
      ],
      resolveTxt: async () => [["role=fr9"]],
    },
    cachePath: join(mkdtempSync(join(tmpdir(), "disc-")), "discover.json"),
    ttlMs: 60_000,
    now: () => 1_000,
    env: { USERNAME: "tester", USERPROFILE: "C:/Users/tester", COMPUTERNAME: "TESTBOX" },
    ...over,
  };
  (d as any).calls = calls;
  return d;
}

test("parseSshG reads the effective client config", () => {
  expect(parseSshG(SSH_G)).toEqual({ hostname: "198.51.100.7", user: "deploy", port: 2222, proxyjump: undefined });
  expect(parseSshG("proxyjump fr2\n").proxyjump).toBe("fr2");
});

test("parseIpAddr splits public, IPv6 and tunnel addresses", () => {
  expect(parseIpAddr(IP_J)).toEqual({ public: "198.51.100.7", public6: "2001:db8::7", mesh: ["192.0.2.7", "192.0.2.77"] });
});

test("resolve combines ssh -G and the remote probe, then answers from cache", async () => {
  const d = deps();
  const r = await resolve("fr9", { remote: true }, d);
  expect(r).toMatchObject({ ssh: "fr9", user: "deploy", port: 2222, hostname: "host7.example.net", remoteRole: "fr9", public: "198.51.100.7", mesh: "192.0.2.7" });
  const before = (d as any).calls.length;
  await resolve("fr9", { remote: true }, d);
  expect((d as any).calls.length).toBe(before);
  expect(getCached("hosts.fr9.mesh_ip", d.cachePath)).toBe("192.0.2.7");
  expect(getCached("hosts.fr9.link_ip", d.cachePath)).toBe("192.0.2.77");
});

test("an offline lookup falls back to the stale cache", async () => {
  const d = deps();
  await resolve("fr9", { remote: true }, d);
  const offline = deps({ cachePath: d.cachePath, now: () => 10_000_000, run: async () => ({ code: 255, out: "" }) });
  expect((await resolve("fr9", { remote: true }, offline)).mesh).toBe("192.0.2.7");
});

test("an unknown role names the ssh config entry to add", async () => {
  const d = deps({ run: async () => ({ code: 255, out: "" }) });
  await expect(resolve("nope", { remote: true }, d)).rejects.toThrow("Host nope");
});

test("srv orders by priority", async () => {
  expect(await srv("api", "example.net", deps())).toEqual(["a.example.net:8443", "b.example.net:8443"]);
});

test("discoverGet answers host and Windows keys from the stubs, and sensitiveValues lists them for hygiene", async () => {
  const d = deps();
  expect(await discoverGet("hosts.fr9.public_ip", d)).toBe("198.51.100.7");
  expect(await discoverGet("windows.user", d)).toBe("tester");
  const s = sensitiveValues(d.cachePath);
  expect(s.values).toContain("198.51.100.7");
  expect(s.values).toContain("host7.example.net");
  expect(s.machine).toBe("TESTBOX");
});

test("serviceEndpoint maps an SRV <role>.mesh target to the role's mesh address", async () => {
  const base = deps();
  const d = deps({ cachePath: base.cachePath, dns: { ...base.dns, resolveSrv: async () => [{ name: "fr9.mesh", port: 6379, priority: 10, weight: 10 }] } });
  expect(await serviceEndpoint("valkey", "example.net", d)).toBe("192.0.2.7:6379");
});

test("wellKnown reads the host document", async () => {
  const s = Bun.serve({ port: 0, fetch: (r) => (new URL(r.url).pathname === "/.well-known/aphrody/host" ? Response.json({ role: "fr9" }) : new Response("no", { status: 404 })) });
  expect(await wellKnown(`http://127.0.0.1:${s.port}`)).toEqual({ role: "fr9" });
  s.stop(true);
});

test("OVH /me and Cloudflare answer the account keys, the local machine answers pc", async () => {
  const base = deps();
  const d = deps({
    cachePath: base.cachePath,
    env: { ...base.env, CLOUDFLARE_API_TOKEN: "" },
    run: async (cmd) => (cmd[0] === "ovhcloud" ? { code: 0, out: JSON.stringify({ nichandle: "xx0000000-ovh", firstname: "Jane", name: "Doe", email: "jane@example.com" }) } : base.run(cmd)),
  });
  expect(await discoverGet("accounts.ovh_account", d)).toBe("xx0000000");
  const s = sensitiveValues(d.cachePath);
  expect(s.values).toContain("xx0000000");
  expect(s.values).toContain("jane@example.com");
  expect((await resolve("pc", { remote: false }, d)).role).toBe("pc");
});

test("no tracked source reads a site file or names the old loader", () => {
  const out = Bun.spawnSync(["git", "-C", join(import.meta.dir, "..", "..", ".."), "grep", "-lE", "site\\.toml|APHRODY_SITE|loadOverride|loadSite|env-kit/src/site\\.ts", "--", "packages", "infra", "scripts", ":!system/env-kit/tests/discover.test.ts"]).stdout.toString();
  expect(out.trim()).toBe("");
});
