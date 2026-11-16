// SPDX-License-Identifier: Apache-2.0
/**
 * Row-level encryption on top of bun:sqlite. SQLCipher cannot be loaded into bun:sqlite on Windows
 * or Linux (`Database.setCustomSQLite` only acts on macOS; SQLite is linked statically), so each
 * value is an AYV1 envelope (AES-256-GCM, AAD = table|key) and keys can be blinded with a keyed
 * HMAC. The schema, row count and sizes stay visible; values and blinded keys do not.
 *
 * bun:sqlite has no async API: statements here are short point reads/writes (microseconds); the
 * crypto (WebCrypto, DPAPI worker) is async.
 */

import { Database } from "bun:sqlite";
import { keyedFingerprint, open, seal } from "./crypto.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class EncryptedTable {
  readonly #db: Database;
  readonly #table: string;
  readonly #blind: boolean;

  constructor(
    db: Database | string,
    table: string,
    opts: { blindKeys?: boolean } = {},
  ) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table))
      throw new Error(`invalid table ${table}`);
    this.#db =
      typeof db === "string"
        ? new Database(db, { create: true, strict: true })
        : db;
    this.#table = table;
    this.#blind = !!opts.blindKeys;
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run("PRAGMA synchronous = NORMAL");
    this.#db.run(
      `CREATE TABLE IF NOT EXISTS ${table} (k TEXT PRIMARY KEY, v BLOB NOT NULL, updated INTEGER NOT NULL) STRICT`,
    );
  }

  async #key(k: string): Promise<string> {
    return this.#blind
      ? keyedFingerprint(`sqlite|${this.#table}`, enc.encode(k))
      : k;
  }

  async put(k: string, value: string | Uint8Array | object): Promise<void> {
    const bytes =
      value instanceof Uint8Array
        ? value
        : enc.encode(typeof value === "string" ? value : JSON.stringify(value));
    const key = await this.#key(k);
    const env = await seal(`sqlite|${this.#table}|${key}`, bytes);
    this.#db
      .query(
        `INSERT OR REPLACE INTO ${this.#table} (k, v, updated) VALUES (?, ?, ?)`,
      )
      .run(key, env, Date.now());
  }

  async getBytes(k: string): Promise<Uint8Array | undefined> {
    const key = await this.#key(k);
    const row = this.#db
      .query(`SELECT v FROM ${this.#table} WHERE k = ?`)
      .get(key) as { v: Uint8Array } | null;
    return row
      ? open(`sqlite|${this.#table}|${key}`, new Uint8Array(row.v))
      : undefined;
  }

  async get(k: string): Promise<string | undefined> {
    const b = await this.getBytes(k);
    return b && dec.decode(b);
  }

  async getJson<T>(k: string): Promise<T | undefined> {
    const s = await this.get(k);
    return s === undefined ? undefined : (JSON.parse(s) as T);
  }

  async delete(k: string): Promise<boolean> {
    const key = await this.#key(k);
    return (
      this.#db.query(`DELETE FROM ${this.#table} WHERE k = ?`).run(key)
        .changes > 0
    );
  }

  count(): number {
    return (
      this.#db.query(`SELECT count(*) AS n FROM ${this.#table}`).get() as {
        n: number;
      }
    ).n;
  }

  close(): void {
    this.#db.close();
  }
}
