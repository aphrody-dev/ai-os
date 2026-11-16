// SPDX-License-Identifier: Apache-2.0
/**
 * Chromium password CSV (chrome://password-manager/settings, export/import).
 * Writer header (components/password_manager/core/browser/export/password_csv_writer.cc):
 *   name,url,username,password,note
 * Reader aliases (…/import/csv_password_sequence.cc): url|website|origin|hostname|login_uri,
 * username|user|login|account|login_username, password|login_password, note|notes|comment|comments.
 *
 * Import seals the rows into the document `chrome-passwords` (csv, Hello-wrapped when enrolled),
 * reopens it to check the row count, then shreds the clear file. Scope: PC only by default.
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { helloAvailable } from "./crypto.ts";
import { parseCsv, stringifyCsv } from "./csv.ts";
import { readDocument, writeDocument } from "./doc.ts";
import { shred } from "./shred.ts";

export const CHROME_DOC = "chrome-passwords";
export const HEADER = ["name", "url", "username", "password", "note"] as const;
export type PasswordRow = Record<(typeof HEADER)[number], string>;

const ALIASES: Record<(typeof HEADER)[number], string[]> = {
  name: ["name", "title"],
  url: ["url", "website", "origin", "hostname", "login_uri"],
  username: ["username", "user", "login", "account", "login_username"],
  password: ["password", "login_password"],
  note: ["note", "notes", "comment", "comments"],
};

export const rowsFromCsv = (text: string): PasswordRow[] =>
  rowsFromTable(parseCsv(text));

export function rowsFromTable(table: string[][]): PasswordRow[] {
  const [head, ...body] = table;
  if (!head) return [];
  const cols = head.map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(
    HEADER.map((k) => [k, cols.findIndex((c) => ALIASES[k].includes(c))]),
  ) as Record<(typeof HEADER)[number], number>;
  if (idx.url < 0 || idx.password < 0)
    throw new Error("chrome csv: url and password columns required");
  return body
    .filter((r) => r.some((c) => c !== ""))
    .map(
      (r) =>
        Object.fromEntries(
          HEADER.map((k) => [k, idx[k] >= 0 ? (r[idx[k]] ?? "") : ""]),
        ) as PasswordRow,
    );
}

export function rowsToCsv(rows: PasswordRow[]): string {
  return stringifyCsv([
    [...HEADER],
    ...rows.map((r) => HEADER.map((k) => r[k])),
  ]);
}

const key = (r: PasswordRow) => `${r.url}\u0000${r.username}`;

export async function loadPasswords(): Promise<PasswordRow[]> {
  const rows = await readDocument<string[][]>(CHROME_DOC, "csv");
  if (!rows) return [];
  return rowsFromTable(rows);
}

/** Import: merge by (url, username), last file wins; returns counts only. */
export async function importChromeCsv(
  file: string,
  opts: { keep?: boolean } = {},
) {
  const incoming = rowsFromCsv(await readFile(file, "utf8"));
  const merged = new Map((await loadPasswords()).map((r) => [key(r), r]));
  const before = merged.size;
  for (const r of incoming) merged.set(key(r), r);
  const rows = [...merged.values()];
  const hello = await helloAvailable();
  await writeDocument(CHROME_DOC, "csv", rowsToCsv(rows), { hello });
  const check = await loadPasswords();
  if (check.length !== rows.length)
    throw new Error("chrome csv: verification failed, clear file kept");
  const shredded = opts.keep ? 0 : await shred(file);
  return {
    imported: incoming.length,
    total: rows.length,
    added: rows.length - before,
    hello,
    shreddedBytes: shredded,
  };
}

/** Export in the writer format, for chrome://password-manager import in a Chromium (fork, CfT). */
export async function exportChromeCsv(out: string) {
  const rows = await loadPasswords();
  await writeFile(out, rowsToCsv(rows), { mode: 0o600 });
  await chmod(out, 0o600).catch(() => {});
  return { rows: rows.length, file: out };
}
