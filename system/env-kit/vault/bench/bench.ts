// SPDX-License-Identifier: Apache-2.0
// bun bench/bench.ts : latency of the async vault paths and event-loop lag while they run.
// Isolated temp vault, factice data only. Output: JSON lines (op, n, p50/p99 ms, max loop lag ms).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "vault-bench-"));
process.env.APHRODY_VAULT_DIR = root;
process.env.ENV_KIT_SECRET_DIR = join(root, "local");
process.env.VAULT_HELLO = "0";
const V = await import("../src/index.ts");

function lagProbe() {
  let max = 0;
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 1);
    last = now;
  }, 1);
  return () => (clearInterval(t), +max.toFixed(2));
}

async function bench(
  op: string,
  n: number,
  conc: number,
  fn: (i: number) => Promise<unknown>,
) {
  const times: number[] = [];
  const stop = lagProbe();
  const t0 = performance.now();
  for (let i = 0; i < n; i += conc) {
    await Promise.all(
      Array.from({ length: Math.min(conc, n - i) }, async (_, j) => {
        const s = performance.now();
        await fn(i + j);
        times.push(performance.now() - s);
      }),
    );
  }
  const total = performance.now() - t0;
  times.sort((a, b) => a - b);
  const p = (q: number) =>
    +times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(
      3,
    );
  console.log(
    JSON.stringify({
      op,
      n,
      conc,
      p50: p(0.5),
      p99: p(0.99),
      opsPerSec: Math.round((n / total) * 1000),
      maxLoopLagMs: stop(),
    }),
  );
}

const small = crypto.getRandomValues(new Uint8Array(64));
const big = crypto.getRandomValues(new Uint8Array(1 << 20));
await V.masterKey(true);
await bench("local.set 64B", 200, 16, (i) => V.setSecret(`B_${i}`, small));
await bench("local.get 64B", 200, 16, (i) => V.getSecretBytes(`B_${i}`));
await bench("seal AYV1 64B", 2000, 64, () => V.seal("bench", small));
await bench("seal AYV1 1MiB", 50, 4, () => V.seal("bench", big));
const env = await V.seal("bench", big);
await bench("open AYV1 1MiB", 50, 4, () => V.open("bench", env));
await bench("doc json write+read", 100, 8, async (i) => {
  await V.writeDocument(`d${i}`, "json", { i, v: "x".repeat(256) });
  await V.readDocument(`d${i}`, "json");
});
const t = new V.EncryptedTable(join(root, "kv.sqlite"), "kv", {
  blindKeys: true,
});
await bench("sqlite put+get blinded", 500, 16, async (i) => {
  await t.put(`k${i}`, small);
  await t.getBytes(`k${i}`);
});
t.close();
if (Bun.which("age")) {
  const k = await V.ageKeygen();
  await bench("age encrypt 64B (spawn)", 30, 6, () =>
    V.ageEncrypt(small, [k.recipient]),
  );
}
rmSync(root, { recursive: true, force: true });
