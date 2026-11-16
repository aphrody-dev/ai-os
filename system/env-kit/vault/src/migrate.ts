// SPDX-License-Identifier: Apache-2.0
/**
 * Moves the env-kit DPAPI store (%LOCALAPPDATA%\aphrody\secrets) into <vault>/local. Blobs are
 * copied as is (same DPAPI user, same entropy: no decryption), checked by BLAKE3, then removed from
 * the old place. A file newer at the old place (written by an older tool) wins over the copy.
 */
import { copyFile, mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { b3Files } from "./crypto.ts";
import { legacyDpapiDir, localStore, WIN } from "./paths.ts";

export async function migrateLegacy(): Promise<{
  moved: number;
  kept: number;
  from: string;
  to: string;
}> {
  const info = localStore();
  const from = legacyDpapiDir();
  const res = { moved: 0, kept: 0, from, to: info.dir };
  if (!WIN || !info.legacy.length) return res;
  let files: string[] = [];
  try {
    files = (await readdir(from)).filter((f) => f.endsWith(".dpapi"));
  } catch {
    return res;
  }
  await mkdir(info.dir, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const src = join(from, f);
    const dst = join(info.dir, f);
    const [s, d] = await Promise.all([
      stat(src),
      stat(dst).catch(() => undefined),
    ]);
    if (!d || s.mtimeMs > d.mtimeMs) {
      await copyFile(src, dst);
      await utimes(dst, s.atime, s.mtime);
    }
    const sums = await b3Files([src, dst]);
    // Same blob, or a stale old copy older than the vault one: the old place goes.
    if (sums.get(src) === sums.get(dst) || (d && d.mtimeMs > s.mtimeMs)) {
      await rm(src);
      res.moved++;
    } else res.kept++;
  }
  return res;
}
