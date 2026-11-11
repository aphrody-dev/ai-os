import { CString, dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const AD_ABI_VERSION_MAJOR = 7;
export const AD_ACTION_SIZE = 96;

export const AdActionKindMap: Record<string, number> = {
  click: 0,
  double_click: 1,
  right_click: 2,
  triple_click: 3,
  set_value: 4,
  set_focus: 5,
  expand: 6,
  collapse: 7,
  select: 8,
  toggle: 9,
  check: 10,
  uncheck: 11,
  scroll: 12,
  scroll_to: 13,
  press_key: 14,
  key_down: 15,
  key_up: 16,
  type_text: 17,
  clear: 18,
  hover: 19,
  drag: 20,
};

export interface DesktopSnapshotOptions {
  app?: string;
  surface?: number;
  maxDepth?: number;
  interactiveOnly?: boolean;
  compact?: boolean;
}

export interface DesktopRefActionOptions {
  refId: string;
  action: keyof typeof AdActionKindMap | string;
  text?: string;
  policy?: 0 | 1 | 2;
}

export interface DesktopFfiBinding {
  readonly dllPath: string;
  readonly abiVersion: number;
  versionEnvelope(): Record<string, unknown>;
  statusEnvelope(): Record<string, unknown>;
  snapshot(opts?: DesktopSnapshotOptions): Record<string, unknown>;
  executeByRef(opts: DesktopRefActionOptions): Record<string, unknown>;
  close(): void;
}

const CANDIDATE_DLL_PATHS = [
  "C:/Users/aphro/.local/bin/agent_desktop_ffi.dll",
  "C:/src/agent-desktop/target/release-ffi/agent_desktop_ffi.dll",
  "/usr/local/lib/libagent_desktop_ffi.so",
];

const CANDIDATE_DESKTOP_CLI_PATHS = [
  "C:/Users/aphro/.local/bin/agent-desktop.exe",
  "C:/src/agent-desktop/target/release/agent-desktop.exe",
  "agent-desktop",
];

const CANDIDATE_BROWSER_CLI_PATHS = [
  "C:/Users/aphro/.local/bin/agent-browser.exe",
  "C:/src/agent-browser/cli/target/release/agent-browser.exe",
  "agent-browser",
];

export function resolveDesktopDllPath(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return resolve(explicit);
  for (const candidate of CANDIDATE_DLL_PATHS) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

export function resolveDesktopCliPath(): string {
  for (const candidate of CANDIDATE_DESKTOP_CLI_PATHS) {
    if (candidate.includes("/") && existsSync(candidate))
      return resolve(candidate);
  }
  return CANDIDATE_DESKTOP_CLI_PATHS[0]!;
}

export function resolveBrowserCliPath(): string {
  for (const candidate of CANDIDATE_BROWSER_CLI_PATHS) {
    if (candidate.includes("/") && existsSync(candidate))
      return resolve(candidate);
  }
  return CANDIDATE_BROWSER_CLI_PATHS[0]!;
}

function readOutCStringAndFree(
  outPtrBuf: BigUint64Array,
  freeFn: (p: Pointer) => void,
): string | null {
  const rawAddr = outPtrBuf[0] ?? 0n;
  if (rawAddr === 0n) return null;
  const cPtr = Number(rawAddr) as Pointer;
  try {
    return new CString(cPtr).toString();
  } finally {
    freeFn(cPtr);
  }
}

function makeNullTerminatedBytes(input: string): Uint8Array {
  const encoded = new TextEncoder().encode(input);
  const nul = new Uint8Array(encoded.length + 1);
  nul.set(encoded, 0);
  nul[encoded.length] = 0;
  return nul;
}

let singletonBinding: DesktopFfiBinding | null = null;

export function getDesktopFfi(
  explicitDllPath?: string,
): DesktopFfiBinding | null {
  if (!explicitDllPath && singletonBinding) return singletonBinding;
  const dllPath = resolveDesktopDllPath(explicitDllPath);
  if (!dllPath) return null;

  const lib = dlopen(dllPath, {
    ad_abi_version: {
      args: [],
      returns: FFIType.u32,
    },
    ad_init: {
      args: [FFIType.u32],
      returns: FFIType.i32,
    },
    ad_adapter_create: {
      args: [],
      returns: FFIType.ptr,
    },
    ad_adapter_destroy: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    ad_version: {
      args: [FFIType.ptr],
      returns: FFIType.i32,
    },
    ad_status: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    ad_snapshot: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u8,
        FFIType.bool,
        FFIType.bool,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    ad_execute_by_ref: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    ad_action_size: {
      args: [],
      returns: FFIType.u64,
    },
    ad_last_error_message: {
      args: [],
      returns: FFIType.ptr,
    },
    ad_free_string: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });

  const abiVersion = lib.symbols.ad_abi_version();
  const initCode = lib.symbols.ad_init(AD_ABI_VERSION_MAJOR);
  if (initCode !== 0) {
    lib.close();
    throw new Error(
      `agent_desktop_ffi ABI mismatch: expected major=${AD_ABI_VERSION_MAJOR}, got=${abiVersion} (code=${initCode})`,
    );
  }

  let adapterPtr = lib.symbols.ad_adapter_create();

  const readLastError = (): string => {
    const errPtr = lib.symbols.ad_last_error_message();
    if (!errPtr) return "Unknown FFI error";
    return new CString(errPtr).toString();
  };

  const ensureAdapter = (): Pointer => {
    if (!adapterPtr) {
      adapterPtr = lib.symbols.ad_adapter_create();
    }
    if (!adapterPtr) {
      throw new Error(`ad_adapter_create failed: ${readLastError()}`);
    }
    return adapterPtr as Pointer;
  };

  const binding: DesktopFfiBinding = {
    dllPath,
    abiVersion,
    versionEnvelope(): Record<string, unknown> {
      const outBuf = new BigUint64Array(1);
      const rc = lib.symbols.ad_version(ptr(outBuf));
      const jsonStr = readOutCStringAndFree(outBuf, (p) =>
        lib.symbols.ad_free_string(p),
      );
      if (!jsonStr) {
        return { ok: false, code: rc, error: readLastError() };
      }
      return JSON.parse(jsonStr) as Record<string, unknown>;
    },
    statusEnvelope(): Record<string, unknown> {
      const adp = ensureAdapter();
      const outBuf = new BigUint64Array(1);
      const rc = lib.symbols.ad_status(adp, ptr(outBuf));
      const jsonStr = readOutCStringAndFree(outBuf, (p) =>
        lib.symbols.ad_free_string(p),
      );
      if (!jsonStr) {
        return { ok: false, code: rc, error: readLastError() };
      }
      return JSON.parse(jsonStr) as Record<string, unknown>;
    },
    snapshot(opts: DesktopSnapshotOptions = {}): Record<string, unknown> {
      const adp = ensureAdapter();
      const outBuf = new BigUint64Array(1);
      const appBytes = opts.app ? makeNullTerminatedBytes(opts.app) : null;
      const appPtr = appBytes ? ptr(appBytes) : null;
      const surface = opts.surface ?? 0;
      const maxDepth = opts.maxDepth ?? 8;
      const interactiveOnly = opts.interactiveOnly ?? true;
      const compact = opts.compact ?? true;

      const rc = lib.symbols.ad_snapshot(
        adp,
        appPtr,
        surface,
        maxDepth,
        interactiveOnly,
        compact,
        ptr(outBuf),
      );
      const jsonStr = readOutCStringAndFree(outBuf, (p) =>
        lib.symbols.ad_free_string(p),
      );
      if (!jsonStr) {
        return { ok: false, code: rc, error: readLastError() };
      }
      return JSON.parse(jsonStr) as Record<string, unknown>;
    },
    executeByRef(opts: DesktopRefActionOptions): Record<string, unknown> {
      const adp = ensureAdapter();
      const actionSize = Number(
        lib.symbols.ad_action_size() || BigInt(AD_ACTION_SIZE),
      );
      const actionBuf = new Uint8Array(Math.max(actionSize, AD_ACTION_SIZE));
      const view = new DataView(actionBuf.buffer);
      const kindDisc = AdActionKindMap[opts.action] ?? 0;
      view.setInt32(0, kindDisc, true);

      let textBytes: Uint8Array | null = null;
      if (opts.text !== undefined) {
        textBytes = makeNullTerminatedBytes(opts.text);
        const textAddr = BigInt(ptr(textBytes));
        view.setBigUint64(8, textAddr, true);
      }

      const refBytes = makeNullTerminatedBytes(opts.refId);
      const outBuf = new BigUint64Array(1);
      const policy = opts.policy ?? 0;

      const rc = lib.symbols.ad_execute_by_ref(
        adp,
        ptr(refBytes),
        ptr(actionBuf),
        policy,
        ptr(outBuf),
      );
      const jsonStr = readOutCStringAndFree(outBuf, (p) =>
        lib.symbols.ad_free_string(p),
      );
      if (!jsonStr) {
        return { ok: false, code: rc, error: readLastError() };
      }
      return JSON.parse(jsonStr) as Record<string, unknown>;
    },
    close(): void {
      if (adapterPtr) {
        lib.symbols.ad_adapter_destroy(adapterPtr);
        adapterPtr = null;
      }
      lib.close();
      if (singletonBinding === binding) {
        singletonBinding = null;
      }
    },
  };

  if (!explicitDllPath) {
    singletonBinding = binding;
  }
  return binding;
}

export async function runDesktopCli(
  args: string[],
  timeoutMs = 15000,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed?: unknown;
}> {
  const bin = resolveDesktopCliPath();
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // raw text output
  }
  return { exitCode, stdout, stderr, parsed };
}

export async function runBrowserCli(
  args: string[],
  timeoutMs = 20000,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed?: unknown;
}> {
  const bin = resolveBrowserCliPath();
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // raw text output
  }
  return { exitCode, stdout, stderr, parsed };
}
