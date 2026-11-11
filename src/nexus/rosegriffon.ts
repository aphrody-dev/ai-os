import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertSafeUserspacePath, stripEmojis } from "./security.ts";

export type RosegriffonAction =
  | "status"
  | "check"
  | "test"
  | "nie_cli"
  | "ie_cli"
  | "wasm_verify"
  | "vfs_inspect"
  | "deploy_check";

export interface RosegriffonCliResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed?: unknown;
  durationMs: number;
}

export function resolveRosegriffonRootDir(): string {
  const defaultDir = "C:\\src\\apps\\rosegriffon";
  if (existsSync(defaultDir)) return defaultDir;
  return resolve(process.cwd());
}

export function resolveNieBinaryPath(): string {
  const localBin = join(homedir(), ".local", "bin", "nie.exe");
  if (existsSync(localBin)) return localBin;
  const workspaceBin = "C:\\src\\apps\\rosegriffon\\target\\release\\nie.exe";
  if (existsSync(workspaceBin)) return workspaceBin;
  return localBin;
}

export function resolveIeCliPath(): {
  exe: string;
  isCmd: boolean;
  scriptPath?: string;
} {
  const localCmd = join(homedir(), ".local", "bin", "ie.cmd");
  const scriptPath = "C:\\src\\apps\\rosegriffon\\apps\\cli\\src\\index.ts";
  if (existsSync(localCmd)) {
    return { exe: localCmd, isCmd: true, scriptPath };
  }
  return { exe: "bun", isCmd: false, scriptPath };
}

export function runNieCliCommand(
  args: string[],
  timeoutMs = 30_000,
): RosegriffonCliResult {
  const bin = resolveNieBinaryPath();
  const start = performance.now();
  if (!existsSync(bin)) {
    return {
      ok: false,
      exitCode: 127,
      stdout: "",
      stderr: `nie.exe binary not found at ${bin}`,
      durationMs: 0,
    };
  }

  const proc = Bun.spawnSync([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });

  const durationMs = Math.round(performance.now() - start);
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Keep raw string
  }

  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    stdout,
    stderr,
    parsed,
    durationMs,
  };
}

export function runIeCliCommand(
  args: string[],
  timeoutMs = 30_000,
): RosegriffonCliResult {
  const ieInfo = resolveIeCliPath();
  const start = performance.now();

  let cmd: string[];
  if (ieInfo.isCmd) {
    cmd = [ieInfo.exe, ...args];
  } else {
    cmd = ["bun", "run", ieInfo.scriptPath ?? "apps/cli/src/index.ts", ...args];
  }

  const proc = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: resolveRosegriffonRootDir(),
    timeout: timeoutMs,
  });

  const durationMs = Math.round(performance.now() - start);
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Keep raw string
  }

  return {
    ok: proc.exitCode === 0,
    exitCode: proc.exitCode,
    stdout,
    stderr,
    parsed,
    durationMs,
  };
}

export async function inspectRosegriffonStatus(): Promise<
  Record<string, unknown>
> {
  const root = resolveRosegriffonRootDir();
  const nieBin = resolveNieBinaryPath();
  const ieInfo = resolveIeCliPath();

  const nieExists = existsSync(nieBin);
  const ieCmdExists = existsSync(ieInfo.exe);

  let nieVersion: string | null = null;
  if (nieExists) {
    const res = runNieCliCommand(["--version"], 5000);
    if (res.ok) nieVersion = res.stdout;
  }

  let ieVersion: string | null = null;
  const ieRes = runIeCliCommand(["--version"], 5000);
  if (ieRes.ok) ieVersion = ieRes.stdout;

  const websitePackage = join(root, "apps", "rg-website", "package.json");
  let websiteInfo: Record<string, unknown> | null = null;
  if (existsSync(websitePackage)) {
    try {
      const pkg = JSON.parse(readFileSync(websitePackage, "utf8"));
      websiteInfo = {
        name: pkg.name,
        version: pkg.version,
        nextVersion: pkg.dependencies?.next,
        reactVersion: pkg.dependencies?.react,
      };
    } catch {
      // Ignore
    }
  }

  const wasmCratePath = join(root, "crates", "aphrody-nie-wasm", "Cargo.toml");
  const wasmExists = existsSync(wasmCratePath);

  const formatsCratePath = join(
    root,
    "crates",
    "aphrody-nie-formats",
    "Cargo.toml",
  );
  const formatsExists = existsSync(formatsCratePath);

  return {
    ok: true,
    workspace: root,
    tools: {
      nie: {
        path: nieBin,
        installed: nieExists,
        version: nieVersion,
      },
      ie: {
        path: ieInfo.exe,
        installed: ieCmdExists,
        version: ieVersion,
      },
    },
    packages: {
      website: websiteInfo,
      wasmCrate: { path: wasmCratePath, exists: wasmExists },
      formatsCrate: { path: formatsCratePath, exists: formatsExists },
    },
  };
}

export async function verifyRosegriffonWasm(): Promise<
  Record<string, unknown>
