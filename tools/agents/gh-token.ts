// NHITL GitHub App (`aphrody-labs`, id 5738700) token minter, Git credential helper & `gh` wrapper.
// Cross-platform: Windows DPAPI (`system/env-kit/vault/src/sync-store.ts`) + Linux `systemd-creds --user`.
// Caches installation tokens in `<AGENTS_HOME>/state/gh-token.json` (0600) and refreshes 10 min before expiry.
// Never prints raw tokens to a TTY.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
  appJwt,
  installationToken,
} from "@aphrody/env-kit/github-app";
import { secretGet } from "@aphrody/env-kit/vault/sync";

export const AGENT_PERMISSIONS: Record<string, "read" | "write" | "admin"> = {
  administration: "write",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "write",
  workflows: "write",
  packages: "write",
  checks: "write",
  statuses: "write",
  security_events: "write",
  secret_scanning_alerts: "write",
  vulnerability_alerts: "read",
  organization_administration: "write",
  organization_secrets: "write",
};
const MARGIN_MS = 600_000;

const SRC = resolve(process.env.SRC_ROOT ?? join(import.meta.dir, "..", ".."));
const HOME = resolve(process.env.AGENTS_HOME ?? join(SRC, "var", "agents"));
const CACHE = join(HOME, "state", "gh-token.json");

function cred(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const val = secretGet(name);
    if (val) return val.trim();
  } catch {}
  if (process.platform === "linux") {
    const f = join(
      process.env.HOME ?? "",
      ".config",
      "credstore.encrypted",
      name,
    );
    if (existsSync(f)) {
      const r = Bun.spawnSync(
        ["systemd-creds", "--user", `--name=${name}`, "decrypt", f, "-"],
        { stdin: "ignore" },
      );
      if (r.exitCode === 0) return r.stdout.toString("utf8").trim();
    }
  }
  return undefined;
}

/** Valid installation token (>= 10 min remaining TTL); undefined if App keys are absent. */
export async function token(
  owner = "aphrody-labs",
  now = Date.now(),
): Promise<string | undefined> {
  const cacheFile = owner === "aphrody-labs" ? CACHE : `${CACHE}.${owner}`;
  try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8")) as {
      token: string;
      expires_at: string;
    };
    if (Date.parse(c.expires_at) - now > MARGIN_MS) return c.token;
  } catch {}
  const pem = cred("APHRODY_APP_KEY");
  const cid = cred("APHRODY_APP_CLIENT_ID");
  if (!pem || !cid) return undefined;
  const t = await installationToken({
    owner,
    permissions: AGENT_PERMISSIONS,
    jwt: appJwt(pem, cid),
  });
  mkdirSync(join(HOME, "state"), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}`;
  writeFileSync(
    tmp,
    JSON.stringify({
      token: t.token,
      expires_at: t.expires_at,
      installation: t.installation,
    }),
    { mode: 0o600 },
  );
  renameSync(tmp, cacheFile);
  return t.token;
}

/** Writes cross-platform `gh` wrapper (`gh` + `gh.cmd` on Windows) injecting fresh App token on every call. */
export function installWrapper(dir: string): string | undefined {
  const isWin = process.platform === "win32";
  const binName = isWin ? "gh.exe" : "gh";
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(
        (d) => d && resolve(d).toLowerCase() !== resolve(dir).toLowerCase(),
      )
      .map((d) => join(d, binName)),
    ...(isWin ? ["C:\\Program Files\\GitHub CLI\\gh.exe"] : ["/usr/bin/gh"]),
  ];
  const real = candidates.find((p) => existsSync(p));
  if (!real) return undefined;

  mkdirSync(dir, { recursive: true });
  const scriptPath = join(import.meta.dir, "gh-token.ts").replaceAll("\\", "/");
  const bunPath = process.execPath.replaceAll("\\", "/");

  const shFile = join(dir, "gh");
  const shBody = `#!/bin/sh\nt=$("${bunPath}" "${scriptPath}") && [ -n "$t" ] && GH_TOKEN="$t" && GITHUB_TOKEN="$t" && export GH_TOKEN GITHUB_TOKEN\nexec "${real.replaceAll("\\", "/")}" "$@"\n`;
  writeFileSync(shFile, shBody);
  try {
    chmodSync(shFile, 0o755);
  } catch {}

  if (isWin) {
    const cmdFile = join(dir, "gh.cmd");
    const cmdBody = `@echo off\r\nsetlocal\r\nfor /f "usebackq delims=" %%T in (\`""${process.execPath}" "${join(import.meta.dir, "gh-token.ts")}""\`) do (\r\n  set "GH_TOKEN=%%T"\r\n  set "GITHUB_TOKEN=%%T"\r\n)\r\n"${real}" %*\r\n`;
    writeFileSync(cmdFile, cmdBody);
    return cmdFile;
  }
  return shFile;
}

if (import.meta.main) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  if (cmd === "install") {
    console.log(installWrapper(resolve(arg ?? join(HOME, "bin"))) ?? "");
    process.exit(0);
  }
  if (cmd === "exec") {
    const argv = arg === "--" ? rest : [arg, ...rest].filter(Boolean);
    const t = await token();
    if (!t) {
      console.error("gh-token: failed to mint GitHub App installation token");
      process.exit(1);
    }
    // Node's shell:true on Windows is cmd.exe /d /s /c with the arguments joined verbatim.
    const win = process.platform === "win32";
    const r = Bun.spawnSync(win ? ["cmd.exe", "/d", "/s", "/c", `"${argv.join(" ")}"`] : argv, {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, GH_TOKEN: t, GITHUB_TOKEN: t },
      windowsVerbatimArguments: win,
    });
    process.exit(r.signalCode ? 1 : r.exitCode);
  }
  if (cmd === "status") {
    const t = await token();
    const c = existsSync(CACHE)
      ? JSON.parse(readFileSync(CACHE, "utf8"))
      : null;
    console.log(
      JSON.stringify({
        ok: Boolean(t),
        app: "aphrody-labs",
        installation: c?.installation ?? null,
        expires_at: c?.expires_at ?? null,
      }),
    );
    process.exit(t ? 0 : 1);
  }
  if (cmd === "git") {
    if (arg !== "get") process.exit(0);
    const input = await Bun.stdin.text();
    if (!/^host=github\.com$/m.test(input)) process.exit(0);
    const t = await token();
    if (t) process.stdout.write(`username=x-access-token\npassword=${t}\n`);
    process.exit(0);
  }
  if (process.stdout.isTTY) {
    console.error(
      "gh-token: token never printed to a TTY (use `status`, `exec -- <cmd>`, or pipe)",
    );
    process.exit(2);
  }
  const t = await token();
  if (!t) process.exit(1);
  process.stdout.write(t);
}
