// MCP authorization 2026-07-28 and A2A 1.0 of the relay: RFC 9728 / 8414 metadata, DCR, PKCE S256, iss (RFC 9207),
// RFC 8707 audience, refresh token rotation, client_credentials, RFC 8628 device flow.
import { afterAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "relay-oauth-"));
Object.assign(process.env, {
  RELAY_HOME: home,
  RELAY_TOKEN: "jeton-oauth-test",
  RELAY_PORT: "0",
  RELAY_TCP_PORT: "0",
  RELAY_HUB: "0",
  RELAY_BUILTIN_MCP: "0",
});
const { serve } = await import("../../src/relay/server.ts");
const s = await serve();
const base = `http://127.0.0.1:${s.http.port}`;
afterAll(() => {
  s.http.stop(true);
  s.tcp.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o),
});
const mcpInit = (auth?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });

test("401 with resource_metadata, PRM and AS metadata", async () => {
  const r = await mcpInit();
  expect(r.status).toBe(401);
  const h = r.headers.get("www-authenticate") ?? "";
  expect(h).toContain(
    `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
  );
  const prm = (await (
    await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
  ).json()) as any;
  expect(prm.resource).toBe(`${base}/mcp`);
  expect(prm.authorization_servers).toEqual([base]);
  const as = (await (
    await fetch(`${base}/.well-known/oauth-authorization-server`)
  ).json()) as any;
  expect(as.issuer).toBe(base);
  expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  expect(as.client_id_metadata_document_supported).toBe(true);
  expect(as.authorization_response_iss_parameter_supported).toBe(true);
  // Token in the URL refused on /mcp.
  expect(
    (
      await fetch(`${base}/mcp?token=jeton-oauth-test`, {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(401);
  // Fixed token in a header: local use kept.
  expect((await mcpInit("Bearer jeton-oauth-test")).status).toBe(200);
});

test("DCR + code PKCE, approbation automatique en boucle locale, iss, audience, rotation", async () => {
  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test",
      redirect_uris: ["http://127.0.0.1:9/cb"],
    }),
  });
  expect(reg.status).toBe(201);
  const c = (await reg.json()) as any;
  expect(c.client_secret).toBeUndefined();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: c.client_id,
    redirect_uri: "http://127.0.0.1:9/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "mcp",
    resource: `${base}/mcp`,
  });
  const a = await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" });
  expect(a.status).toBe(302);
  const loc = new URL(a.headers.get("location")!);
  expect(loc.searchParams.get("iss")).toBe(base);
  expect(loc.searchParams.get("state")).toBe("xyz");
  const code = loc.searchParams.get("code")!;
  const bad = await fetch(
    `${base}/oauth/token`,
    form({
      grant_type: "authorization_code",
      code,
      client_id: c.client_id,
      code_verifier: "x".repeat(43),
      redirect_uri: "http://127.0.0.1:9/cb",
    }),
  );
  expect(bad.status).toBe(400);
  // The code is single-use: new authorization.
  const a2 = await fetch(`${base}/oauth/authorize?${q}`, {
    redirect: "manual",
  });
  const code2 = new URL(a2.headers.get("location")!).searchParams.get("code")!;
  const t = (await (
    await fetch(
      `${base}/oauth/token`,
      form({
        grant_type: "authorization_code",
        code: code2,
        client_id: c.client_id,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:9/cb",
        resource: `${base}/mcp`,
      }),
    )
  ).json()) as any;
  expect(t.token_type).toBe("Bearer");
  expect((await mcpInit(`Bearer ${t.access_token}`)).status).toBe(200);
  // Audience mcp seulement : /a2a refuse ce jeton.
  expect(
    (
      await fetch(`${base}/a2a`, {
        method: "POST",
        headers: { authorization: `Bearer ${t.access_token}` },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  const r1 = (await (
    await fetch(
      `${base}/oauth/token`,
      form({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: c.client_id,
      }),
    )
  ).json()) as any;
  expect(r1.access_token).toBeString();
  // Reuse of the old token: family revoked, the new one no longer works.
  expect(
    (
      await fetch(
        `${base}/oauth/token`,
        form({
          grant_type: "refresh_token",
          refresh_token: t.refresh_token,
          client_id: c.client_id,
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(
        `${base}/oauth/token`,
        form({
          grant_type: "refresh_token",
          refresh_token: r1.refresh_token,
          client_id: c.client_id,
        }),
      )
    ).status,
  ).toBe(400);
});

test("client_credentials requires the relay token at registration", async () => {
  const body = JSON.stringify({
    client_name: "agent",
    grant_types: ["client_credentials"],
    scope: "a2a",
  });
  expect(
    (
      await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    ).status,
  ).toBe(401);
  const c = (await (
    await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer jeton-oauth-test",
      },
      body,
    })
  ).json()) as any;
  const basic = `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`;
  const t = (await (
    await fetch(`${base}/oauth/token`, {
      ...form({ grant_type: "client_credentials", resource: `${base}/a2a` }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic,
      },
    })
  ).json()) as any;
  expect(t.scope).toBe("a2a");
  expect(t.refresh_token).toBeUndefined();
  // a2a scope only: /mcp answers 401 (missing audience).
  expect((await mcpInit(`Bearer ${t.access_token}`)).status).toBe(401);
});

test("device flow: pending, approval by the relay token, token issued", async () => {
  const c = (await (
    await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "cli",
        grant_types: [
          "urn:ietf:params:oauth:grant-type:device_code",
          "refresh_token",
        ],
      }),
    })
  ).json()) as any;
  const d = (await (
    await fetch(
      `${base}/oauth/device_authorization`,
      form({ client_id: c.client_id, scope: "mcp" }),
    )
  ).json()) as any;
  expect(d.verification_uri).toBe(`${base}/oauth/device`);
  const poll = () =>
    fetch(
      `${base}/oauth/token`,
      form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: d.device_code,
        client_id: c.client_id,
      }),
    );
  expect(((await (await poll()).json()) as any).error).toBe(
    "authorization_pending",
  );
  expect(await s.oauth.approve(d.user_code)).toBe(true);
  const t = (await (await poll()).json()) as any;
  expect((await mcpInit(`Bearer ${t.access_token}`)).status).toBe(200);
});

test("A2A card: OAuth 2 securitySchemes compliant with a2a.proto", async () => {
  const card = (await (
    await fetch(`${base}/.well-known/agent-card.json`)
  ).json()) as any;
  const ac =
    card.securitySchemes.oauth2.oauth2SecurityScheme.flows.authorizationCode;
  expect(ac.pkceRequired).toBe(true);
  expect(ac.tokenUrl).toBe(`${base}/oauth/token`);
  expect(
    card.securitySchemes.device.oauth2SecurityScheme.flows.deviceCode
      .deviceAuthorizationUrl,
  ).toBe(`${base}/oauth/device_authorization`);
  expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe(
    "Bearer",
  );
});

test("redirect with fragment refused, metadata without OpenID alias", async () => {
  const r = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/cb#x"] }),
  });
  expect(r.status).toBe(400);
  expect((await fetch(`${base}/.well-known/openid-configuration`)).status).toBe(
    404,
  );
});

test("boucle locale : port libre si la redirection enregistrée n'en a pas (RFC 8252 §7.3)", async () => {
  const { redirectMatches } = await import("../../src/relay/oauth.ts");
  expect(
    redirectMatches(
      "http://localhost/callback",
      "http://localhost:47932/callback",
    ),
  ).toBe(true);
  expect(
    redirectMatches(
      "http://localhost/callback",
      "http://localhost:47932/other",
    ),
  ).toBe(false);
  expect(
    redirectMatches("http://127.0.0.1:9/cb", "http://127.0.0.1:10/cb"),
  ).toBe(false);
  expect(
    redirectMatches("https://a.example/cb", "https://a.example:444/cb"),
  ).toBe(false);
});
