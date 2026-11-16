// Relay TCP and TLS: token handshake then NDJSON JSON-RPC (self-signed certificate if RELAY_TEST_TLS_* is set).
import { afterAll, expect, test } from "bun:test";

process.env.RELAY_TOKEN = "jeton-de-test";
process.env.RELAY_PORT = "0";
process.env.RELAY_TCP_PORT = "0";
process.env.RELAY_HUB = "0";
process.env.RELAY_BUILTIN_MCP = "0";
const tlsCert = process.env.RELAY_TEST_TLS_CERT;
const tlsKey = process.env.RELAY_TEST_TLS_KEY;
if (tlsCert && tlsKey)
  Object.assign(process.env, {
    RELAY_TLS_CERT: tlsCert,
    RELAY_TLS_KEY: tlsKey,
    RELAY_TLS_PORT: "0",
  });
const { serve } = await import("../../src/relay/server.ts");
const s = await serve();
afterAll(() => {
  s.http.stop(true);
  s.tcp.stop(true);
});

async function roundTrip(port: number, tls: boolean) {
  const lines: string[] = [];
  let buf = "";
  const send = (s: any) => {
    s.write("jeton-de-test\n");
    s.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: { hub: false } })}\n`,
    );
  };
  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    ...(tls ? { tls: { rejectUnauthorized: false } } : {}),
    socket: {
      // TLS: write after the handshake (bytes written before are lost on the bun client side).
      open(s) {
        if (!tls) send(s);
      },
      handshake(s) {
        send(s);
      },
      data(_s, d) {
        buf += Buffer.from(d).toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0)
          (lines.push(buf.slice(0, i)), (buf = buf.slice(i + 1)));
      },
    },
  });
  for (let i = 0; i < 50 && lines.length < 2; i++) await Bun.sleep(20);
  sock.end();
  return lines;
}

test("TCP : jeton puis tools/list", async () => {
  const [hello, res] = await roundTrip(s.tcp.port, false);
  expect(JSON.parse(hello!)).toEqual({ ok: true });
  expect(JSON.parse(res!).result.map((t: any) => t.name)).toContain(
    "gemini_ask",
  );
});

test.skipIf(!s.tls)("TLS : jeton puis tools/list", async () => {
  const [hello, res] = await roundTrip(s.tls!.port, true);
  expect(JSON.parse(hello!)).toEqual({ ok: true });
  expect(JSON.parse(res!).id).toBe(7);
});

test("HTTP: token required, public A2A card", async () => {
  const base = `http://127.0.0.1:${s.http.port}`;
  expect(
    (await fetch(`${base}/rpc`, { method: "POST", body: "{}" })).status,
  ).toBe(401);
  expect(
    ((await (await fetch(`${base}/.well-known/agent-card.json`)).json()) as any)
      .name,
  ).toBe("aphrody-relay");
});
