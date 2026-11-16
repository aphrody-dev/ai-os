// Google authentication without an API key for the absorbed google-labs-code clients (Stitch) and the relay: OAuth
// token of the active gcloud account + billing project (RELAY_GCP_QUOTA_PROJECT, otherwise the current gcloud project).
// gcloud is launched without blocking the event loop (a spawnSync froze the relay for several seconds) and the
// token is kept 45 min (lifetime 1 h). Values are never logged.

let cache: { at: number; token: string; project: string } | null = null;

const run = async (a: string[]) => {
  const p = Bun.spawn(["gcloud", ...a], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim();
};

export async function gcloudCredentials(): Promise<{
  token: string;
  project: string;
}> {
  if (cache && Date.now() - cache.at < 45 * 60_000) return cache;
  const [token, project] = await Promise.all([
    run(["auth", "print-access-token"]),
    Bun.env.RELAY_GCP_QUOTA_PROJECT ?? run(["config", "get-value", "project"]),
  ]);
  cache = { at: Date.now(), token, project };
  return cache;
}

/** Bearer + quota project headers (format expected by stitch.googleapis.com/mcp). */
export async function gcloudHeaders(): Promise<Record<string, string>> {
  const { token, project } = await gcloudCredentials();
  return { authorization: `Bearer ${token}`, "x-goog-user-project": project };
}
