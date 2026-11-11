import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, release, totalmem } from "node:os";
import { dirname, posix } from "node:path";
import {
  assertSafeUserspacePath,
  redactSecretsFromText,
} from "../nexus/security.ts";
import { listNixDerivations, listNixGenerations } from "../nix/store.ts";
import {
  getRustWasmKernel,
  getZigWasmKernel,
  inspectWasmAndWebGpuCapabilities,
} from "../wasm-webgpu/index.ts";

export interface PosixCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
  durationUs: number;
  engine: "aios-posix-vfs-wasm";
}

export const POSIX_BUILTINS = [
  "uname",
  "pwd",
  "cd",
  "ls",
  "cat",
  "echo",
  "mkdir",
  "touch",
  "rm",
  "cp",
  "mv",
  "stat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "sed",
  "sort",
  "uniq",
  "jq",
  "sha256sum",
  "fnv64",
  "env",
  "export",
  "which",
  "ps",
  "df",
  "nix-store",
  "wasm-info",
  "true",
  "false",
] as const;

export class AiPosixOs {
  private cwd = "/home/agent";
  private envVars: Map<string, string>;
  private vfsFiles = new Map<string, string>();
  private vfsDirs = new Set<string>([
    "/",
    "/bin",
    "/usr/bin",
    "/etc",
    "/proc",
    "/dev",
    "/tmp",
    "/home",
    "/home/agent",
    "/nix",
    "/nix/store",
    "/mnt",
    "/mnt/src",
  ]);
  private hostSrcRoot: string | null;

  constructor(options?: {
    enableHostMount?: boolean;
    hostSrcRoot?: string;
    initialEnv?: Record<string, string>;
  }) {
    this.hostSrcRoot =
      options?.enableHostMount !== false
        ? (options?.hostSrcRoot ?? (existsSync("C:/src") ? "C:/src" : null))
        : null;

    this.envVars = new Map(
      Object.entries({
        PATH: "/nix/store/bin:/usr/bin:/bin",
        HOME: "/home/agent",
        USER: "agent",
        SHELL: "/bin/brush-justbash",
        OS: "AI-OS-POSIX-Nix",
        LANG: "C.UTF-8",
        ...(options?.initialEnv ?? {}),
      }),
    );

    this.vfsFiles.set(
      "/etc/os-release",
      [
        'NAME="Sovereign AI-OS"',
        'PRETTY_NAME="Sovereign AI-OS 2.1 (POSIX/Unix + NixOS + WASM32 + WebGPU)"',
        "ID=aios",
        "ID_LIKE=nixos",
        'VERSION_ID="2.1.0"',
        'STACK="Rust + TypeScript/Bun + Zig + CUDA sm_89 + Python/uv"',
      ].join("\n") + "\n",
    );
    this.vfsFiles.set("/etc/shells", "/bin/sh\n/bin/brush\n/bin/just-bash\n");
  }

  public normalizePath(p: string): string {
    if (!p || p === "~") return this.envVars.get("HOME") ?? "/home/agent";
    if (p.startsWith("~/")) {
      return posix.normalize(
        posix.join(this.envVars.get("HOME") ?? "/home/agent", p.slice(2)),
      );
    }
    if (p.startsWith("/")) return posix.normalize(p);
    return posix.normalize(posix.join(this.cwd, p));
  }

  private resolveHostMount(vPath: string): string | null {
    if (!this.hostSrcRoot) return null;
    if (vPath === "/mnt/src") return this.hostSrcRoot;
    if (vPath.startsWith("/mnt/src/")) {
      const rel = vPath.slice("/mnt/src/".length);
      return `${this.hostSrcRoot}/${rel}`;
    }
    return null;
  }

