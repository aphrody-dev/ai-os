// SPDX-License-Identifier: Apache-2.0
/**
 * Gmail automation over the REST API (zero-dependency). Reads use the stored refresh token; sending
 * is side-effectful and always requires an explicit confirmation flag from the caller. Message
 * bodies and tokens are never printed by these helpers.
 *
 * Reference (checked 2026-11): developers.google.com/gmail/api/reference/rest
 */

import { googleAccessToken } from "./google-auth.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

async function authHeader(creds: GmailCreds): Promise<Record<string, string>> {
  const token = await googleAccessToken(creds);
  return { authorization: `Bearer ${token}` };
}

export interface MailHeader {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

/** Lists message headers matching a Gmail search query (e.g. "is:unread newer_than:7d"). */
export async function listMessages(
  creds: GmailCreds,
  query: string,
  max = 20,
): Promise<MailHeader[]> {
  const headers = await authHeader(creds);
  const list = await fetch(
    `${API}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
    { headers },
  );
  if (!list.ok) throw new Error(`gmail list failed: ${list.status}`);
  const ids =
    ((await list.json()) as { messages?: { id: string }[] }).messages ?? [];
  return Promise.all(
    ids.map(async ({ id }) => {
      const r = await fetch(
        `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers },
      );
      const m = (await r.json()) as {
        snippet?: string;
        payload?: { headers?: { name: string; value: string }[] };
      };
      const h = (name: string) =>
        m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ??
        "";
      return {
        id,
        from: h("from"),
        subject: h("subject"),
        date: h("date"),
        snippet: m.snippet ?? "",
      };
    }),
  );
}

/** Builds an RFC 2822 message and base64url-encodes it for the Gmail send endpoint. */
function encodeMessage(to: string, subject: string, body: string): string {
  const mime =
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
    body;
  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Sends a plain-text e-mail. `confirmed` must be true: the caller is responsible for obtaining the
 * user's explicit go-ahead, because sending mail on their behalf is an irreversible outward action.
 */
export async function sendMessage(
  creds: GmailCreds,
  msg: { to: string; subject: string; body: string },
  confirmed: boolean,
): Promise<{ id: string }> {
  if (!confirmed)
    throw new Error("refusing to send: explicit confirmation required");
  const headers = await authHeader(creds);
  const res = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ raw: encodeMessage(msg.to, msg.subject, msg.body) }),
  });
  if (!res.ok)
    throw new Error(`gmail send failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string };
}

/** The authenticated mailbox address and unread count, for a one-line status (no bodies). */
export async function gmailProfile(
  creds: GmailCreds,
): Promise<{ email: string; total: number; unread: number }> {
  const headers = await authHeader(creds);
  const [prof, unread] = await Promise.all([
    fetch(`${API}/profile`, { headers }).then((r) => r.json()) as Promise<{
      emailAddress: string;
      messagesTotal: number;
    }>,
    fetch(`${API}/messages?q=is:unread&maxResults=1`, { headers }).then((r) =>
      r.json(),
    ) as Promise<{
      resultSizeEstimate: number;
    }>,
  ]);
  return {
    email: prof.emailAddress,
    total: prof.messagesTotal,
    unread: unread.resultSizeEstimate ?? 0,
  };
}
