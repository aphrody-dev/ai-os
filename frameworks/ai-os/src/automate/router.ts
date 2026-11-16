// Consumption of the ai-router library published by aphrody-labs/open (release in config/open-libraries.json):
// the Bun binding @aphrody/ai-router (tarball of the release) over its native library (asset of the same release,
// downloaded once into <agent home>/libs and verified against the digest GitHub reports for the asset).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import cfg from "../../config/open-libraries.json" with { type: "json" };

export const libsDir = () =>
  join(Bun.env.AGENT_HOME ?? join(homedir(), ".agent"), "libs");

/** Path of the native library of this platform, downloaded and verified when absent. AI_ROUTER_LIB wins. */
export async function ensureNativeLibrary(
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (Bun.env.AI_ROUTER_LIB) return Bun.env.AI_ROUTER_LIB;
  const plat = process.platform as "win32" | "linux" | "darwin";
  const asset = cfg.assets[plat];
  if (!asset) throw new Error(`no ai-router library for ${process.platform}`);
  const dest = join(libsDir(), cfg.tag, cfg.file[plat]);
  if (existsSync(dest)) return dest;
  const rel = (await (
    await fetcher(
      `https://api.github.com/repos/${cfg.repo}/releases/tags/${cfg.tag}`,
      {
        headers: { accept: "application/vnd.github+json" },
      },
    )
  ).json()) as {
    assets?: { name: string; digest?: string; browser_download_url: string }[];
  };
  const a = rel.assets?.find((x) => x.name === asset);
  if (!a?.digest?.startsWith("sha256:"))
    throw new Error(
      `release ${cfg.tag}: asset ${asset} or its sha256 digest missing`,
    );
  const bytes = new Uint8Array(
    await (await fetcher(a.browser_download_url)).arrayBuffer(),
  );
  const got = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  if (got !== a.digest)
    throw new Error(
      `${asset}: digest mismatch (${got}, release says ${a.digest}); not installed`,
    );
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, bytes);
  return dest;
}

/** Offers the router would try for a policy (auto, auto:local, auto:free, auto:cheap) or an offer id. */
export async function offers(
  policy = "auto",
  config: Record<string, unknown> = {},
) {
  Bun.env.AI_ROUTER_LIB = await ensureNativeLibrary();
  const { Router } = await import("@aphrody/ai-router");
  using r = new Router(config);
  return r.models(policy);
}