  public readFile(pathArg: string): string | null {
    const vPath = this.normalizePath(pathArg);
    if (vPath === "/dev/null") return "";
    if (vPath === "/proc/cpuinfo") {
      const c = cpus();
      return `model name\t: ${c[0]?.model ?? "wasm32-virtual-cpu"}\ncpu cores\t: ${c.length}\nflags\t\t: avx2 fma3 bmi2 wasm_simd128 webgpu\n`;
    }
    if (vPath === "/proc/meminfo") {
      return `MemTotal:       ${Math.round(totalmem() / 1024)} kB\nMemFree:        ${Math.round(freemem() / 1024)} kB\n`;
    }
    if (vPath === "/proc/mounts") {
      return (
        [
          "rootfs / rootfs rw 0 0",
          "tmpfs /tmp tmpfs rw,nosuid 0 0",
          "nixstore /nix/store nixfs ro 0 0",
          this.hostSrcRoot
            ? `${this.hostSrcRoot.replace(/\\/g, "/")} /mnt/src hostfs rw,nosystem32 0 0`
            : "",
        ]
          .filter(Boolean)
          .join("\n") + "\n"
      );
    }
    if (this.vfsFiles.has(vPath)) {
      return this.vfsFiles.get(vPath)!;
    }
    if (vPath.startsWith("/nix/store/")) {
      const drvs = listNixDerivations();
      const hit = drvs.find(
        (d) =>
          vPath === d.virtualStorePath ||
          vPath.startsWith(`${d.virtualStorePath}/`),
      );
      if (hit) {
        const sub = vPath.slice(hit.virtualStorePath.length);
        const hostTarget = sub
          ? `${hit.hostStorePath}${sub}`
          : `${hit.hostStorePath}/derivation.json`;
        if (existsSync(hostTarget)) {
          return redactSecretsFromText(readFileSync(hostTarget, "utf8"));
        }
      }
    }
    const hostPath = this.resolveHostMount(vPath);
    if (hostPath && existsSync(hostPath)) {
      const st = statSync(hostPath);
      if (st.isFile()) {
        return redactSecretsFromText(readFileSync(hostPath, "utf8"));
      }
    }
    return null;
  }

  public writeFile(pathArg: string, content: string, append = false): void {
    const vPath = this.normalizePath(pathArg);
    if (vPath === "/dev/null") return;
    if (
      vPath.startsWith("/proc/") ||
      vPath.startsWith("/bin/") ||
      vPath.startsWith("/nix/store/")
    ) {
      throw new Error(`Read-only filesystem: ${vPath}`);
    }
    const hostPath = this.resolveHostMount(vPath);
    if (hostPath) {
      const safe = assertSafeUserspacePath(hostPath);
      mkdirSync(dirname(safe), { recursive: true });
      const prev = append && existsSync(safe) ? readFileSync(safe, "utf8") : "";
      writeFileSync(safe, prev + content, "utf8");
      return;
    }
    const parent = posix.dirname(vPath);
    this.mkdirp(parent);
    const prev = append ? (this.vfsFiles.get(vPath) ?? "") : "";
    this.vfsFiles.set(vPath, prev + content);
  }

  private mkdirp(vPath: string): void {
    const norm = this.normalizePath(vPath);
    const parts = norm.split("/").filter(Boolean);
    let cur = "";
    this.vfsDirs.add("/");
    for (const p of parts) {
      cur += `/${p}`;
      this.vfsDirs.add(cur);
    }
  }

