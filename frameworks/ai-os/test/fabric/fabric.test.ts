// Inference fabric: reading tools/ai/fabric.toml, -ts order (RPC nodes then CUDA0), coordinator arguments
// (never listening off loopback), ssh line (quoted values), closed port. No remote host contacted.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_HOME = mkdtempSync(join(tmpdir(), "ai-os-fabric-"));
const { coordinatorArgs, loadFabric, reachable, remoteLine, tensorSplit } =
  await import("../../src/fabric/index.ts");

const f = loadFabric();

test("fabric.toml: local coordinator, nodes bound to WireGuard, pinned binaries", () => {
  expect(f.coordinator.host).toBe("127.0.0.1");
  expect(f.release.tag).toMatch(/^b\d+$/);
  for (const n of f.node.filter((x) => x.os === "linux")) {
    expect(n.bind).toMatch(/^10\.200\.7[78]\./);
    expect(n.memory_max).toBeTruthy();
    expect(n.cpu_quota).toBeTruthy();
  }
  const prd = f.node.find((n) => n.id === "prd")!;
  expect(prd.gate).toBe("prd");
  expect(prd.heavy_lock).toBe("/var/lock/aphrody-heavy.lock");
  expect(f.node.find((n) => n.id === "fr1")!.gate).toBe("no-build");
});

test("-ts: RPC nodes in admitted order, then the local device; empty if a share is missing", () => {
  expect(tensorSplit(f, ["fr1"])).toEqual([1, 7]);
  expect(tensorSplit(f, ["fr1", "prd"])).toEqual([1, 1, 7]);
  expect(tensorSplit(f, [])).toEqual([]);
  expect(tensorSplit(f, ["gpu2"])).toEqual([]);
});

test("arguments du coordinateur", () => {
  const a = coordinatorArgs(f, "m.gguf", ["192.0.2.1:50052"], [1, 7]);
  expect(a.slice(a.indexOf("--host"), a.indexOf("--host") + 2)).toEqual([
    "--host",
    "127.0.0.1",
  ]);
  expect(a).toContain("--rpc");
  expect(a[a.indexOf("-ts") + 1]).toBe("1,7");
  expect(coordinatorArgs(f, "m.gguf", [])).not.toContain("--rpc");
});

test("ligne ssh : valeurs entre apostrophes, sudo -n hors root", () => {
  const l = remoteLine({ PRIO: "http://x/'; rm -rf /", PORT: "50052" }, "up");
  expect(l).toContain(`PRIO='http://x/'\\''; rm -rf /'`);
  expect(l).toContain(`sudo -n`);
  expect(l.endsWith(`node.sh 'up'`)).toBe(true);
});

test("closed port: unreachable, no exception", async () => {
  expect(await reachable("127.0.0.1", 1, 1000)).toBe(false);
  expect(await reachable("", 50052)).toBe(false);
});

test("[trial]: prd probed by ensure, one remote layer on Qwen3-0.6B", () => {
  expect(f.trial?.nodes).toContain("prd");
  expect(f.model[f.trial!.model]).toBeTruthy();
  expect(f.trial!.split.length).toBe(2);
});
