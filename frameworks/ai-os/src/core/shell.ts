// Native shell resolution, ported from the windows-native patches of our forks
// (OpenClaw OPENCLAW_EXEC_SHELL/OPENCLAW_BASH, Hermes HERMES_BASH + niubash candidate; see
// docs/agents/WINDOWS-NATIVE-PORT.md). Never picks the System32 WSL bash stub.
// Sandboxed bash execution uses the extracted Vercel core (`../vercel/sandbox`).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSandboxed } from "./sandbox";

export function resolveBash(env = Bun.env): string | undefined {
  const candidates = [
    env.AGENT_BASH,
    env.OPENCLAW_BASH,
    env.HERMES_BASH,
    process.platform === "win32" && env.LOCALAPPDATA
      ? join(
          env.LOCALAPPDATA,
          "Programs",
          "Niubash",
          "winuxcmd",
          "bin",
          "bash.exe",
        )
      : undefined,
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  const found = Bun.which("bash");
  if (
    found &&
    !(process.platform === "win32" && /\\system32\\bash\.exe$/i.test(found))
  )
    return found;
  return undefined;
}

/** Run a bash script in an in-memory OverlaySandbox over `cwd` (extracted from vercel-labs/just-bash & tool-bash). */
export async function runJustBash(
  script: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execSandboxed(script, cwd);
}
