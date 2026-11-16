// MCP stdio round-trip bench: bun bench.ts <cmd> [args...] -- <tool> [jsonArgs] [n]
const sep = Bun.argv.indexOf("--");
const cmd = Bun.argv.slice(2, sep);
const [tool, a = "{}", n = "20"] = Bun.argv.slice(sep + 1);
const p = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const dec = new TextDecoder();
let buf = "";
const waiters = new Map<number, (v: any) => void>();
(async () => {
  for await (const c of p.stdout) {
    buf += dec.decode(c);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(l);
        waiters.get(m.id)?.(m);
      } catch {}
    }
  }
})();
let id = 0;
const rpc = (method: string, params: any) =>
  new Promise<any>((r) => {
    const i = ++id;
    waiters.set(i, r);
    p.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n",
    );
    p.stdin.flush();
  });
let t = performance.now();
await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "bench", version: "0" },
});
p.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
    "\n",
);
console.log("init_ms", (performance.now() - t).toFixed(1));
const tools = (await rpc("tools/list", {})).result?.tools ?? [];
if (!tool) {
  console.log(tools.map((x: any) => x.name).join(" "));
  process.exit(0);
}
const ts: number[] = [];
let last: any;
for (let k = 0; k < +n; k++) {
  t = performance.now();
  last = await rpc("tools/call", { name: tool, arguments: JSON.parse(a) });
  ts.push(performance.now() - t);
}
ts.sort((x, y) => x - y);
console.log(
  tool,
  "median_ms",
  ts[ts.length >> 1].toFixed(1),
  "p90_ms",
  ts[Math.floor(ts.length * 0.9)].toFixed(1),
  "bytes",
  JSON.stringify(last).length,
  last.error ? "ERR " + JSON.stringify(last.error).slice(0, 200) : "",
);
process.exit(0);
