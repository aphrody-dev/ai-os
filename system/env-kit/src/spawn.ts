// Node-shaped synchronous spawn over Bun.spawnSync (https://bun.com/docs/runtime/child-process).
// Bun.spawnSync has no `shell` option, throws on a missing binary and reports `exitCode`; callers of this package
// read `status`, `stdout`, `stderr` and `error` and rely on `shell`, `input`, `timeout`, `windowsVerbatimArguments`.
type Stdio = "pipe" | "inherit" | "ignore";

export type SpawnSyncOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** written to the child's stdin */
  input?: string | Uint8Array;
  timeout?: number;
  maxBuffer?: number;
  /** run `cmd args` through cmd.exe /d /s /c (Windows) or /bin/sh -c, arguments joined by spaces as Node does */
  shell?: boolean;
  stdio?: Stdio | [Stdio, Stdio, Stdio];
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
};

export type SpawnSyncResult = {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: Error;
  pid: number;
};

export function spawnSync(cmd: string, args: readonly string[] = [], o: SpawnSyncOptions = {}): SpawnSyncResult {
  const [sin, sout, serr] = Array.isArray(o.stdio) ? o.stdio : [o.stdio ?? "pipe", o.stdio ?? "pipe", o.stdio ?? "pipe"];
  const line = [cmd, ...args].join(" ");
  const argv = o.shell
    ? process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", `"${line}"`]
      : ["/bin/sh", "-c", line]
    : [cmd, ...args];
  try {
    const r = Bun.spawnSync(argv, {
      cwd: o.cwd,
      env: o.env,
      stdin: o.input === undefined ? (sin === "pipe" ? "ignore" : sin) : typeof o.input === "string" ? Buffer.from(o.input) : o.input,
      stdout: sout,
      stderr: serr,
      timeout: o.timeout,
      maxBuffer: o.maxBuffer,
      windowsHide: o.windowsHide,
      windowsVerbatimArguments: o.windowsVerbatimArguments || (o.shell && process.platform === "win32"),
    });
    const timedOut = r.exitedDueToTimeout === true;
    return {
      status: r.signalCode || timedOut ? null : r.exitCode,
      signal: typeof r.signalCode === "string" ? r.signalCode : timedOut ? "SIGTERM" : null,
      stdout: r.stdout?.toString("utf8") ?? "",
      stderr: r.stderr?.toString("utf8") ?? "",
      error: timedOut ? Object.assign(new Error(`spawnSync ${cmd} ETIMEDOUT`), { code: "ETIMEDOUT" }) : undefined,
      pid: r.pid,
    };
  } catch (e) {
    return { status: null, signal: null, stdout: "", stderr: "", error: e as Error, pid: 0 };
  }
}
