// SPDX-License-Identifier: Apache-2.0
/**
 * Best-effort secure deletion of a clear file (exported CSV): overwrite in place with random bytes,
 * flush to the device, rename to a random name, unlink. Limits (documented in VAULT.md): SSD wear
 * levelling, NTFS/ReFS journal, Volume Shadow Copies, OneDrive and backups may keep older copies.
 */
import { open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function shred(path: string): Promise<number> {
  const size = (await stat(path)).size;
  const fh = await open(path, "r+");
  try {
    const chunk = new Uint8Array(1 << 16);
    for (let off = 0; off < size; off += chunk.byteLength) {
      crypto.getRandomValues(chunk);
      await fh.write(chunk, 0, Math.min(chunk.byteLength, size - off), off);
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  const tmp = join(dirname(path), `.${crypto.randomUUID()}`);
  await rename(path, tmp);
  await rm(tmp);
  return size;
}
