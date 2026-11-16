// Extracted & merged from third_party/vercel-ai/packages/tool-bash + third_party/just-bash (Apache-2.0):
// Zero-dependency copy-on-write OverlayFs + sandboxed shell interpreter for Bun.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";

export type SandboxResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function limitOutput(output: string, maxLength = 30_000): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n[Output truncated: ${output.length - maxLength} characters omitted.]`;
}

export class OverlaySandbox {
  private readonly files = new Map<string, string>();
  private readonly deleted = new Set<string>();
  private readonly dirs = new Set<string>(["/"]);
  readonly env: Record<string, string> = { HOME: "/home/user", PWD: "/" };
  cwd = "/";

  constructor(readonly root: string) {}

  private norm(p: string): string {
    return posix.resolve(this.cwd, p);
  }

  private hostPath(vpath: string): string | null {
    const rel = vpath.replace(/^\/+/, "");
    const abs = resolve(this.root, rel);
    const r = relative(this.root, abs);
    if (r.startsWith("..") || isAbsolute(r)) return null;
    return abs;
  }

  exists(p: string): boolean {
    const vp = this.norm(p);
    if (this.deleted.has(vp)) return false;
    if (this.files.has(vp) || this.dirs.has(vp)) return true;
    const hp = this.hostPath(vp);
    return hp ? existsSync(hp) : false;
  }

  read(p: string): string | null {
    const vp = this.norm(p);
    if (this.deleted.has(vp)) return null;
    if (this.files.has(vp)) return this.files.get(vp)!;
    const hp = this.hostPath(vp);
    if (!hp || !existsSync(hp) || statSync(hp).isDirectory()) return null;
    return readFileSync(hp, "utf8");
  }

  write(p: string, content: string, append = false): void {
    const vp = this.norm(p);
    this.deleted.delete(vp);
    this.dirs.add(posix.dirname(vp));
    const prev = append ? (this.read(vp) ?? "") : "";
    this.files.set(vp, prev + content);
  }

  remove(p: string): boolean {
    const vp = this.norm(p);
    if (!this.exists(vp)) return false;
    this.files.delete(vp);
    this.deleted.add(vp);
    return true;
  }

  list(p = "."): string[] {
    const vp = this.norm(p);
    const out = new Set<string>();
    const hp = this.hostPath(vp);
    if (hp && existsSync(hp) && statSync(hp).isDirectory()) {
      for (const name of readdirSync(hp)) {
        const child = posix.join(vp, name);
        if (!this.deleted.has(child)) out.add(name);
      }
    }
    const prefix = vp === "/" ? "/" : `${vp}/`;
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        if (rest && !rest.includes("/")) out.add(rest);
      }
    }
    return [...out].sort();
  }
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) (out.push(cur), (cur = ""));
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function splitChain(script: string): { op: ";" | "&&" | "||"; cmd: string }[] {
  const parts: { op: ";" | "&&" | "||"; cmd: string }[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let op: ";" | "&&" | "||" = ";";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (cur.trim()) parts.push({ op, cmd: cur.trim() });
      cur = "";
      op = ";";
    } else if (script.slice(i, i + 2) === "&&") {
      if (cur.trim()) parts.push({ op, cmd: cur.trim() });
      cur = "";
      op = "&&";
      i++;
    } else if (script.slice(i, i + 2) === "||") {
      if (cur.trim()) parts.push({ op, cmd: cur.trim() });
      cur = "";
      op = "||";
      i++;
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push({ op, cmd: cur.trim() });
  return parts;
}

function runOne(fs: OverlaySandbox, raw: string, stdin = ""): SandboxResult {
  const pipes = raw.split("|").map((s) => s.trim());
  if (pipes.length > 1) {
    let curIn = stdin;
    let last: SandboxResult = { stdout: "", stderr: "", exitCode: 0 };
    for (const seg of pipes) {
      last = runOne(fs, seg, curIn);
      curIn = last.stdout;
    }
    return last;
  }

  let redirect: { file: string; append: boolean } | undefined;
  let cmdStr = raw;
  const redir = raw.match(/^(.*?)\s*(>>?)\s*(\S+)\s*$/);
  if (redir) {
    cmdStr = redir[1]!;
    redirect = { file: redir[3]!, append: redir[2] === ">>" };
  }

  const args = tokenize(cmdStr).map((a) =>
    a.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => fs.env[k] ?? ""),
  );
  const cmd = args.shift();
  if (!cmd) return { stdout: "", stderr: "", exitCode: 0 };

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  switch (cmd) {
    case "echo":
      stdout = `${args.join(" ")}\n`;
      break;
    case "pwd":
      stdout = `${fs.cwd}\n`;
      break;
    case "cd": {
      const target = args[0] ?? "/";
      fs.cwd = posix.resolve(fs.cwd, target);
      fs.env.PWD = fs.cwd;
      break;
    }
    case "ls": {
      const target = args.find((a) => !a.startsWith("-")) ?? ".";
      stdout = fs
        .list(target)
        .map((x) => `${x}\n`)
        .join("");
      break;
    }
    case "cat": {
      if (!args.length) stdout = stdin;
      else {
        for (const f of args) {
          const text = fs.read(f);
          if (text === null) {
            stderr += `cat: ${f}: No such file or directory\n`;
            exitCode = 1;
          } else stdout += text;
        }
      }
      break;
    }
    case "head": {
      const nIdx = args.indexOf("-n");
      const n = nIdx >= 0 ? Number(args[nIdx + 1] ?? 10) : 10;
      const files = args.filter((_, i) => i !== nIdx && i !== nIdx + 1);
      const src = files.length ? (fs.read(files[0]!) ?? "") : stdin;
      stdout = src.split("\n").slice(0, n).join("\n");
      if (stdout && !stdout.endsWith("\n")) stdout += "\n";
      break;
    }
    case "wc": {
      const src =
        args[0] && !args[0].startsWith("-") ? (fs.read(args[0]) ?? "") : stdin;
      const lines = src
        ? src.split("\n").length - (src.endsWith("\n") ? 1 : 0)
        : 0;
      stdout = args.includes("-l")
        ? `${lines}\n`
        : `${lines} ${src.trim().split(/\s+/).filter(Boolean).length} ${src.length}\n`;
      break;
    }
    case "rm": {
      for (const f of args.filter((a) => !a.startsWith("-"))) {
        if (!fs.remove(f)) {
          stderr += `rm: ${f}: No such file or directory\n`;
          exitCode = 1;
        }
      }
      break;
    }
    case "export": {
      for (const kv of args) {
        const eq = kv.indexOf("=");
        if (eq > 0) fs.env[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      break;
    }
    case "env":
      stdout = Object.entries(fs.env)
        .map(([k, v]) => `${k}=${v}\n`)
        .join("");
      break;
    case "true":
      break;
    case "false":
      exitCode = 1;
      break;
    default:
      stderr = `${cmd}: command not found in sandbox\n`;
      exitCode = 127;
  }

  if (redirect && exitCode === 0) {
    fs.write(redirect.file, stdout, redirect.append);
    stdout = "";
  }
  return { stdout, stderr, exitCode };
}

export function execSandboxed(
  script: string,
  cwd: string,
  opts: { maxOutputLength?: number } = {},
): SandboxResult {
  const fs = new OverlaySandbox(resolve(cwd));
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const step of splitChain(script)) {
    if (step.op === "&&" && exitCode !== 0) continue;
    if (step.op === "||" && exitCode === 0) continue;
    const r = runOne(fs, step.cmd);
    stdout += r.stdout;
    stderr += r.stderr;
    exitCode = r.exitCode;
  }
  return {
    stdout: limitOutput(stdout, opts.maxOutputLength),
    stderr: limitOutput(stderr, opts.maxOutputLength),
    exitCode,
  };
}

// Extracted from vercel-labs/run (Apache-2.0): isolated Worker JS sandbox with timeout,
// prototype/host-global guards, and async host-function bridge.
export type JsRunOptions = {
  timeoutMs?: number;
  maxSourceBytes?: number;
  globals?: Record<string, unknown>;
  hostFunctions?: Record<
    string,
    (...args: unknown[]) => unknown | Promise<unknown>
  >;
};

export type JsRunResult = {
  ok: boolean;
  value?: unknown;
  logs: string[];
  error?: string;
  durationMs: number;
};

const BANNED_JS_PATTERNS = [
  /__proto__/u,
  /\bconstructor\b/u,
  /\bprototype\b/u,
  /\bprocess\b/u,
  /\bBun\b/u,
  /\brequire\s*\(/u,
  /\bimport\s*\(/u,
  /\beval\s*\(/u,
  /\bnew\s+Function\b/u,
];

export async function runSandboxedJs(
  code: string,
  opts: JsRunOptions = {},
): Promise<JsRunResult> {
  const started = performance.now();
  const maxBytes = opts.maxSourceBytes ?? 64_000;
  if (Buffer.byteLength(code, "utf8") > maxBytes) {
    return {
      ok: false,
      logs: [],
      error: `source exceeds ${maxBytes} bytes`,
      durationMs: performance.now() - started,
    };
  }
  for (const pat of BANNED_JS_PATTERNS) {
    if (pat.test(code)) {
      return {
        ok: false,
        logs: [],
        error: `disallowed identifier or construct: ${pat.source}`,
        durationMs: performance.now() - started,
      };
    }
  }

  const hostNames = Object.keys(opts.hostFunctions ?? {});
  const guestGlobals = JSON.stringify(opts.globals ?? {});
  const guestSource = `
    const __logs = [];
    const __pending = new Map();
    let __reqId = 0;
    const __callHost = (name, args) => new Promise((res, rej) => {
      const id = ++__reqId;
      __pending.set(id, { res, rej });
      self.postMessage({ type: "host", id, name, args });
    });
    const __console = {
      log: (...a) => __logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
      warn: (...a) => __logs.push("[warn] " + a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
      error: (...a) => __logs.push("[error] " + a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
    };
    const __hostApi = Object.fromEntries(${JSON.stringify(hostNames)}.map((n) => [n, (...a) => __callHost(n, a)]));
    const __globals = ${guestGlobals};
    self.onmessage = async (ev) => {
      const msg = ev.data;
      if (msg && msg.type === "host-res") {
        const p = __pending.get(msg.id);
        if (!p) return;
        __pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error));
        else p.res(msg.value);
        return;
      }
      if (!msg || msg.type !== "exec") return;
      try {
        const AsyncFunction = (async function () {}).constructor;
        const keys = ["console", "host", "Bun", "process", "fetch", "WebSocket", "eval", "Function", ...Object.keys(__globals)];
        const vals = [__console, __hostApi, undefined, undefined, undefined, undefined, undefined, undefined, ...Object.values(__globals)];
        const fn = new AsyncFunction(...keys, msg.code);
        const value = await fn(...vals);
        self.postMessage({ type: "done", ok: true, value, logs: __logs });
      } catch (e) {
        self.postMessage({ type: "done", ok: false, error: e instanceof Error ? e.message : String(e), logs: __logs });
      }
    };
  `;

  const blobUrl = URL.createObjectURL(
    new Blob([guestSource], { type: "application/javascript" }),
  );
  const worker = new Worker(blobUrl);
  const timeoutMs = opts.timeoutMs ?? 5000;

  return new Promise<JsRunResult>((resolveResult) => {
    let settled = false;
    const finish = (res: Omit<JsRunResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      resolveResult({ ...res, durationMs: performance.now() - started });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, logs: [], error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    worker.onmessage = async (ev: MessageEvent) => {
      const msg = ev.data as
        | {
            type: "done";
            ok: boolean;
            value?: unknown;
            logs: string[];
            error?: string;
          }
        | { type: "host"; id: number; name: string; args: unknown[] };
      if (!msg) return;
      if (msg.type === "done") {
        finish({
          ok: msg.ok,
          value: msg.value,
          logs: msg.logs,
          error: msg.error,
        });
        return;
      }
      if (msg.type === "host") {
        const fn = opts.hostFunctions?.[msg.name];
        if (!fn) {
          worker.postMessage({
            type: "host-res",
            id: msg.id,
            error: `unknown host function: ${msg.name}`,
          });
          return;
        }
        try {
          const value = await fn(...msg.args);
          worker.postMessage({ type: "host-res", id: msg.id, value });
        } catch (e) {
          worker.postMessage({
            type: "host-res",
            id: msg.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    };

    worker.onerror = (err) => {
      finish({ ok: false, logs: [], error: err.message || "worker error" });
    };

    worker.postMessage({ type: "exec", code });
  });
}
