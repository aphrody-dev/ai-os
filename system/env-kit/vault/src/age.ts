// SPDX-License-Identifier: Apache-2.0
/**
 * age envelopes (X25519 recipients, one per host) through the `age` binary, async and streaming.
 * Encryption only needs public recipients. Decryption takes the identity on stdin (`-i -`) and the
 * ciphertext from a file, so a private key never touches the disk in clear nor appears in argv.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGE = process.env.VAULT_AGE_BIN ?? "age";
const KEYGEN = process.env.VAULT_AGE_KEYGEN_BIN ?? "age-keygen";
export const RECIPIENT = /^age1[0-9a-z]{58}$/;

type Input = Uint8Array | ReadableStream<Uint8Array> | Blob;

async function collect(
  p: Bun.Subprocess<
    "pipe" | Uint8Array | ReadableStream | Blob,
    "pipe",
    "pipe"
  >,
  what: string,
) {
  const [out, err, code] = await Promise.all([
    new Response(p.stdout as ReadableStream).bytes(),
    new Response(p.stderr as ReadableStream).text(),
    p.exited,
  ]);
  if (code !== 0)
    throw new Error(`${what} failed: ${err.trim().split("\n")[0]}`);
  return out;
}

export function assertRecipients(recipients: string[]): void {
  if (!recipients.length) throw new Error("age: no recipient");
  for (const r of recipients)
    if (!RECIPIENT.test(r))
      throw new Error(`age: invalid recipient ${r.slice(0, 12)}...`);
}

const rArgs = (recipients: string[]): string[] =>
  recipients.flatMap((r) => ["-r", r]);

/** Encrypts in memory (secrets, documents). */
export async function ageEncrypt(
  data: Input,
  recipients: string[],
): Promise<Uint8Array> {
  assertRecipients(recipients);
  const p = Bun.spawn([AGE, "-e", ...rArgs(recipients)], {
    stdin: data as never,
    stdout: "pipe",
    stderr: "pipe",
  });
  return collect(p as never, "age -e");
}

/** Streams `input` (a process stdout, a file) into an envelope at `out` (profiles, large files). */
export async function ageEncryptToFile(
  input: Input,
  recipients: string[],
  out: string,
): Promise<void> {
  assertRecipients(recipients);
  const p = Bun.spawn([AGE, "-e", ...rArgs(recipients), "-o", out], {
    stdin: input as never,
    stdout: "pipe",
    stderr: "pipe",
  });
  await collect(p as never, "age -e");
}

/** Decrypts an envelope file with an identity passed on stdin; output in memory or to `out`. */
export async function ageDecryptFile(
  file: string,
  identity: Uint8Array,
  out?: string,
): Promise<Uint8Array> {
  const p = Bun.spawn(
    [AGE, "-d", "-i", "-", ...(out ? ["-o", out] : []), file],
    {
      stdin: identity,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return collect(p as never, "age -d");
}

/** Same, for an envelope held in memory (written to a private temp file: ciphertext only). */
export async function ageDecrypt(
  envelope: Uint8Array,
  identity: Uint8Array,
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "vault-"));
  try {
    const f = join(dir, "in.age");
    await writeFile(f, envelope, { mode: 0o600 });
    return await ageDecryptFile(f, identity);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** New X25519 identity, in memory only (the caller seals it into the local layer). */
export async function ageKeygen(): Promise<{
  identity: Uint8Array;
  recipient: string;
}> {
  const p = Bun.spawn([KEYGEN], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const identity = await collect(p as never, "age-keygen");
  return { identity, recipient: await ageRecipientOf(identity) };
}

export async function ageRecipientOf(identity: Uint8Array): Promise<string> {
  const p = Bun.spawn([KEYGEN, "-y", "-"], {
    stdin: identity,
    stdout: "pipe",
    stderr: "pipe",
  });
  const r = new TextDecoder()
    .decode(await collect(p as never, "age-keygen -y"))
    .trim();
  assertRecipients([r]);
  return r;
}
