// JVM reflection client: line-delimited JSON-RPC to bridge/Bridge.java over the child's stdio.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";

export class JavaError extends Error {
  constructor(public type: string, message: string, public trace: string) {
    super(`${type}: ${message}`);
    this.name = "JavaError";
  }
}

/** brand of class proxies (a user object with a `$class` key must never be mistaken for one) */
const JCLASS = Symbol.for("aphrody.ghidra.jclass");
const RESERVED = new Set(["then", "toJSON", "constructor", "valueOf", "inspect"]);

export interface JObject {
  readonly $h: number;
  readonly $c: string;
  /** java.lang.Object.toString() */
  $str(): Promise<string>;
  /** Iterable / array / Iterator / Map / Stream to JS array of decoded values */
  $list(): Promise<any[]>;
  $field(name: string): Promise<any>;
  $setField(name: string, v: unknown): Promise<void>;
  $instanceOf(cls: string): Promise<boolean>;
  $release(): Promise<void>;
  /** java.lang.Object.toString() (async, unlike JS `toString`) */
  toString(): any;
  [method: string]: any;
}

export interface JClass {
  readonly $class: string;
  new_(...args: unknown[]): Promise<any>;
  $field(name: string): Promise<any>;
  $setField(name: string, v: unknown): Promise<void>;
  [method: string]: any;
}

export interface StartOptions {
  installDir?: string;
  javaBin?: string;
  maxMemory?: string;
  /** extra JVM arguments */
  jvmArgs?: string[];
  /** directory with compiled Bridge.class (default: cache, compiled on demand with javac) */
  bridgeClasses?: string;
  verbose?: boolean;
  /** extra classpath entries appended to `-cp` */
  classpath?: string[];
}

