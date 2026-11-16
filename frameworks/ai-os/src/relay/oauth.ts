// Embedded OAuth 2.1 authorization server of the relay and token verification on the resource side.
// Compliant with MCP authorization 2026-07-28 (third_party/modelcontextprotocol, docs/specification/2026-07-28/
// basic/authorization) and A2A 1.0 securitySchemes (third_party/A2A/specification/a2a.proto):
//   RFC 9728 /.well-known/oauth-protected-resource[/mcp|/a2a|/rpc]   RFC 8414 /.well-known/oauth-authorization-server
//   RFC 7591 /oauth/register (DCR)   draft-ietf-oauth-client-id-metadata-document (client_id = URL https)
//   /oauth/authorize (code + mandatory PKCE S256, iss RFC 9207)   /oauth/token (authorization_code, rotating refresh_token,
//   client_credentials, device_code RFC 8628)   /oauth/device_authorization   /oauth/revoke (RFC 7009)
//   resource RFC 8707 -> token aud; access token = JWT HS256 (local key), lifetime RELAY_OAUTH_TTL (3600 s).
// Consent: automatic approval when the relay listens on loopback only and the redirect is
// local (RFC 8252), or when the browser carries the relay cookie; otherwise the request waits for `relay approve <code>`
// (asynchronous consent, no password). The relay's fixed token stays accepted in a header (local use).
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { relayHome } from "./cdp.ts";
import { readDocument, shred, writeDocument } from "@aphrody/env-kit/vault";

export const SCOPES: Record<string, string> = {
  mcp: "relay MCP tools (POST /mcp)",
  a2a: "relay A2A agent (POST /a2a)",
  rpc: "relay native JSON-RPC (/rpc, /ws)",
};
export const RESOURCES = ["mcp", "a2a", "rpc"] as const;
const TTL = () => Number(Bun.env.RELAY_OAUTH_TTL ?? 3600);
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 120;
const DEVICE_TTL = 900;

interface Client {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method:
    "none" | "client_secret_basic" | "client_secret_post";
  /** sha256 of the secret (confidential clients, created with the relay token as initial access token). */
  secret_sha256?: string;
  scope?: string;
  created: number;
}
interface Pending {
  kind: "code" | "device";
  client_id: string;
  scope: string;
  resource: string[];
  redirect_uri?: string;
  state?: string;
  challenge?: string;
  user_code?: string;
  approved: boolean;
  denied?: boolean;
  exp: number;
  poll?: number;
}
interface Refresh {
  client_id: string;
  scope: string;
  resource: string[];
  family: string;
  exp: number;
  used?: boolean;
}
interface State {
  key: string;
  clients: Record<string, Client>;
  refresh: Record<string, Refresh>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rand = (n = 32) => randomBytes(n).toString("base64url");
const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const isLoopbackHost = (h: string) =>
  h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";

/** Redirect refused: neither https, nor http on loopback, nor private scheme (RFC 8252 §7.1), or with a fragment. */
export const badRedirect = (u: string) => {
  try {
    const x = new URL(u);
    return (
      !!x.hash ||
      (x.protocol !== "https:" &&
        !(x.protocol === "http:" && isLoopbackHost(x.hostname)) &&
        !/^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(x.protocol))
    );
  } catch {
    return true;
  }
};

/**
 * Exact match, except the port of http loopback redirects (RFC 8252 §7.3): a
 * native client registers `http://127.0.0.1/callback` and listens on an ephemeral port (Claude Code does).
 */
export const redirectMatches = (registered: string, presented: string) => {
  if (registered === presented) return true;
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    return (
      a.protocol === "http:" &&
      b.protocol === "http:" &&
      isLoopbackHost(a.hostname) &&
      a.hostname === b.hostname &&
      !a.port &&
      a.pathname === b.pathname &&
      a.search === b.search &&
      !b.hash
    );
  } catch {
    return false;
  }
};

