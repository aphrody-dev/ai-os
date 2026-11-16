// SPDX-License-Identifier: Apache-2.0
/**
 * Encrypted backups of the agents' Chromium profiles and of user data (device/vault/profiles.toml):
 * `tar` streamed into `age -e` to the recipients of the entry's scope (the PC by default), kept as
 * <vault>/backups/<name>/<UTC stamp>.tar.age, last VAULT_BACKUPS_KEEP (3) kept.
 *
 * Cookies and passwords inside a profile stay encrypted by Chromium's os_crypt; the backup does not
 * decrypt or re-encrypt them. Restored on the same Windows account they work again (DPAPI key in
 * Local State); elsewhere they do not (VAULT.md, "Chromium"). App-bound encryption is never bypassed.
 */

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ageEncryptToFile } from "./age.ts";
import { b3Files } from "./crypto.ts";
import { loadHosts, loadPolicy, loadRegistry, scopeOf } from "./hosts.ts";
import { infraDir, vaultRoot, WIN } from "./paths.ts";
import { getSecretBytes } from "./store.ts";

export interface BackupEntry {
  name: string;
  path: string;
  kind: "profile" | "userdata";
  engine?: string;
  include?: string[];
}

const TAR = WIN
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

export function expand(p: string): string {
  const s = p
    .replace(/^~(?=[\\/]|$)/, homedir())
    .replace(
      /%([A-Za-z_]+)%/g,
      (_, v: string) =>
        process.env[v] ?? process.env[v.toUpperCase()] ?? `%${v}%`,
    );
  return resolve(s);
}

/** The owner's own browser profiles are never backed up by this tool. */
export function isOwnerProfile(path: string): boolean {
  const p = path.replaceAll("\\", "/").toLowerCase();
  return (
    /\/google\/chrome( beta| dev| sxs)?\/user data(\/|$)/.test(p) ||
    /\/\.config\/google-chrome(\/|$)/.test(p) ||
    /\/microsoft\/edge\/user data(\/|$)/.test(p)
  );
}

export async function loadManifest(): Promise<{
  entries: BackupEntry[];
  exclude: string[];
}> {
  const t = Bun.TOML.parse(
    await readFile(join(infraDir(), "profiles.toml"), "utf8"),
  ) as {
    profile?: Omit<BackupEntry, "kind">[];
    userdata?: Omit<BackupEntry, "kind">[];
    exclude?: { globs?: string[] };
  };
  return {
    entries: [
      ...(t.profile ?? []).map((e) => ({ ...e, kind: "profile" as const })),
      ...(t.userdata ?? []).map((e) => ({ ...e, kind: "userdata" as const })),
    ],
    exclude: t.exclude?.globs ?? [],
  };
}

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
const backupsDir = (name: string) => join(vaultRoot(), "backups", name);

export interface BackupResult {
  name: string;
  skipped?: string;
  file?: string;
  bytes?: number;
  b3?: string;
}

export async function backup(only?: string[]): Promise<BackupResult[]> {
  const [{ entries, exclude }, hosts, policy, registry] = await Promise.all([
    loadManifest(),
    loadHosts(),
    loadPolicy(),
    loadRegistry(),
  ]);
  const keep = Number(process.env.VAULT_BACKUPS_KEEP ?? 3);
  const out: BackupResult[] = [];
  for (const e of entries) {
    if (only && !only.includes(e.name)) continue;
    const dir = expand(e.path);
    if (isOwnerProfile(dir)) {
      out.push({ name: e.name, skipped: "owner profile refused" });
      continue;
    }
    if (
      !(await stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    ) {
      out.push({ name: e.name, skipped: "absent" });
      continue;
    }
    const scope = scopeOf(e.name, "profile", policy, registry);
    const recipients = hosts
      .filter((h) => scope.includes(h.name) && h.recipient)
      .map((h) => h.recipient);
    if (!recipients.length) {
      out.push({ name: e.name, skipped: "no recipient (env-kit vault init)" });
      continue;
    }
    const target = backupsDir(e.name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const file = join(target, `${stamp()}.tar.age`);
    const tar = Bun.spawn(
      [
        TAR,
        "-cf",
        "-",
        ...exclude.flatMap((g) => ["--exclude", g]),
        "-C",
        dir,
        ...(e.include?.length ? e.include : ["."]),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await ageEncryptToFile(tar.stdout, recipients, file);
    // bsdtar exits 1 on files locked by a running browser: the archive is still usable.
    const code = await tar.exited;
    if (code > 1) {
      await rm(file, { force: true });
      out.push({ name: e.name, skipped: `tar exit ${code}` });
      continue;
    }
    const all = (await readdir(target))
      .filter((f) => f.endsWith(".tar.age"))
      .sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep)))
      await rm(join(target, old), { force: true });
    const sum = await b3Files([file]);
    out.push({
      name: e.name,
      file,
      bytes: (await stat(file)).size,
      b3: sum.get(file)?.slice(0, 16),
    });
  }
  return out;
}

/** Restores the newest backup of `name` into `dest` (must not be in use by a browser). */
export async function restore(
  name: string,
  dest?: string,
): Promise<{ file: string; dest: string }> {
  const { entries } = await loadManifest();
  const e = entries.find((x) => x.name === name);
  const target = dest ?? (e ? expand(e.path) : undefined);
  if (!target) throw new Error(`restore: unknown entry ${name}`);
  if (isOwnerProfile(target)) throw new Error("restore: owner profile refused");
  const files = (await readdir(backupsDir(name)))
    .filter((f) => f.endsWith(".tar.age"))
    .sort();
  const file = join(backupsDir(name), files.at(-1) ?? "");
  if (!files.length) throw new Error(`restore: no backup of ${name}`);
  const id = await getSecretBytes("VAULT_AGE_IDENTITY");
  if (!id) throw new Error("restore: PC identity absent");
  await mkdir(target, { recursive: true });
  try {
    // Streamed: age -d | tar -x, no clear archive on disk.
    const age = Bun.spawn(
      [process.env.VAULT_AGE_BIN ?? "age", "-d", "-i", "-", file],
      { stdin: id, stdout: "pipe", stderr: "pipe" },
    );
    const x = Bun.spawn([TAR, "-xf", "-", "-C", target], {
      stdin: age.stdout,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [a, t] = await Promise.all([age.exited, x.exited]);
    if (a !== 0 || t !== 0)
      throw new Error(`restore failed (age ${a}, tar ${t})`);
  } finally {
    id.fill(0);
  }
  return { file, dest: target };
}