  public listDir(pathArg: string): string[] {
    const vPath = this.normalizePath(pathArg);
    if (vPath === "/bin" || vPath === "/usr/bin") {
      return [...POSIX_BUILTINS].sort();
    }
    if (vPath === "/proc") {
      return ["cpuinfo", "meminfo", "mounts"];
    }
    if (vPath === "/nix/store") {
      return listNixDerivations().map((d) =>
        posix.basename(d.virtualStorePath),
      );
    }
    const hostPath = this.resolveHostMount(vPath);
    if (hostPath && existsSync(hostPath)) {
      try {
        return readdirSync(hostPath).sort();
      } catch {
        return [];
      }
    }

    const prefix = vPath === "/" ? "/" : `${vPath}/`;
    const entries = new Set<string>();
    for (const d of this.vfsDirs) {
      if (d !== vPath && d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        const first = rest.split("/")[0];
        if (first) entries.add(`${first}/`);
      }
    }
    for (const f of this.vfsFiles.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        if (!rest.includes("/")) entries.add(rest);
      }
    }
    return Array.from(entries).sort();
  }

  private tokenize(segment: string): string[] {
    const tokens: string[] = [];
    let cur = "";
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < segment.length; i++) {
      const ch = segment[i]!;
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          cur += ch;
        }
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (/\s/.test(ch)) {
        if (cur.length > 0) {
          tokens.push(cur);
          cur = "";
        }
      } else {
        cur += ch;
      }
    }
    if (cur.length > 0) tokens.push(cur);
    return tokens.map((tok) =>
      tok.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) =>
        name === "PWD" ? this.cwd : (this.envVars.get(name) ?? ""),
      ),
    );
  }

  public exec(commandLine: string): PosixCommandResult {
    const t0 = performance.now();
    const chains = commandLine
      .split(/&&|;/)
      .map((s) => s.trim())
      .filter(Boolean);

    let lastStdout = "";
    let lastStderr = "";
    let lastCode = 0;

    for (const chain of chains) {
      const res = this.execPipeline(chain);
      lastStdout = lastStdout
        ? `${lastStdout}\n${res.stdout}`.trim()
        : res.stdout;
      lastStderr = lastStderr
        ? `${lastStderr}\n${res.stderr}`.trim()
        : res.stderr;
      lastCode = res.exitCode;
      if (lastCode !== 0 && commandLine.includes("&&")) break;
    }

    return {
      exitCode: lastCode,
      stdout: lastStdout,
      stderr: lastStderr,
      cwd: this.cwd,
      durationUs: Math.round((performance.now() - t0) * 1000),
      engine: "aios-posix-vfs-wasm",
    };
  }

  private execPipeline(pipelineStr: string): {
    exitCode: number;
    stdout: string;
    stderr: string;
  } {
    let redirectFile: string | null = null;
    let redirectAppend = false;

    let cleanPipe = pipelineStr;
    const appendMatch = cleanPipe.match(/>>\s*([^\s|]+)\s*$/);
    if (appendMatch?.[1]) {
      redirectFile = appendMatch[1];
      redirectAppend = true;
      cleanPipe = cleanPipe.slice(0, appendMatch.index).trim();
    } else {
      const writeMatch = cleanPipe.match(/>\s*([^\s|]+)\s*$/);
      if (writeMatch?.[1]) {
        redirectFile = writeMatch[1];
        redirectAppend = false;
        cleanPipe = cleanPipe.slice(0, writeMatch.index).trim();
      }
    }

    const stages = cleanPipe.split("|").map((s) => s.trim());
    let stdin = "";
    let exitCode = 0;
    let stderr = "";

    for (const stage of stages) {
      const argv = this.tokenize(stage);
      if (argv.length === 0) continue;
      const step = this.runSingleCommand(argv[0]!, argv.slice(1), stdin);
      stdin = step.stdout;
      exitCode = step.exitCode;
      if (step.stderr) {
        stderr = stderr ? `${stderr}\n${step.stderr}` : step.stderr;
      }
    }

    if (redirectFile) {
      try {
        this.writeFile(redirectFile, `${stdin}\n`, redirectAppend);
        return { exitCode, stdout: "", stderr };
      } catch (err) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { exitCode, stdout: stdin, stderr };
  }

  private runSingleCommand(
    cmd: string,
    args: string[],
    stdin: string,
  ): { exitCode: number; stdout: string; stderr: string } {
    const rustWasm = getRustWasmKernel();

    switch (cmd) {
      case "true":
        return { exitCode: 0, stdout: "", stderr: "" };
      case "false":
        return { exitCode: 1, stdout: "", stderr: "" };
      case "pwd":
        return { exitCode: 0, stdout: this.cwd, stderr: "" };
      case "cd": {
        const target = this.normalizePath(args[0] ?? "~");
        this.cwd = target;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      case "uname": {
        if (args.includes("-a")) {
          return {
            exitCode: 0,
            stdout: `AI-OS-POSIX 2.1.0-nixos ${release()} wasm32+x86_64 Rust/Bun/Zig/WebGPU`,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "AI-OS-POSIX", stderr: "" };
      }
      case "echo":
        return { exitCode: 0, stdout: args.join(" "), stderr: "" };
      case "env":
        return {
          exitCode: 0,
          stdout: Array.from(this.envVars.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join("\n"),
          stderr: "",
        };
      case "export": {
        for (const a of args) {
          const eq = a.indexOf("=");
          if (eq > 0) {
            this.envVars.set(a.slice(0, eq), a.slice(eq + 1));
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      case "which": {
        const target = args[0] ?? "";
        if ((POSIX_BUILTINS as readonly string[]).includes(target)) {
          return { exitCode: 0, stdout: `/bin/${target}`, stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `${target}: not found` };
      }
      case "mkdir": {
        const dirs = args.filter((a) => !a.startsWith("-"));
        for (const d of dirs) this.mkdirp(d);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      case "touch": {
        for (const f of args.filter((a) => !a.startsWith("-"))) {
          if (this.readFile(f) === null) this.writeFile(f, "");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      case "rm": {
        for (const f of args.filter((a) => !a.startsWith("-"))) {
          const vp = this.normalizePath(f);
          this.vfsFiles.delete(vp);
          this.vfsDirs.delete(vp);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      case "cp": {
        const clean = args.filter((a) => !a.startsWith("-"));
        if (clean.length < 2) {
          return { exitCode: 1, stdout: "", stderr: "cp: missing operand" };
        }
        const body = this.readFile(clean[0]!);
        if (body === null) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `cp: cannot stat '${clean[0]}'`,
          };
        }
        this.writeFile(clean[1]!, body);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      case "mv": {
        const clean = args.filter((a) => !a.startsWith("-"));
        if (clean.length < 2) {
          return { exitCode: 1, stdout: "", stderr: "mv: missing operand" };
        }
        const body = this.readFile(clean[0]!);
        if (body === null) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `mv: cannot stat '${clean[0]}'`,
          };
        }
        this.writeFile(clean[1]!, body);
        this.vfsFiles.delete(this.normalizePath(clean[0]!));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      case "ls": {
        const paths = args.filter((a) => !a.startsWith("-"));
        const target = paths[0] ?? this.cwd;
        return {
          exitCode: 0,
          stdout: this.listDir(target).join("\n"),
          stderr: "",
        };
      }
      case "cat": {
        const files = args.filter((a) => !a.startsWith("-"));
        if (files.length === 0) {
          return { exitCode: 0, stdout: stdin, stderr: "" };
        }
        const out: string[] = [];
        for (const f of files) {
          const content = this.readFile(f);
          if (content === null) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: `cat: ${f}: No such file`,
            };
          }
          out.push(content.replace(/\n$/, ""));
        }
        return { exitCode: 0, stdout: out.join("\n"), stderr: "" };
      }
      case "stat": {
        const target = args[0] ?? this.cwd;
        const body = this.readFile(target);
        if (body !== null) {
          return {
            exitCode: 0,
            stdout: `File: ${this.normalizePath(target)}\nSize: ${body.length}\tType: regular file`,
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: `File: ${this.normalizePath(target)}\nType: directory`,
          stderr: "",
        };
      }
      case "head":
      case "tail": {
        let count = 10;
        const nIdx = args.indexOf("-n");
        if (nIdx >= 0 && args[nIdx + 1]) count = Number(args[nIdx + 1]);
        const fileArg = args.find(
          (a, i) => !a.startsWith("-") && (nIdx < 0 || i !== nIdx + 1),
        );
        const text = fileArg ? (this.readFile(fileArg) ?? "") : stdin;
        const lines = text.split(/\r?\n/);
        const sliced =
          cmd === "head" ? lines.slice(0, count) : lines.slice(-count);
        return { exitCode: 0, stdout: sliced.join("\n"), stderr: "" };
      }
      case "wc": {
        const fileArg = args.find((a) => !a.startsWith("-"));
        const text = fileArg ? (this.readFile(fileArg) ?? "") : stdin;
        const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        if (args.includes("-l")) {
          return { exitCode: 0, stdout: String(lines), stderr: "" };
        }
        if (args.includes("-c")) {
          return { exitCode: 0, stdout: String(text.length), stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: `${lines} ${words} ${text.length}`,
          stderr: "",
        };
      }
      case "grep":
      case "rg": {
        const ignoreCase = args.includes("-i");
        const nonFlags = args.filter((a) => !a.startsWith("-"));
        const pattern = nonFlags[0] ?? "";
        const fileArg = nonFlags[1];
        const source = fileArg ? (this.readFile(fileArg) ?? "") : stdin;
        const re = new RegExp(pattern, ignoreCase ? "i" : "");
        const matched = source.split(/\r?\n/).filter((l) => re.test(l));
        return {
          exitCode: matched.length > 0 ? 0 : 1,
          stdout: matched.join("\n"),
          stderr: "",
        };
      }
      case "find": {
        const base = this.normalizePath(args[0] ?? this.cwd);
        const nameIdx = args.indexOf("-name");
        const globPat = nameIdx >= 0 ? (args[nameIdx + 1] ?? "*") : "*";
        const hits: string[] = [];
        for (const f of this.vfsFiles.keys()) {
          if (f.startsWith(base)) {
            const baseName = posix.basename(f);
            if (rustWasm.globMatch(globPat, baseName)) {
              hits.push(f);
            }
          }
        }
        const hostBase = this.resolveHostMount(base);
        if (hostBase && existsSync(hostBase)) {
          for (const item of this.listDir(base)) {
            if (rustWasm.globMatch(globPat, item.replace(/\/$/, ""))) {
              hits.push(posix.join(base, item));
            }
          }
        }
        return { exitCode: 0, stdout: hits.sort().join("\n"), stderr: "" };
      }
      case "sed": {
        const expr = args[0] ?? "";
        const fileArg = args[1];
        const input = fileArg ? (this.readFile(fileArg) ?? "") : stdin;
        const m = /^s\/([^/]*)\/([^/]*)\/(g?)$/.exec(expr);
        if (!m) return { exitCode: 0, stdout: input, stderr: "" };
        const re = new RegExp(m[1]!, m[3] || "");
        return {
          exitCode: 0,
          stdout: input
            .split(/\r?\n/)
            .map((l) => l.replace(re, m[2]!))
            .join("\n"),
          stderr: "",
        };
      }
      case "sort": {
        const lines = stdin.split(/\r?\n/).filter(Boolean).sort();
        if (args.includes("-r")) lines.reverse();
        return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
      }
      case "uniq": {
        const lines = stdin.split(/\r?\n/);
        const dedup: string[] = [];
        for (const l of lines) {
          if (dedup[dedup.length - 1] !== l) dedup.push(l);
        }
        return { exitCode: 0, stdout: dedup.join("\n"), stderr: "" };
      }
      case "jq": {
        const filter = args[0] ?? ".";
        const fileArg = args[1];
        const raw = fileArg ? (this.readFile(fileArg) ?? "{}") : stdin;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (filter === "." || filter === "") {
            return {
              exitCode: 0,
              stdout: JSON.stringify(parsed, null, 2),
              stderr: "",
            };
          }
          const keys = filter.replace(/^\./, "").split(".").filter(Boolean);
          let cur: unknown = parsed;
          for (const k of keys) {
            if (cur && typeof cur === "object") {
              cur = (cur as Record<string, unknown>)[k];
            }
          }
          return {
            exitCode: 0,
            stdout:
              typeof cur === "string" ? cur : JSON.stringify(cur, null, 2),
            stderr: "",
          };
        } catch (err) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `jq parse error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      case "sha256sum": {
        const fileArg = args[0];
        const data = fileArg ? (this.readFile(fileArg) ?? "") : stdin;
        const hex = Bun.CryptoHasher.hash("sha256", data, "hex");
        return {
          exitCode: 0,
          stdout: `${hex}  ${fileArg ?? "-"}`,
          stderr: "",
        };
      }
      case "fnv64": {
        const fileArg = args[0];
        const data = fileArg ? (this.readFile(fileArg) ?? "") : stdin;
        const rustHex = rustWasm.fnv1a64Hex(data);
        const zigHex = getZigWasmKernel().fnv1a64Hex(data);
        return {
          exitCode: 0,
          stdout: `rust_wasm=${rustHex} zig_wasm=${zigHex}`,
          stderr: "",
        };
      }
      case "nix-store": {
        if (args.includes("--generations")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify(listNixGenerations(), null, 2),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: listNixDerivations()
            .map((d) => d.virtualStorePath)
            .join("\n"),
          stderr: "",
        };
      }
      case "wasm-info":
        return {
          exitCode: 0,
          stdout: JSON.stringify(inspectWasmAndWebGpuCapabilities(), null, 2),
          stderr: "",
        };
      case "ps":
        return {
          exitCode: 0,
          stdout:
            "PID   TTY      CMD\n1     pts/0    /bin/ai-os-init\n2     pts/0    /bin/brush-justbash\n3     pts/0    aios_wasm_kernel.wasm",
          stderr: "",
        };
      case "df":
        return {
          exitCode: 0,
          stdout:
            "Filesystem     Type     Mounted on\nrootfs         vfs      /\nnixfs          nixstore /nix/store\nhostfs         usersp   /mnt/src",
          stderr: "",
        };
      default:
        return {
          exitCode: 127,
          stdout: "",
          stderr: `${cmd}: command not found in AiPosixOs`,
        };
    }
  }
}

let sharedPosixOs: AiPosixOs | null = null;

export function getSharedPosixOs(): AiPosixOs {
  if (!sharedPosixOs) {
    sharedPosixOs = new AiPosixOs();
  }
  return sharedPosixOs;
}