export class Session {
  #proc: Subprocess<"pipe", "pipe", any> | undefined;
  #errTail = "";
  #next = 1;
  #pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  #buf = "";
  #release: number[] = [];
  /** live proxies per Java handle id (the bridge returns the same id for the same object) */
  #refs = new Map<number, number>();
  #registry = new FinalizationRegistry<number>((h) => {
    const n = (this.#refs.get(h) ?? 1) - 1;
    if (n > 0) { this.#refs.set(h, n); return; }
    this.#refs.delete(h);
    this.#release.push(h);
    if (this.#release.length === 1) queueMicrotask(() => this.#flushRelease());
  });
  closed = false;

  static async start(opts: StartOptions = {}): Promise<Session> {
    const install = opts.installDir ?? process.env.GHIDRA_INSTALL_DIR ?? findInstall();
    if (!install) throw new Error("Ghidra install dir not found: set GHIDRA_INSTALL_DIR");
    const java = opts.javaBin ?? (process.env.GHIDRA_JAVA ?? "java");
    
    const sep = process.platform === "win32" ? ";" : ":";
    const utility = join(install, "Ghidra", "Framework", "Utility", "lib", "Utility.jar");
    const ls = join(install, "support", "LaunchSupport.jar");
    const classes = opts.bridgeClasses ?? (await compileBridge(java, utility));
    let vmargs: string[] = [];
    const r = Bun.spawnSync([java, "-cp", ls, "LaunchSupport", install, "-vmargs"]);
    if (r.exitCode === 0) vmargs = r.stdout.toString().split(/\r?\n/).filter(Boolean);
    if (!vmargs.length) vmargs = ["-Djava.system.class.loader=ghidra.GhidraClassLoader", "-Dfile.encoding=UTF8", "-Xshare:off"];
    const args = [
      java, ...vmargs, `-Xmx${opts.maxMemory ?? "2g"}`, "-Djava.awt.headless=true",
      `-Dghidra.install.dir=${install}`, ...(opts.jvmArgs ?? []),
      "-cp", [utility, classes, ...(opts.classpath ?? [])].join(sep), "ghidra.Ghidra", "GhidraBridge",
    ];
    const s = new Session();
    s.#proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: opts.verbose ? "inherit" : "pipe" });
    if (!opts.verbose) void s.#drainStderr();
    s.#pump();
    await s.ping();
    return s;
  }

  /** Connect to an already running bridge through custom pipes (tests, remote sockets). */
  static fromProcess(cmd: string[]): Session {
    const s = new Session();
    s.#proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    s.#pump();
    return s;
  }

  /** keep the last 4 KB of the JVM stderr so a dead bridge reports why */
  async #drainStderr() {
    const dec = new TextDecoder();
    try {
      for await (const chunk of this.#proc!.stderr as ReadableStream<Uint8Array>) this.#errTail = (this.#errTail + dec.decode(chunk, { stream: true })).slice(-4096);
    } catch { /* process gone */ }
  }

  async #pump() {
    const dec = new TextDecoder();
    const reader = this.#proc!.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.#buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        if (line) this.#onLine(line);
      }
    }
    this.#buf += dec.decode();
    if (this.#buf.trim()) this.#onLine(this.#buf.trim()); // final fragment without a newline
    this.#buf = "";
    this.#failAll(new Error("bridge exited" + (this.#errTail ? `: ${this.#errTail.trim()}` : "")));
  }

  #failAll(e: Error) {
    this.closed = true;
    for (const [, p] of this.#pending) p.rej(e);
    this.#pending.clear();
  }

  #onLine(line: string) {
    let m: any;
    try { m = JSON.parse(line); } catch {
      // protocol corruption: nothing pending can be matched reliably any more
      process.stderr.write(`ghidra bridge: unparseable line: ${line.slice(0, 200)}\n`);
      this.#failAll(new Error("bridge protocol error: unparseable response"));
      return;
    }
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    if (m.error) p.rej(new JavaError(m.error.type, m.error.message, m.error.trace));
    else p.res(this.decode(m.result));
  }

  #send(req: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new Error("bridge closed"));
    const id = this.#next++;
    const line = JSON.stringify({ id, ...req }) + "\n";
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej });
      try {
        this.#proc!.stdin.write(line);
        this.#proc!.stdin.flush();
      } catch (e) {
        this.#pending.delete(id);
        rej(e as Error);
      }
    });
  }

  #flushRelease() {
    const hs = this.#release.splice(0);
    if (hs.length && !this.closed) void this.#send({ op: "release", hs }).catch(() => {});
  }

  ping() { return this.#send({ op: "ping" }); }

  encode(v: any): any {
    if (v === null || v === undefined) return null;
    if (typeof v === "bigint") return { $long: v.toString() };
    if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString("base64") };
    if (Array.isArray(v)) return v.map((x) => this.encode(x));
    if (typeof v === "object") {
      if (typeof v.$h === "number") return { $h: v.$h };
      if (v[JCLASS] === true && typeof v.$class === "string") return { $class: v.$class };
      if (v.$arr) return { $arr: v.$arr, v: (v.v as unknown[]).map((x) => this.encode(x)) };
      if (Object.getPrototypeOf(v) === Object.prototype && !Object.keys(v).some((k) => k.startsWith("$")))
        throw new TypeError("cannot pass a plain object to Java: use Session.array(), a Java Map handle, or a primitive");
    }
    return v;
  }

  decode(v: any): any {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      const a = v.map((x) => this.decode(x));
      Object.defineProperty(a, "$list", { value: async () => a });
      return a;
    }
    if ("$h" in v) return this.#wrap(v.$h, v.c);
    if ("$long" in v) return BigInt(v.$long);
    if ("$double" in v) return Number(v.$double);
    if ("$bytes" in v) return new Uint8Array(Buffer.from(v.$bytes, "base64"));
    return v;
  }

  #wrap(h: number, c: string): JObject {
    const self = this;
    let released = false;
    let proxy: object;
    const meta: Record<string, unknown> = {
      $h: h,
      $c: c,
      $str: () => self.#send({ op: "str", h }),
      $list: () => self.#send({ op: "list", h }),
      $field: (f: string) => self.#send({ op: "field", h, f }),
      $setField: (f: string, v: unknown) => self.#send({ op: "setfield", h, f, a: [self.encode(v)] }),
      $instanceOf: (cls: string) => self.#send({ op: "instanceof", h, c: cls }),
      /** drops this proxy's reference; the Java handle is released only when no other proxy shares it */
      $release: async () => {
        if (released) return;
        released = true;
        self.#registry.unregister(proxy);
        const n = (self.#refs.get(h) ?? 1) - 1;
        if (n > 0) {
          self.#refs.set(h, n);
          return;
        }
        self.#refs.delete(h);
        await self.#send({ op: "release", hs: [h] });
      },
      /** java.lang.Object.toString() (async); string coercion yields a debug tag */
      toString: () => self.#send({ op: "str", h }),
      [Symbol.toPrimitive]: () => `[java ${c}#${h}]`,
      [Symbol.for("nodejs.util.inspect.custom")]: () => `[java ${c}#${h}]`,
    };
    const p = (proxy = new Proxy(meta, {
      get(t, name) {
        if (typeof name === "symbol" || name in t) return t[name as string];
        if (RESERVED.has(name)) return undefined;
        return (...args: unknown[]) => self.#send({ op: "call", h, m: name, a: args.map((x) => self.encode(x)) });
      },
    }));
    this.#refs.set(h, (this.#refs.get(h) ?? 0) + 1);
    const pend = this.#release.indexOf(h);
    if (pend >= 0) this.#release.splice(pend, 1); // re-referenced before the release was sent
    this.#registry.register(p, h, p);
    return p as unknown as JObject;
  }

  /** Static class access: `const Math = jvm.cls("java.lang.Math"); await Math.max(1, 2)`. */
  cls(name: string): JClass {
    const self = this;
    const meta: Record<string, unknown> = {
      $class: name,
      [JCLASS]: true,
      new_: (...args: unknown[]) => self.#send({ op: "new", c: name, a: args.map((x) => self.encode(x)) }),
      $field: (f: string) => self.#send({ op: "field", c: name, f }),
      $setField: (f: string, v: unknown) => self.#send({ op: "setfield", c: name, f, a: [self.encode(v)] }),
      toString: () => `[java class ${name}]`,
    };
    return new Proxy(meta, {
      get(t, m) {
        if (typeof m === "symbol" || m in t) return t[m as string];
        if (RESERVED.has(m)) return undefined;
        return (...args: unknown[]) => self.#send({ op: "static", c: name, m, a: args.map((x) => self.encode(x)) });
      },
    }) as unknown as JClass;
  }

  /** Several requests in one round trip. */
  async batch(reqs: Array<Record<string, unknown>>): Promise<any[]> {
    const rs: any[] = await this.#send({ op: "batch", reqs: reqs.map((r, i) => ({ id: i, ...r })) });
    return rs.map((r) => { if (r.error) throw new JavaError(r.error.type, r.error.message, r.error.trace); return this.decode(r.result); });
  }

  async newObject(cls: string, ...args: unknown[]): Promise<any> {
    return this.#send({ op: "new", c: cls, a: args.map((x) => this.encode(x)) });
  }

  /** Typed Java array argument (e.g. String[]). */
  static array(elemType: string, v: unknown[]) { return { $arr: elemType, v }; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.#proc!.stdin.end(); } catch { /* ignore */ }
    this.#proc!.kill();
    await this.#proc!.exited;
  }
}

