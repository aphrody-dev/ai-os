// Detached OpenPGP signature check through sequoia `sqv` and the GSRC per-package gpg-keyring.
import { join } from "node:path";
import type { Signature } from "./types.ts";

export const sqvPath = () => Bun.which("sqv");

/** Keyring of a package in a GSRC checkout (pkg/gnu/<id>/gpg-keyring), or null. */
export async function gsrcKeyring(
  gsrcRoot: string,
  id: string,
): Promise<string | null> {
  const f = join(gsrcRoot, "pkg", "gnu", id, "gpg-keyring");
  return (await Bun.file(f).exists()) ? f : null;
}

/**
 * sqv detached verification. Many GNU maintainer keys carry SHA-1 binding signatures that the default sequoia policy
 * rejects: that case is retried with the policy as of 2022-01-01 and reported as verified with a legacy note.
 * Only a clear signature or hash mismatch is reported as invalid; any other failure stays unverified.
 */
export async function sqvDetached(
  file: string,
  sig: string,
  keyrings: string | string[],
): Promise<Signature> {
  const sqv = sqvPath();
  if (!sqv) return { status: "unverified", detail: "sqv not installed" };
  const rings = [keyrings].flat();
  const kr = rings.flatMap((k) => ["--keyring", k]);
  const run = (extra: string[]) =>
    Bun.$`${sqv} ${extra} ${kr} --signature-file ${sig} ${file}`
      .quiet()
      .nothrow();
  const ring = rings
    .map((k) => k.split(/[\\/]/).slice(-2).join("/"))
    .join(" + ");
  let r = await run([]);
  if (r.exitCode === 0)
    return { status: "verified", detail: `sqv, keyring ${ring}` };
  let err = (r.stderr.toString() || r.stdout.toString()).trim();
  if (/policy|not considered secure|not bound|sha1/i.test(err)) {
    r = await run(["--policy-as-of", "2022-01-01"]);
    if (r.exitCode === 0)
      return {
        status: "verified",
        detail: `sqv legacy policy (SHA-1 key binding), keyring ${ring}`,
      };
    err = (r.stderr.toString() || r.stdout.toString()).trim();
  }
  const last = err.split("\n").at(-1) ?? "";
  return /bad signature|hash mismatch|does not match|verification failed/i.test(
    err,
  )
    ? { status: "invalid", detail: last.slice(0, 160) }
    : { status: "unverified", detail: last.slice(0, 160) };
}

/** Verify with the GSRC per-package keyring and the GNU maintainers keyring (gnu-keyring.gpg), whichever exist. */
export async function verifySignature(
  file: string,
  sig: string | null,
  keyrings: (string | null)[],
): Promise<Signature> {
  if (!sig) return { status: "missing", detail: "no .sig on ftp.gnu.org" };
  if (!sqvPath()) return { status: "unverified", detail: "sqv not installed" };
  const rings = keyrings.filter((k): k is string => !!k);
  if (!rings.length)
    return {
      status: "unverified",
      detail: "no keyring (GSRC gpg-keyring, gnu-keyring.gpg)",
    };
  return sqvDetached(file, sig, rings);
}

export async function sha256File(file: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const c of Bun.file(file).stream()) h.update(c);
  return h.digest("hex");
}
