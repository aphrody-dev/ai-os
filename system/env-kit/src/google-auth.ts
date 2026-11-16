// SPDX-License-Identifier: Apache-2.0
/**
 * Google OAuth loopback bootstrap (zero-dependency, Bun built-ins).
 *
 * Secure and user-friendly by design: the user clicks "Allow" on Google's own consent page in their
 * browser; no password, code or token ever passes through this process's input. We run a localhost
 * redirect listener, receive the one-time `code`, exchange it for a long-lived `refresh_token`, and
 * hand that token back to the caller to store in the vault. Google's "installed app" (desktop) client
 * is required because only that client type allows the loopback redirect used here.
 *
 * Reference (checked 2026-11): developers.google.com/identity/protocols/oauth2/native-app
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Minimal scopes per surface; add only what the automation truly needs. */
export const GOOGLE_SCOPES: Record<string, string[]> = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
};

export interface GoogleTokens {
  refresh_token: string;
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

const html = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b1020;color:#e6edf3;font:16px system-ui">` +
  `<div style="text-align:center;max-width:36rem;padding:2rem">${body}</div>`;

/**
 * Runs the loopback consent flow and returns Google's tokens (including the refresh token).
 * Opens the consent URL with the provided launcher; the caller never sees the user's credentials.
 */
export async function googleOAuthLoopback(opts: {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  openBrowser: (url: string) => void;
  /** Loopback port; 0 lets the OS pick a free one. */
  port?: number;
  /** Abort if the user never approves (default 300 s). */
  timeoutMs?: number;
}): Promise<GoogleTokens> {
  const state = crypto.randomUUID();
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/")
        return new Response("not found", { status: 404 });
      const err = url.searchParams.get("error");
      if (err) {
        rejectCode(new Error(`consent refused: ${err}`));
        return new Response(
          html(
            "Denied",
            "<h1>Access denied.</h1><p>You can close this window.</p>",
          ),
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      if (url.searchParams.get("state") !== state) {
        return new Response("bad state", { status: 400 });
      }
      const code = url.searchParams.get("code");
      if (!code) return new Response("no code", { status: 400 });
      resolveCode(code);
      return new Response(
        html(
          "Signed in",
          "<h1>Authorization received.</h1><p>You can close this window and return to the terminal.</p>",
        ),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });

  try {
    const redirectUri = `http://127.0.0.1:${server.port}`;
    const authUrl =
      `${AUTH_ENDPOINT}?` +
      new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: opts.scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();

    opts.openBrowser(authUrl);

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error("timed out waiting for Google consent")),
        opts.timeoutMs ?? 300_000,
      ),
    );
    const code = await Promise.race([codePromise, timeout]);

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok)
      throw new Error(
        `token exchange failed: ${res.status} ${await res.text()}`,
      );
    const tokens = (await res.json()) as GoogleTokens;
    if (!tokens.refresh_token) {
      throw new Error(
        "Google returned no refresh_token (revoke prior grant at myaccount.google.com, then retry)",
      );
    }
    return tokens;
  } finally {
    server.stop(true);
  }
}

/** Exchanges a stored refresh token for a short-lived access token (unattended, no user action). */
export async function googleAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok)
    throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}