export function findInstall(): string | undefined {
  const cands = [
    "/srv/ghidra-release/ghidra_12.2_PUBLIC", join(homedir(), ".local/share/ghidra"), "C:/ghidra",
  ];
  const lastrun = join(homedir(), ".config/ghidra/lastrun");
  if (existsSync(lastrun)) {
    const m = readFileSync(lastrun, "utf8").match(/^GHIDRA_INSTALL_DIR\s*[=:]\s*(.+)$/m);
    if (m) cands.unshift(m[1]!.trim());
  }
  return cands.find((c) => existsSync(join(c, "support", "LaunchSupport.jar")));
}

async function compileBridge(java: string, utility: string): Promise<string> {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "Bridge.java");
  const gsrc = join(dirname(src), "GhidraBridge.java");
  const stamp = new Bun.CryptoHasher("sha1").update(readFileSync(src)).update(readFileSync(gsrc)).digest("hex").slice(0, 12);
  const out = join(process.env.XDG_CACHE_HOME ?? join(homedir() || tmpdir(), ".cache"), "aphrody-ghidra", `bridge-${stamp}`);
  if (existsSync(join(out, "GhidraBridge.class"))) return out;
  mkdirSync(out, { recursive: true });
  const javac = /java(\.exe)?$/i.test(java) ? java.replace(/java(\.exe)?$/i, (m) => "javac" + m.slice(4)) : "javac";
  const r = Bun.spawnSync([javac, "-nowarn", "-cp", utility, "-d", out, src, gsrc]);
  if (r.exitCode !== 0) throw new Error("javac failed: " + r.stderr.toString());
  return out;
}
