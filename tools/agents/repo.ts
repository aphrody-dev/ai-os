// The GitHub repository of the checkout the agents work in, `<owner>/<name>`: $AGENTS_SRC_REPO, else the origin remote.
import { resolve } from "node:path";

export function srcRepo(cwd: string = resolve(import.meta.dir, "..", "..")): string | undefined {
  const explicit = process.env.AGENTS_SRC_REPO?.trim();
  if (explicit) return explicit;
  const r = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(r.stdout.toString().trim())?.[1];
}