/** Host forbidden when fetching a Client ID Metadata Document (SSRF). */
const privateHost = (h: string) =>
  isLoopbackHost(h) ||
  h.endsWith(".localhost") ||
  h.endsWith(".internal") ||
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) ||
  /^\[?(f[cd]|fe80)/i.test(h);

/** Value of the relay session cookie: derived from the fixed token, never the token itself. */
export const relayCookie = (token: string) =>
  createHmac("sha256", token).update("relay-cookie-v1").digest("base64url");

export interface Principal {
  sub: string;
  client_id: string;
  scope: string[];
  aud: string[];
  static?: boolean;
}

export interface OAuthOptions {
  /** Fixed relay token (accepted in a header, initial access token of confidential DCR, approval). */
  token: string;
  /** Listen host: automatic approval only exists on loopback. */
  host: string;
  /** Plaintext state file (tests). Without it, the state is the sealed document of the `relay-oauth` vault
   *  (AYV1, master key DPAPI/systemd-creds, docs/infra/VAULT.md); a former <relayHome>/oauth.json migrates into it. */
  file?: string;
  /** Fetching Client ID Metadata Documents (injectable for tests). */
  fetchDoc?: (url: string) => Promise<Response>;
}

export function createOAuth(o: OAuthOptions) {
  const file = o.file ?? join(relayHome(), "oauth.json");
  let st: State;
  let saving: Promise<void> = Promise.resolve();
  /** Sealed mode: state read (and migrated) before serving; writes are serialized and asynchronous. */
  let sealed = o.file === undefined;
  const ready: Promise<void> = sealed
    ? (async () => {
        const doc = await readDocument<State>(SEALED_DOC, "json");
        if (doc) st = doc;
        else if (existsSync(file)) {
          st = JSON.parse(readFileSync(file, "utf8")) as State;
          await writeDocument(SEALED_DOC, "json", st);
          await shred(file);
        } else {
          st = { key: rand(32), clients: {}, refresh: {} };
          await writeDocument(SEALED_DOC, "json", st);
        }
      })().catch((e: Error) => {
        // Vault unusable here (sandbox, no store): the relay keeps serving on its 0600 state file.
        console.error(
          `[oauth] vault unavailable (${e.message.split("\n")[0]}), state in file ${file}`,
        );
        sealed = false;
        st = undefined as unknown as State;
      })
    : Promise.resolve();
  const load = (): State => {
    if (st) return st;
    if (sealed)
      throw new Error("oauth: sealed state not loaded (await oauth.ready)");
    // Only a missing file regenerates the key; an unreadable file is an error (tokens preserved).
    if (!existsSync(file)) {
      st = { key: rand(32), clients: {}, refresh: {} };
      save();
    } else st = JSON.parse(readFileSync(file, "utf8")) as State;
    return st;
  };
  const save = () => {
    if (sealed) {
      const snapshot = structuredClone(st);
      saving = saving
        .then(() => writeDocument(SEALED_DOC, "json", snapshot))
        .catch((e) =>
          console.error(`[oauth] scellement : ${(e as Error).message}`),
        );
      return;
    }
    const dir = join(file, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Atomic write, 0600 permissions from creation (HMAC key).
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const pending = new Map<string, Pending>();
  const DEVICE = "urn:ietf:params:oauth:grant-type:device_code";
  const autoApprove =
    Bun.env.RELAY_OAUTH_AUTO !== "0" && isLoopbackHost(o.host);
  const cimdCache = new Map<string, { c: Client; exp: number }>();

  /** Public origin: RELAY_PUBLIC_URL behind a proxy, otherwise the request's. */
  const origin = (req: Request) =>
    (Bun.env.RELAY_PUBLIC_URL ?? new URL(req.url).origin).replace(/\/$/, "");
  const resourceUri = (base: string, r: string) => `${base}/${r}`;

  const sign = (claims: Record<string, unknown>) => {
    const h = b64({ alg: "HS256", typ: "at+jwt" });
    const p = b64(claims);
    const s = createHmac("sha256", load().key)
      .update(`${h}.${p}`)
      .digest("base64url");
    return `${h}.${p}.${s}`;
  };
  const verifyJwt = (t: string): Record<string, any> | null => {
    const [h, p, s] = t.split(".");
    if (!h || !p || !s) return null;
    const want = createHmac("sha256", load().key)
      .update(`${h}.${p}`)
      .digest("base64url");
    if (!eq(s, want)) return null;
    try {
      const hd = JSON.parse(Buffer.from(h, "base64url").toString());
      if (hd.alg !== "HS256" || hd.typ !== "at+jwt") return null;
      const c = JSON.parse(Buffer.from(p, "base64url").toString());
      return typeof c.exp === "number" && c.exp > now() ? c : null;
    } catch {
      return null;
    }
  };

  async function client(id: string): Promise<Client | null> {
    const c = load().clients[id];
    if (c) return c;
    if (!/^https:\/\/[^/]+\/.+/.test(id) || privateHost(new URL(id).hostname))
      return null;
    // Client ID Metadata Document: the document must name exactly the same URL.
    const hit = cimdCache.get(id);
    if (hit && hit.exp > Date.now()) return hit.c;
    try {
      const r = await (
        o.fetchDoc ??
        ((u: string) =>
          fetch(u, { signal: AbortSignal.timeout(5000), redirect: "error" }))
      )(id);
      if (!r.ok) return null;
      const raw = await r.text();
      if (raw.length > 65536) return null;
      const d = JSON.parse(raw) as Partial<Client> & { client_id?: string };
      if (
        d.client_id !== id ||
        !Array.isArray(d.redirect_uris) ||
        !d.redirect_uris.length ||
        d.redirect_uris.some((u) => badRedirect(u))
      )
        return null;
      const c: Client = {
        client_id: id,
        client_name: d.client_name,
        redirect_uris: d.redirect_uris,
        grant_types: d.grant_types ?? ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        created: now(),
      };
      const age = Number(
        /max-age=(\d+)/.exec(r.headers.get("cache-control") ?? "")?.[1] ?? 300,
      );
      if (cimdCache.size > 256) cimdCache.clear();
      cimdCache.set(id, { c, exp: Date.now() + Math.min(age, 86400) * 1000 });
      return c;
    } catch {
      return null;
    }
  }

  const err = (error: string, description: string, status = 400) =>
    Response.json(
      { error, error_description: description },
      { status, headers: { "cache-control": "no-store" } },
    );

  const pickScope = (asked: string | null | undefined, c: Client) => {
    const allowed = (c.scope ?? Object.keys(SCOPES).join(" ")).split(" ");
    const want = (asked ?? "").split(" ").filter(Boolean);
    const out = (
      want.length ? want : allowed.filter((s) => s !== "rpc")
    ).filter((s) => allowed.includes(s) && s in SCOPES);
    return out.length ? out.join(" ") : null;
  };
  const pickResources = (base: string, asked: string[]) => {
    const all = RESOURCES.map((r) => resourceUri(base, r));
    if (!asked.length) return all;
    const norm = asked.map((r) => r.replace(/\/$/, ""));
    return norm.every((r) => all.includes(r) || r === base)
      ? norm.flatMap((r) => (r === base ? all : [r]))
      : null;
  };

  function issue(
    base: string,
    client_id: string,
    scope: string,
    resource: string[],
    family?: string,
    refresh = true,
  ) {
    const exp = now() + TTL();
    const access_token = sign({
      iss: base,
      sub: "owner",
      client_id,
      aud: resource,
      scope,
      iat: now(),
      exp,
      jti: rand(12),
    });
    const body: Record<string, unknown> = {
      access_token,
      token_type: "Bearer",
      expires_in: TTL(),
      scope,
    };
    if (refresh) {
      const rt = rand(32);
      const s = load();
      s.refresh[sha(rt)] = {
        client_id,
        scope,
        resource,
        family: family ?? rand(8),
        exp: now() + REFRESH_TTL,
      };
      // Purge expired tokens.
      for (const [k, v] of Object.entries(s.refresh))
        if (v.exp < now()) delete s.refresh[k];
      save();
      body.refresh_token = rt;
    }
    return Response.json(body, {
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  }

  /** Client authentication at the token endpoint (none, client_secret_basic, client_secret_post). */
  async function tokenClient(
    req: Request,
    f: URLSearchParams,
  ): Promise<Client | Response> {
    let id = f.get("client_id") ?? "";
    let secret = f.get("client_secret") ?? "";
    const a = req.headers.get("authorization") ?? "";
    if (a.startsWith("Basic ")) {
      const raw = Buffer.from(a.slice(6), "base64").toString();
      const i = raw.indexOf(":");
      id = decodeURIComponent(i < 0 ? raw : raw.slice(0, i));
      secret = decodeURIComponent(i < 0 ? "" : raw.slice(i + 1));
    }
    const c = await client(id);
    if (!c) return err("invalid_client", "unknown client", 401);
    if (c.secret_sha256 && !eq(sha(secret), c.secret_sha256))
      return err("invalid_client", "secret invalide", 401);
    return c;
  }

  const metadata = (req: Request) => {
    const base = origin(req);
    return Response.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      device_authorization_endpoint: `${base}/oauth/device_authorization`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "client_credentials",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
      ],
      scopes_supported: Object.keys(SCOPES),
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  };

  const prm = (r: (typeof RESOURCES)[number] | null) => (req: Request) => {
    const base = origin(req);
    return Response.json({
      resource: r ? resourceUri(base, r) : base,
      authorization_servers: [base],
      scopes_supported: r ? [r] : Object.keys(SCOPES),
      bearer_methods_supported: ["header"],
      resource_name: "aphrody-relay",
    });
  };

  async function register(req: Request) {
    if (!(req.headers.get("content-type") ?? "").includes("application/json"))
      return err("invalid_client_metadata", "corps JSON attendu");
    let m: Record<string, any>;
    try {
      m = (await req.json()) as Record<string, any>;
    } catch {
      return err("invalid_client_metadata", "JSON invalide");
    }
    // The relay token serves as initial access token (RFC 7591 §3): only it opens client_credentials.
    const trusted = eq(
      req.headers.get("authorization") ?? "",
      `Bearer ${o.token}`,
    );
    const grants: string[] = Array.isArray(m.grant_types)
      ? m.grant_types
      : ["authorization_code", "refresh_token"];
    if (grants.includes("client_credentials") && !trusted)
      return err(
        "invalid_client_metadata",
        "client_credentials requires the relay token as initial access token",
        401,
      );
    const redirects: string[] = Array.isArray(m.redirect_uris)
      ? m.redirect_uris
      : [];
    if (grants.includes("authorization_code") && !redirects.length)
      return err("invalid_redirect_uri", "redirect_uris requis");
    for (const u of redirects)
      if (typeof u !== "string" || badRedirect(u))
        return err(
          "invalid_redirect_uri",
          `${u}: https, loopback or private scheme expected, without fragment`,
        );
    const confidential =
      grants.includes("client_credentials") ||
      (m.token_endpoint_auth_method && m.token_endpoint_auth_method !== "none");
    const secret = confidential ? rand(32) : undefined;
    const c: Client = {
      client_id: `relay-${rand(12)}`,
      client_name:
        typeof m.client_name === "string"
          ? m.client_name.slice(0, 120)
          : undefined,
      redirect_uris: redirects,
      grant_types: grants,
      token_endpoint_auth_method: confidential
        ? m.token_endpoint_auth_method === "client_secret_post"
          ? "client_secret_post"
          : "client_secret_basic"
        : "none",
      secret_sha256: secret ? sha(secret) : undefined,
      scope: typeof m.scope === "string" ? m.scope : undefined,
      created: now(),
    };
    load().clients[c.client_id] = c;
    save();
    const { secret_sha256: _, ...pub } = c;
    return Response.json(
      {
        ...pub,
        client_id_issued_at: c.created,
        ...(secret
          ? { client_secret: secret, client_secret_expires_at: 0 }
          : {}),
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }

  const cookieValue = relayCookie(o.token);
  const cookieAuthed = (req: Request) =>
    (req.headers.get("cookie") ?? "")
      .split(/;\s*/)
      .some((c) => c.startsWith("relay=") && eq(c.slice(6), cookieValue));
  /** Cookie-carried POST: same origin required (Sec-Fetch-Site or Origin), CSRF protection. */
  const sameOrigin = (req: Request) => {
    const site = req.headers.get("sec-fetch-site");
    if (site) return site === "same-origin";
    const og = req.headers.get("origin");
    return !!og && og === new URL(req.url).origin;
  };
  const ownerPost = (req: Request) => cookieAuthed(req) && sameOrigin(req);

  function redirectWith(
    base: string,
    p: Pending,
    code: string | null,
    error?: string,
  ) {
    const u = new URL(p.redirect_uri!);
    if (code) u.searchParams.set("code", code);
    if (error) u.searchParams.set("error", error);
    if (p.state) u.searchParams.set("state", p.state);
    u.searchParams.set("iss", base);
    return new Response(null, {
      status: 302,
      headers: { location: u.toString(), "cache-control": "no-store" },
    });
  }

  const page = (title: string, body: string) =>
    new Response(
      `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${title}</title><body style="font:16px system-ui;max-width:36rem;margin:3rem auto">${body}</body>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        },
      },
    );
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  async function authorize(req: Request) {
    const base = origin(req);
    const q =
      req.method === "POST"
        ? new URLSearchParams(await req.text())
        : new URL(req.url).searchParams;
    // Consent form (relay cookie required): approves or denies a pending request.
    const decision = q.get("decision");
    if (decision && req.method === "POST") {
      const id = q.get("request") ?? "";
      const p = pending.get(id);
      if (!p || p.kind !== "code" || !ownerPost(req))
        return err("access_denied", "unknown or unauthorized request", 403);
      pending.delete(id);
      if (decision !== "allow")
        return redirectWith(base, p, null, "access_denied");
      const code = rand(24);
      pending.set(code, { ...p, approved: true, exp: now() + CODE_TTL });
      return redirectWith(base, p, code);
    }
    const c = await client(q.get("client_id") ?? "");
    const redirect =
      q.get("redirect_uri") ??
      (c?.redirect_uris.length === 1 ? c.redirect_uris[0] : "");
    // Without a valid client or redirect, no redirect (RFC 6749 §4.1.2.1).
    if (
      !c ||
      !redirect ||
      !c.redirect_uris.some((r) => redirectMatches(r, redirect))
    )
      return err("invalid_request", "client_id ou redirect_uri invalide");
    const p: Pending = {
      kind: "code",
      client_id: c.client_id,
      scope: "",
      resource: [],
      redirect_uri: redirect,
      state: q.get("state") ?? undefined,
      approved: false,
      exp: now() + CODE_TTL,
    };
    if (q.get("response_type") !== "code")
      return redirectWith(base, p, null, "unsupported_response_type");
    if (
      q.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(q.get("code_challenge") ?? "")
    )
      return redirectWith(base, p, null, "invalid_request");
    const scope = pickScope(q.get("scope"), c);
    const resource = pickResources(base, q.getAll("resource"));
    if (!scope) return redirectWith(base, p, null, "invalid_scope");
    if (!resource) return redirectWith(base, p, null, "invalid_target");
    Object.assign(p, { scope, resource, challenge: q.get("code_challenge")! });
    const local = (() => {
      try {
        const u = new URL(redirect);
        return u.protocol === "http:" && isLoopbackHost(u.hostname);
      } catch {
        return false;
      }
    })();
    // Request Host on loopback too: a DNS name that rebinds to 127.0.0.1 gets nothing automatically.
    if (autoApprove && local && isLoopbackHost(new URL(req.url).hostname)) {
      const code = rand(24);
      pending.set(code, { ...p, approved: true });
      return redirectWith(base, p, code);
    }
    const id = rand(12);
    pending.set(id, { ...p, exp: now() + DEVICE_TTL });
    if (cookieAuthed(req))
      return page(
        "Autoriser",
        `<h1>Authorize ${esc(c.client_name ?? c.client_id)}</h1><p>Scope: <b>${esc(scope)}</b><br>Redirect: ${esc(redirect)}</p><form method=post action="/oauth/authorize"><input type=hidden name=request value="${id}"><button name=decision value=allow>Authorize</button> <button name=decision value=deny>Deny</button></form>`,
      );
    return new Response(null, {
      status: 303,
      headers: {
        location: `/oauth/wait?request=${id}`,
        "cache-control": "no-store",
      },
    });
  }

  async function deviceAuthorization(req: Request) {
    const base = origin(req);
    const f = new URLSearchParams(await req.text());
    const c = await tokenClient(req, f);
    if (c instanceof Response) return c;
    const scope = pickScope(f.get("scope"), c);
    const resource = pickResources(base, f.getAll("resource"));
    if (!scope) return err("invalid_scope", "unknown scope");
    if (!resource) return err("invalid_target", "unknown resource");
    const device_code = rand(32);
    const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
    // Rejection sampling: 8 characters without modulo bias (256 is not a multiple of 20).
    const chars: string[] = [];
    while (chars.length < 8)
      for (const b of randomBytes(16))
        if (b < 240 && chars.length < 8) chars.push(alphabet[b % 20]!);
    const user_code = chars.join("").replace(/^(.{4})/, "$1-");
    pending.set(device_code, {
      kind: "device",
      client_id: c.client_id,
      scope,
      resource,
      user_code,
      approved: false,
      exp: now() + DEVICE_TTL,
    });
    return Response.json(
      {
        device_code,
        user_code,
        verification_uri: `${base}/oauth/device`,
        verification_uri_complete: `${base}/oauth/device?user_code=${user_code}`,
        expires_in: DEVICE_TTL,
        interval: 5,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  /** Approval (relay token in a header or cookie) of a user code or a pending request. */
  function approve(id: string, allow = true): boolean {
    for (const [k, p] of pending)
      if (k === id || p.user_code === id.toUpperCase()) {
        if (p.exp < now() || p.approved) return false;
        if (allow) p.approved = true;
        else if (p.kind === "device") p.denied = true;
        else pending.delete(k);
        return true;
      }
    return false;
  }

  async function approveHttp(req: Request) {
    const ok =
      eq(req.headers.get("authorization") ?? "", `Bearer ${o.token}`) ||
      ownerPost(req);
    if (!ok) return err("access_denied", "relay token required", 401);
    const f =
      req.method === "POST"
        ? new URLSearchParams(await req.text())
        : new URL(req.url).searchParams;
    const id = f.get("user_code") ?? f.get("request") ?? "";
    return approve(id, f.get("decision") !== "deny")
      ? Response.json({ approved: true })
      : err("invalid_request", "unknown or expired code", 404);
  }

  async function devicePage(req: Request) {
    const u = new URL(req.url);
    const code = (u.searchParams.get("user_code") ?? "").toUpperCase();
    if (!code)
      return page(
        "Appareil",
        `<form><label>Code <input name=user_code autofocus></label> <button>Continuer</button></form>`,
      );
    if (!cookieAuthed(req))
      return page(
        "Appareil",
        `<p>Approve from an owner terminal: <code>relay approve ${esc(code)}</code>.</p>`,
      );
    if (req.method === "POST") {
      if (!sameOrigin(req)) return err("access_denied", "origin refused", 403);
      const f = new URLSearchParams(await req.text());
      return page(
        "Appareil",
        approve(code, f.get("decision") === "allow")
          ? "<p>Done. This page can be closed.</p>"
          : "<p>Unknown or expired code.</p>",
      );
    }
    return page(
      "Appareil",
      `<form method=post><p>Autoriser l'appareil <b>${esc(code)}</b> ?</p><button name=decision value=allow>Autoriser</button> <button name=decision value=deny>Refuser</button></form>`,
    );
  }

  async function token(req: Request) {
    const base = origin(req);
    const f = new URLSearchParams(await req.text());
    const c = await tokenClient(req, f);
    if (c instanceof Response) return c;
    const grant = f.get("grant_type") ?? "";
    const g = c.grant_types;
    const allowed =
      g.includes(grant) ||
      (grant === "refresh_token" && g.includes("authorization_code")) ||
      (grant === DEVICE && g.includes("device_code"));
    if (!allowed)
      return err(
        "unauthorized_client",
        `grant ${grant} not registered for this client`,
      );
    if (grant === "authorization_code") {
      const code = f.get("code") ?? "";
      const p = pending.get(code);
      pending.delete(code);
      if (
        !p ||
        p.kind !== "code" ||
        !p.approved ||
        p.exp < now() ||
        p.client_id !== c.client_id
      )
        return err("invalid_grant", "invalid or expired code");
      if (f.get("redirect_uri") && f.get("redirect_uri") !== p.redirect_uri)
        return err("invalid_grant", "different redirect_uri");
      const v = f.get("code_verifier") ?? "";
      if (createHash("sha256").update(v).digest("base64url") !== p.challenge)
        return err("invalid_grant", "PKCE : code_verifier invalide");
      const asked = f.getAll("resource");
      const resource = asked.length ? pickResources(base, asked) : p.resource;
      if (!resource || !resource.every((r) => p.resource.includes(r)))
        return err("invalid_target", "ressource hors autorisation");
      return issue(
        base,
        c.client_id,
        p.scope,
        resource,
        undefined,
        c.grant_types.includes("refresh_token"),
      );
    }
    if (grant === "refresh_token") {
      const h = sha(f.get("refresh_token") ?? "");
      const r = load().refresh[h];
      if (!r || r.client_id !== c.client_id || r.exp < now())
        return err("invalid_grant", "invalid refresh token");
      if (r.used) {
        // Reuse of an already rotated token: the whole family is revoked (OAuth 2.1 §4.3.1).
        const s = load();
        for (const [k, v] of Object.entries(s.refresh))
          if (v.family === r.family) delete s.refresh[k];
        save();
        return err("invalid_grant", "refresh token reused: family revoked");
      }
      const asked = f.getAll("resource");
      const resource = asked.length ? pickResources(base, asked) : r.resource;
      if (!resource || !resource.every((x) => r.resource.includes(x)))
        return err("invalid_target", "ressource hors autorisation");
      r.used = true;
      const scope = f.get("scope")
        ? f
            .get("scope")!
            .split(" ")
            .filter((s) => r.scope.split(" ").includes(s))
            .join(" ")
        : r.scope;
      return issue(base, c.client_id, scope || r.scope, resource, r.family);
    }
    if (grant === "client_credentials") {
      if (!c.secret_sha256) return err("unauthorized_client", "client public");
      const scope = pickScope(f.get("scope"), c);
      const resource = pickResources(base, f.getAll("resource"));
      if (!scope) return err("invalid_scope", "unknown scope");
      if (!resource) return err("invalid_target", "unknown resource");
      const exp = now() + TTL();
      return Response.json(
        {
          access_token: sign({
            iss: base,
            sub: c.client_id,
            client_id: c.client_id,
            aud: resource,
            scope,
            iat: now(),
            exp,
            jti: rand(12),
          }),
          token_type: "Bearer",
          expires_in: TTL(),
          scope,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (grant === DEVICE) {
      const dc = f.get("device_code") ?? "";
      const p = pending.get(dc);
      if (!p || p.kind !== "device" || p.client_id !== c.client_id)
        return err("invalid_grant", "unknown device_code");
      if (p.exp < now()) {
        pending.delete(dc);
        return err("expired_token", "code expired");
      }
      if (p.denied) {
        pending.delete(dc);
        return err("access_denied", "denied");
      }
      if (!p.approved) {
        const slow = p.poll && Date.now() - p.poll < 5000;
        p.poll = Date.now();
        return err(
          slow ? "slow_down" : "authorization_pending",
          "authorization pending",
        );
      }
      pending.delete(dc);
      return issue(
        base,
        c.client_id,
        p.scope,
        p.resource,
        undefined,
        c.grant_types.includes("refresh_token"),
      );
    }
    return err("unsupported_grant_type", grant);
  }

  async function revoke(req: Request) {
    const f = new URLSearchParams(await req.text());
    const c = await tokenClient(req, f);
    if (c instanceof Response) return c;
    const h = sha(f.get("token") ?? "");
    const r = load().refresh[h];
    if (r && r.client_id === c.client_id) {
      const s = load();
      for (const [k, v] of Object.entries(s.refresh))
        if (v.family === r.family) delete s.refresh[k];
      save();
    }
    return new Response(null, { status: 200 });
  }

  /** Waiting page: reloaded after `relay approve`, it receives the redirect with the code. */
  function waiting(req: Request) {
    const id = new URL(req.url).searchParams.get("request") ?? "";
    const p = pending.get(id);
    if (!p || p.kind !== "code")
      return err("invalid_request", "unknown request", 404);
    if (!p.approved)
      return page(
        "Approbation requise",
        `<meta http-equiv=refresh content=3><p>En attente : <code>relay approve ${esc(id)}</code>.</p>`,
      );
    pending.delete(id);
    const code = rand(24);
    pending.set(code, { ...p, exp: now() + CODE_TTL });
    return redirectWith(origin(req), p, code);
  }

  /**
   * Verifies the bearer of a protected request. `resource` = mcp | a2a | rpc. Fixed relay token: accepted
   * in the Authorization header (local use); never in the URL for mcp and a2a (MCP: "MUST NOT" query string).
   */
  function verify(
    req: Request,
    resource: (typeof RESOURCES)[number],
  ): Principal | "insufficient" | null {
    const a = req.headers.get("authorization") ?? "";
    const t = a.startsWith("Bearer ") ? a.slice(7).trim() : "";
    if (t && eq(t, o.token))
      return {
        sub: "relay-token",
        client_id: "relay-token",
        scope: Object.keys(SCOPES),
        aud: [],
        static: true,
      };
    if (!t) return null;
    const c = verifyJwt(t);
    if (!c) return null;
    const want = resourceUri(origin(req), resource);
    const aud: string[] = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (c.iss !== origin(req) || !aud.includes(want)) return null;
    const scope = String(c.scope ?? "").split(" ");
    if (!scope.includes(resource)) return "insufficient";
    return { sub: c.sub, client_id: c.client_id, scope, aud };
  }

  /** 401 / 403 avec WWW-Authenticate (RFC 6750 §3, RFC 9728 §5.1). */
  function challenge(
    req: Request,
    resource: (typeof RESOURCES)[number],
    insufficient = false,
  ) {
    const base = origin(req);
    const h = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/${resource}", scope="${resource}"${insufficient ? `, error="insufficient_scope"` : ""}`;
    return new Response(
      insufficient
        ? "insufficient scope"
        : "authorization required (OAuth 2.1 or Authorization: Bearer <relay token>)",
      {
        status: insufficient ? 403 : 401,
        headers: { "www-authenticate": h },
      },
    );
  }

  const routes = {
    "/.well-known/oauth-authorization-server": metadata,
    "/.well-known/oauth-protected-resource": prm(null),
    "/.well-known/oauth-protected-resource/mcp": prm("mcp"),
    "/.well-known/oauth-protected-resource/a2a": prm("a2a"),
    "/.well-known/oauth-protected-resource/rpc": prm("rpc"),
    "/oauth/register": { POST: register },
    "/oauth/authorize": { GET: authorize, POST: authorize },
    "/oauth/wait": { GET: waiting },
    "/oauth/token": { POST: token },
    "/oauth/device_authorization": { POST: deviceAuthorization },
    "/oauth/device": { GET: devicePage, POST: devicePage },
    "/oauth/approve": { POST: approveHttp },
    "/oauth/revoke": { POST: revoke },
  };

  return {
    routes,
    verify,
    challenge,
    approve,
    origin,
    ready,
    flushed: () => saving,
  };
}

const SEALED_DOC = "relay-oauth";

/** A2A 1.0 securitySchemes (a2a.proto: SecurityScheme, OAuthFlows is a oneof: one scheme per flow). */
export const a2aSecurity = (base: string) => {
  const scopes = { a2a: SCOPES.a2a! };
  const meta = `${base}/.well-known/oauth-authorization-server`;
  return {
    securitySchemes: {
      oauth2: {
        oauth2SecurityScheme: {
          description:
            "OAuth 2.1, authorization code + PKCE S256 (automatic approval on loopback)",
          flows: {
            authorizationCode: {
              authorizationUrl: `${base}/oauth/authorize`,
              tokenUrl: `${base}/oauth/token`,
              refreshUrl: `${base}/oauth/token`,
              scopes,
              pkceRequired: true,
            },
          },
          oauth2MetadataUrl: meta,
        },
      },
      device: {
        oauth2SecurityScheme: {
          description: "RFC 8628 for agents without a browser",
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: `${base}/oauth/device_authorization`,
              tokenUrl: `${base}/oauth/token`,
              refreshUrl: `${base}/oauth/token`,
              scopes,
            },
          },
          oauth2MetadataUrl: meta,
        },
      },
      agent: {
        oauth2SecurityScheme: {
          description:
            "client_credentials for registered agents (relay client add)",
          flows: {
            clientCredentials: { tokenUrl: `${base}/oauth/token`, scopes },
          },
          oauth2MetadataUrl: meta,
        },
      },
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description: "relay fixed token (local use)",
        },
      },
    },
    securityRequirements: ["oauth2", "device", "agent", "bearer"].map((k) => ({
      schemes: { [k]: { list: k === "bearer" ? [] : ["a2a"] } },
    })),
  };
};
