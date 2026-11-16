// OS boundary for the launcher (judge N4). Pure functions, no I/O: the launcher spawns, tests inspect.
// Route chosen: Claude Code inside WSL2 with the built-in sandbox (bubblewrap), failing closed.
export type SandboxMode = "wsl" | "native" | "off";

export const SECRET_READ_DENY = [
  "~/**/.env",
  "~/**/.env.*",
  "~/.ssh",
  "~/.aws",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.local/share/aphrody-vault",
];

export function resolveSandbox(
  requested: string | undefined,
  platform: string,
): SandboxMode {
  if (requested === "wsl" || requested === "native" || requested === "off")
    return requested;
  if (requested) throw new Error(`--sandbox: wsl|native|off, got ${requested}`);
  return platform === "win32" ? "wsl" : "off";
}

// `.env.example` is committed and harmless: re-open it under the denied glob (narrower path wins).
export function sandboxSettings(o: {
  writeRoots: string[];
  protectedGit?: string[];
}): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      filesystem: {
        allowWrite: o.writeRoots,
        denyRead: SECRET_READ_DENY,
        allowRead: ["~/**/.env.example"],
        denyWrite: (o.protectedGit ?? []).flatMap((g) => [
          `${g}/hooks`,
          `${g}/config`,
        ]),
      },
    },
  });
}

// <drive>:\x -> /mnt/<drive>/x ; already-POSIX paths pass through. UNC and other forms are refused.
export function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m) return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`;
  if (/^[A-Za-z]:$/.test(p)) return `/mnt/${p[0]!.toLowerCase()}`;
  if (p.startsWith("/")) return p;
  throw new Error(`cannot map ${p} to a WSL path`);
}

export function wslArgv(o: {
  distro?: string;
  cwd: string;
  env: Record<string, string>;
  claudeArgs: string[];
}): string[] {
  const envPairs = Object.entries(o.env).map(([k, v]) => `${k}=${v}`);
  return [
    "wsl.exe",
    ...(o.distro ? ["-d", o.distro] : []),
    "--cd",
    toWslPath(o.cwd),
    "--exec",
    "env",
    ...envPairs,
    ...o.claudeArgs,
  ];
}
