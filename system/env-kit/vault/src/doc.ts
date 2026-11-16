// SPDX-License-Identifier: Apache-2.0
/**
 * Sealed documents: json, toml, csv, xml or raw bytes in one AYV1 envelope (crypto.ts), stored as
 * `<vault>/docs/<name>.<format>.ayv`. The format is part of the AAD, so a file renamed to another
 * format does not open. Parsing: JSON.parse, Bun.TOML.parse, csv.ts; xml stays text.
 */

import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isSealed, open, seal, sealedWithHello } from "./crypto.ts";
import { parseCsv, stringifyCsv } from "./csv.ts";
import { vaultRoot } from "./paths.ts";
import { assertName } from "./store.ts";

export type DocFormat = "json" | "toml" | "csv" | "xml" | "bin";
export const FORMATS: DocFormat[] = ["json", "toml", "csv", "xml", "bin"];

const enc = new TextEncoder();
const dec = new TextDecoder();
export const docsDir = (): string => join(vaultRoot(), "docs");
const docFile = (name: string, format: DocFormat): string =>
  join(docsDir(), `${name}.${format}.ayv`);
const aad = (name: string, format: DocFormat): string =>
  `doc|${format}|${name}`;

export function encodeDoc(format: DocFormat, content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return enc.encode(content);
  if (format === "json") return enc.encode(JSON.stringify(content, null, 2));
  if (format === "csv" && Array.isArray(content))
    return enc.encode(stringifyCsv(content as string[][]));
  throw new Error(`vault doc: ${format} takes a string or bytes`);
}

export function decodeDoc(format: DocFormat, bytes: Uint8Array): unknown {
  if (format === "bin") return bytes;
  const text = dec.decode(bytes);
  if (format === "json") return JSON.parse(text);
  if (format === "toml") return Bun.TOML.parse(text);
  if (format === "csv") return parseCsv(text);
  return text;
}

/** Seals in memory: for callers that keep the envelope themselves (state files, DB rows). */
export async function sealDoc(
  name: string,
  format: DocFormat,
  content: unknown,
  opts: { hello?: boolean } = {},
) {
  return seal(aad(name, format), encodeDoc(format, content), opts);
}

export async function openDoc<T = unknown>(
  name: string,
  format: DocFormat,
  envelope: Uint8Array,
): Promise<T> {
  const bytes = await open(
    aad(name, format),
    envelope,
    `Ouvrir ${name}.${format}`,
  );
  try {
    return decodeDoc(format, bytes) as T;
  } finally {
    if (format !== "bin") bytes.fill(0);
  }
}

export async function writeDocument(
  name: string,
  format: DocFormat,
  content: unknown,
  opts: { hello?: boolean } = {},
) {
  assertName(name);
  await mkdir(docsDir(), { recursive: true, mode: 0o700 });
  const f = docFile(name, format);
  const tmp = `${f}.${process.pid}.tmp`;
  await writeFile(tmp, await sealDoc(name, format, content, opts), {
    mode: 0o600,
  });
  await rename(tmp, f);
}

export async function readDocument<T = unknown>(
  name: string,
  format: DocFormat,
): Promise<T | undefined> {
  assertName(name);
  let env: Uint8Array;
  try {
    env = new Uint8Array(await readFile(docFile(name, format)));
  } catch {
    return undefined;
  }
  return openDoc<T>(name, format, env);
}

export async function documentInfo(name: string, format: DocFormat) {
  try {
    const env = new Uint8Array(await readFile(docFile(name, format)));
    return {
      exists: true,
      bytes: env.byteLength,
      sealed: isSealed(env),
      hello: sealedWithHello(env),
    };
  } catch {
    return { exists: false, bytes: 0, sealed: false, hello: false };
  }
}

export async function listDocuments(): Promise<
  { name: string; format: DocFormat }[]
> {
  let files: string[] = [];
  try {
    files = await readdir(docsDir());
  } catch {
    return [];
  }
  return files
    .map((f) => /^(.+)\.(json|toml|csv|xml|bin)\.ayv$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1]!, format: m[2] as DocFormat }));
}

export async function deleteDocument(
  name: string,
  format: DocFormat,
): Promise<void> {
  await rm(docFile(name, format), { force: true });
}
