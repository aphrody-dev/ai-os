// Cross-platform Bun.Terminal PTY manager backed by Pure C11 VTerm (`@aphrody/core`).
// Discovers shells (Niubash, PowerShell 7, Nushell, OpenCode TUI, cmd) & SSH aliases with OSC 133 hooks.
import { VTerm, type VTermBlock, type VTermMeta } from "@aphrody/core";
import { dlopen, FFIType } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let winCtrlFixed = false;
function ensureWindowsCtrlHandler() {
  if (winCtrlFixed || process.platform !== "win32") return;
  winCtrlFixed = true;
  try {
    const k32 = dlopen("kernel32.dll", {
      SetConsoleCtrlHandler: {
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    // Allow ConPTY child shells/TUIs to inherit CTRL+C instead of swallowing or killing parent
    k32.symbols.SetConsoleCtrlHandler(null, 0);
  } catch {}
}

export interface TermProfile {
  id: string;
  label: string;
  argv: string[];
  kind: "shell" | "ai-tui" | "ssh";
  available: boolean;
}

export interface TermEvent {
  type: "data" | "block_error" | "exit" | "meta" | "clipboard";
  paneId: string;
  chunk?: Uint8Array;
  block?: VTermBlock;
  outputTail?: string;
  text?: string;
  exitCode?: number | null;
  meta?: VTermMeta;
}

export interface TermPaneSummary {
  id: string;
  profile: string;
  label: string;
  cwd: string;
  cols: number;
  rows: number;
  title: string;
  alive: boolean;
  exitCode: number | null;
  failedCount: number;
  lastExitCode: number;
  altScreen: boolean;
  themeSlug: string;
}

export type TermSubscriber = (ev: TermEvent) => void;

const textDec = new TextDecoder();
const MAX_REPLAY_BYTES = 24 * 1024;

function readSshAliases(): string[] {
  const f = Bun.env.RELAY_SSH_CONFIG ?? join(homedir(), ".ssh", "config");
  if (!existsSync(f)) return [];
  const t = readFileSync(f, "utf8");
  return [
    ...new Set(
      [...t.matchAll(/^\s*Host\s+(.+)$/gim)]
        .flatMap((m) => m[1]!.split(/\s+/))
        .filter((h) => h && !/[*?!]/.test(h)),
    ),
  ].sort();
}

function resolveBin(name: string): string | null {
  const candidates =
    process.platform === "win32" && name === "niubash"
      ? [
          join(
            homedir(),
            "AppData",
            "Local",
            "Programs",
            "Niubash",
            "winuxcmd",
            "usr",
            "bin",
            "bash.exe",
          ),
          join(
            homedir(),
            "AppData",
            "Local",
            "Programs",
            "Niubash",
            "winuxcmd",
            "bin",
            "bash.exe",
          ),
        ]
      : [];
  for (const c of candidates) if (existsSync(c)) return c;
  return Bun.which(name);
}

function ensureBashInitFile(): string {
  const dir = join(homedir(), ".local", "state", "aphrody", "term");
  mkdirSync(dir, { recursive: true });
  const initPath = join(dir, "bash-init.sh");
  const script = [
    "[ -f ~/.bashrc ] && . ~/.bashrc",
    '__ay_osc133_precmd() { local rc=$?; printf "\\e]133;D;%d\\a\\e]133;A\\a" "$rc"; }',
    'PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__ay_osc133_precmd"',
    "PS0='\\e]133;C\\a'",
    'PS1="${PS1}\\[\\e]133;B\\a\\]"',
  ].join("\n");
  writeFileSync(initPath, `${script}\n`, "utf8");
  return initPath.replace(/\\/g, "/");
}

function pwshInitCommand(): string {
  return [
    "$global:__ayFirstPrompt = $true;",
    "function global:prompt {",
    "  $ok = $?;",
    "  $rc = if ($ok) { 0 } elseif ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } else { 1 };",
    "  $e = [char]27; $a = [char]7;",
    '  $prefix = if ($global:__ayFirstPrompt) { $global:__ayFirstPrompt = $false; "${e}]133;A${a}" } else { "${e}]133;D;${rc}${a}${e}]133;A${a}" };',
    "  $loc = (Get-Location).Path;",
    '  "${prefix}PS ${loc}> ${e}]133;B${a}"',
    "}",
  ].join(" ");
}

export function discoverProfiles(): TermProfile[] {
  const out: TermProfile[] = [];
  const niubash = resolveBin("niubash");
  const bash = niubash ?? resolveBin("bash");
  const initBash = bash ? ensureBashInitFile() : "";
  if (niubash) {
    out.push({
      id: "niubash",
      label: "Niubash",
      argv: [niubash, "--init-file", initBash, "-i"],
      kind: "shell",
      available: true,
    });
  } else if (bash) {
    out.push({
      id: "bash",
      label: "Bash",
      argv: [bash, "--init-file", initBash, "-i"],
      kind: "shell",
      available: true,
    });
  }

  const pwsh = resolveBin("pwsh");
  if (pwsh) {
    out.push({
      id: "pwsh",
      label: "PowerShell 7",
      argv: [pwsh, "-NoLogo", "-NoExit", "-Command", pwshInitCommand()],
      kind: "shell",
      available: true,
    });
  }

  const nu = resolveBin("nu");
  if (nu) {
    out.push({
      id: "nu",
      label: "Nushell",
      argv: [nu],
      kind: "shell",
      available: true,
    });
  }

  const opencode = resolveBin("opencode");
  if (opencode) {
    out.push({
      id: "opencode",
      label: "OpenCode TUI",
      argv: [opencode],
      kind: "ai-tui",
      available: true,
    });
  }

  if (process.platform === "win32") {
    out.push({
      id: "cmd",
      label: "Command Prompt",
      argv: [Bun.env.ComSpec ?? "cmd.exe", "/Q"],
      kind: "shell",
      available: true,
    });
  }

  const ssh = resolveBin("ssh");
  if (ssh) {
    for (const host of readSshAliases()) {
      out.push({
        id: `ssh:${host}`,
        label: `SSH ${host}`,
        argv: [ssh, host],
        kind: "ssh",
        available: true,
      });
    }
  }
  return out;
}

export class TermPane {
  readonly id: string;
  readonly profile: string;
  readonly label: string;
  readonly cwd: string;
  readonly vterm: VTerm;
  readonly term: Bun.Terminal;
  readonly proc: Bun.Subprocess;
  cols: number;
  rows: number;
  themeSlug: string;
  alive = true;
  exitCode: number | null = null;
  private lastFailedCount = 0;
  private replayBuf: Uint8Array[] = [];
  private replayBytes = 0;
  private subscribers = new Set<TermSubscriber>();

  constructor(opts: {
    id: string;
    profile: string;
    label: string;
    argv: string[];
    cwd: string;
    cols: number;
    rows: number;
    themeSlug: string;
  }) {
    this.id = opts.id;
    this.profile = opts.profile;
    this.label = opts.label;
    this.cwd = opts.cwd;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.themeSlug = opts.themeSlug;
    this.vterm = new VTerm(opts.cols, opts.rows, opts.themeSlug);

    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "aphrody-term",
      LANG: process.env.LANG ?? "en_US.UTF-8",
    } as Record<string, string>;

    this.term = new Bun.Terminal({
      cols: opts.cols,
      rows: opts.rows,
      data: (_t, bytes) => this.onData(bytes),
      exit: (_t, code) => this.onExit(code),
    });

    ensureWindowsCtrlHandler();
    this.proc = Bun.spawn(opts.argv, {
      cwd: opts.cwd,
      env,
      terminal: this.term,
    });
    this.proc.exited.then((code) => this.onExit(code));
  }

  private onData(raw: Uint8Array): void {
    const chunk = new Uint8Array(raw);
    this.vterm.feed(chunk);

    // Respond immediately to terminal device queries (CPR CSI 6n, DA1/DA2, DECRQM, OSC 10/11)
    const replies = this.vterm.drainReplies();
    if (replies.byteLength > 0 && this.alive) {
      try {
        this.term.write(textDec.decode(replies));
      } catch {}
    }

    this.replayBuf.push(chunk);
    this.replayBytes += chunk.byteLength;
    while (this.replayBytes > MAX_REPLAY_BYTES && this.replayBuf.length > 1) {
      const dropped = this.replayBuf.shift()!;
      this.replayBytes -= dropped.byteLength;
    }

    this.emit({ type: "data", paneId: this.id, chunk });

    const meta = this.vterm.meta();
    if (meta.clipDirty) {
      const clipText = this.vterm.drainClipboard();
      if (clipText) {
        this.emit({ type: "clipboard", paneId: this.id, text: clipText });
      }
    }
    if (meta.failedCount > this.lastFailedCount) {
      this.lastFailedCount = meta.failedCount;
      const blocks = this.vterm.blocks();
      const failedBlock = [...blocks].reverse().find((b) => b.failed);
      if (failedBlock) {
        const rows: string[] = [];
        for (let r = failedBlock.outRow; r <= failedBlock.endRow; r++) {
          rows.push(this.vterm.rowText(r));
        }
        this.emit({
          type: "block_error",
          paneId: this.id,
          block: failedBlock,
          outputTail: rows.join("\n").trim().slice(-2000),
          meta,
        });
      }
    }
  }

  private onExit(code: number | null): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = code ?? 0;
    try {
      this.term.close();
    } catch {}
    this.emit({ type: "exit", paneId: this.id, exitCode: this.exitCode });
  }

  private emit(ev: TermEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch {}
    }
  }

  subscribe(fn: TermSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  replayChunks(): Uint8Array[] {
    return this.replayBuf;
  }

  write(data: string | Uint8Array): void {
    if (!this.alive) return;
    this.term.write(typeof data === "string" ? data : textDec.decode(data));
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(2, Math.min(240, Math.floor(cols)));
    const r = Math.max(1, Math.min(80, Math.floor(rows)));
    this.cols = c;
    this.rows = r;
    this.vterm.resize(c, r);
    if (this.alive) {
      try {
        this.term.resize(c, r);
      } catch {}
    }
  }

  setTheme(slug: string): number {
    this.themeSlug = slug;
    return this.vterm.setTheme(slug);
  }

  scrollLines(delta: number): number {
    return this.vterm.scrollLines(delta);
  }

  setScroll(offset: number): number {
    return this.vterm.setScroll(offset);
  }

  scrollbackText(startOldest = 0, rowCount = 1024): string {
    return this.vterm.scrollbackText(startOldest, rowCount);
  }

  summary(): TermPaneSummary {
    const m = this.vterm.meta();
    return {
      id: this.id,
      profile: this.profile,
      label: this.label,
      cwd: this.cwd,
      cols: m.cols,
      rows: m.rows,
      title: m.title || this.label,
      alive: this.alive,
      exitCode: this.exitCode,
      failedCount: m.failedCount,
      lastExitCode: m.lastExitCode,
      altScreen: m.altScreen,
      themeSlug: this.themeSlug,
    };
  }

  close(): void {
    if (this.alive) {
      this.alive = false;
      try {
        this.proc.kill();
      } catch {}
      try {
        this.term.close();
      } catch {}
      this.emit({ type: "exit", paneId: this.id, exitCode: this.exitCode });
    }
    this.subscribers.clear();
  }
}

export class TermManager {
  private panes = new Map<string, TermPane>();
  private seq = 0;

  profiles(): TermProfile[] {
    return discoverProfiles();
  }

  spawn(
    opts: {
      profile?: string;
      argv?: string[];
      cwd?: string;
      cols?: number;
      rows?: number;
      theme?: string;
    } = {},
  ): TermPane {
    const profiles = discoverProfiles();
    const chosen = opts.profile
      ? profiles.find((p) => p.id === opts.profile)
      : profiles[0];
    const argv = opts.argv ?? chosen?.argv;
    if (!argv || argv.length === 0) {
      throw new Error(`Unknown terminal profile: ${opts.profile ?? "default"}`);
    }
    const id = `pane-${++this.seq}-${Date.now().toString(36)}`;
    const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : process.cwd();
    const pane = new TermPane({
      id,
      profile: opts.profile ?? chosen?.id ?? "custom",
      label: chosen?.label ?? argv[0]!,
      argv,
      cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 34,
      themeSlug: opts.theme ?? "aphrody-m3-dark",
    });
    this.panes.set(id, pane);
    return pane;
  }

  get(id: string): TermPane | undefined {
    return this.panes.get(id);
  }

  first(): TermPane | undefined {
    return this.panes.values().next().value;
  }

  list(): TermPaneSummary[] {
    return [...this.panes.values()].map((p) => p.summary());
  }

  close(id: string): boolean {
    const p = this.panes.get(id);
    if (!p) return false;
    p.close();
    this.panes.delete(id);
    return true;
  }

  closeAll(): void {
    for (const p of this.panes.values()) p.close();
    this.panes.clear();
  }
}

let shared: TermManager | undefined;
export function sharedTermManager(): TermManager {
  return (shared ??= new TermManager());
}