> {
  const root = resolveRosegriffonRootDir();
  const wasmDir = join(root, "crates", "aphrody-nie-wasm");
  if (!existsSync(wasmDir)) {
    return { ok: false, error: `Wasm crate not found at ${wasmDir}` };
  }

  const cargoPath = join(wasmDir, "Cargo.toml");
  const libRs = join(wasmDir, "src", "lib.rs");
  const teamFixtures = join(wasmDir, "src", "team-fixtures.json");
  const screenInventory = join(wasmDir, "fixtures", "screen-inventory.json");

  return {
    ok: existsSync(cargoPath) && existsSync(libRs),
    crate: "aphrody-nie-wasm",
    hasCargoToml: existsSync(cargoPath),
    hasLibRs: existsSync(libRs),
    hasTeamFixtures: existsSync(teamFixtures),
    hasScreenInventory: existsSync(screenInventory),
    libSize: existsSync(libRs) ? statSync(libRs).size : 0,
  };
}

export async function inspectRosegriffonVfs(args: {
  subcommand?: string;
  prefix?: string;
  gameDir?: string;
}): Promise<Record<string, unknown>> {
  const sub = args.subcommand ?? "info";
  if (sub === "info") {
    const res = runNieCliCommand(["info"], 10_000);
    return {
      ok: res.ok,
      command: "nie.exe info",
      output: res.stdout,
      error: res.stderr,
    };
  }

  const cliArgs = ["vfs", sub];
  if (args.prefix) cliArgs.push(args.prefix);
  if (args.gameDir) cliArgs.push("--game-dir", args.gameDir);

  const res = runNieCliCommand(cliArgs, 15_000);
  return {
    ok: res.ok,
    subcommand: sub,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    parsed: res.parsed,
  };
}

export async function checkRosegriffonDeploy(): Promise<
  Record<string, unknown>
> {
  const root = resolveRosegriffonRootDir();
  const websiteDir = join(root, "apps", "rg-website");
  const nextConfig = join(websiteDir, "next.config.ts");
  const packageJson = join(websiteDir, "package.json");
  const envLocal = join(websiteDir, ".env.local");

  const buildManifest = join(websiteDir, ".next", "BUILD_ID");
  const hasBuild = existsSync(buildManifest);
  let buildId: string | null = null;
  if (hasBuild) {
    try {
      buildId = readFileSync(buildManifest, "utf8").trim();
    } catch {
      // Ignore
    }
  }

  return {
    ok: existsSync(nextConfig) && existsSync(packageJson),
    websiteDir,
    hasNextConfig: existsSync(nextConfig),
    hasPackageJson: existsSync(packageJson),
    hasEnvLocal: existsSync(envLocal),
    hasProductionBuild: hasBuild,
    buildId,
  };
}

export async function executeRosegriffonOps(
  action: RosegriffonAction,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  switch (action) {
    case "status":
      return inspectRosegriffonStatus();

    case "check": {
      const root = resolveRosegriffonRootDir();
      const proc = Bun.spawnSync(["bun", "check"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      const stdout = new TextDecoder().decode(proc.stdout).trim();
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      return {
        ok: proc.exitCode === 0,
        exitCode: proc.exitCode,
        stdout,
        stderr,
      };
    }

    case "test": {
      const root = resolveRosegriffonRootDir();
      const target =
        typeof args.target === "string"
          ? args.target
          : "apps/cli/src/index.test.ts";
      const proc = Bun.spawnSync(["bun", "test", target], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 45_000,
      });
      const stdout = new TextDecoder().decode(proc.stdout).trim();
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      return {
        ok: proc.exitCode === 0,
        target,
        exitCode: proc.exitCode,
        stdout,
        stderr,
      };
    }

    case "nie_cli": {
      const cliArgs = Array.isArray(args.args)
        ? args.args.map(String)
        : ["--version"];
      const timeoutMs =
        typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
      const res = runNieCliCommand(cliArgs, timeoutMs);
      return {
        ok: res.ok,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        parsed: res.parsed,
        durationMs: res.durationMs,
      };
    }

    case "ie_cli": {
      const cliArgs = Array.isArray(args.args)
        ? args.args.map(String)
        : ["--help"];
      const timeoutMs =
        typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
      const res = runIeCliCommand(cliArgs, timeoutMs);
      return {
        ok: res.ok,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        parsed: res.parsed,
        durationMs: res.durationMs,
      };
    }

    case "wasm_verify":
      return verifyRosegriffonWasm();

    case "vfs_inspect":
      return inspectRosegriffonVfs({
        subcommand:
          typeof args.subcommand === "string" ? args.subcommand : "info",
        prefix: typeof args.prefix === "string" ? args.prefix : undefined,
        gameDir: typeof args.gameDir === "string" ? args.gameDir : undefined,
      });

    case "deploy_check":
      return checkRosegriffonDeploy();

    default:
      return { ok: false, error: `Unknown rosegriffon_ops action: ${action}` };
  }
}
