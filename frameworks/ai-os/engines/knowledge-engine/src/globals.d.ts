interface SovereignProcess {
  readonly platform: string;
  readonly arch: string;
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
  readonly stdin: {
    on?(event: string, listener: (...args: unknown[]) => void): void;
  };
  readonly stdout: { write(chunk: string | Uint8Array): boolean };
  readonly stderr: { write(chunk: string | Uint8Array): boolean };
  exitCode?: number;
  cwd(): string;
  exit(code?: number): never;
}

declare const process: SovereignProcess;

interface SovereignServer {
  readonly hostname: string;
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}

interface SovereignSpawnResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

interface SovereignFileSink {
  write(chunk: string | Uint8Array): number;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
}

interface SovereignAsyncProc {
  readonly stdin: SovereignFileSink;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | string): void;
}

declare const Bun: {
  readonly version: string;
  readonly stdin: { stream(): AsyncIterable<Uint8Array> };
  readonly YAML: { parse(input: string): unknown };
  readonly TOML: { parse(input: string): unknown };
  readonly CryptoHasher: {
    hash(
      algo: string,
      data: string | Uint8Array,
      encoding: "hex" | "base64" | "base64url",
    ): string;
  };
  nanoseconds(): number;
  sleep(ms: number): Promise<void>;
  which(bin: string): string | null;
  file(path: string): {
    text(): Promise<string>;
    exists(): Promise<boolean>;
    size: number;
    slice(begin?: number, end?: number): Blob;
  };
  serve(options: {
    port?: number;
    hostname?: string;
    idleTimeout?: number;
    fetch(req: Request): Response | Promise<Response>;
  }): SovereignServer;
  spawn(
    cmd: string[],
    options?: {
      stdin?: "pipe" | "inherit" | "ignore" | Uint8Array;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): SovereignAsyncProc;
  spawnSync(
    cmd: string[],
    options?: {
      stdin?: "pipe" | "inherit" | "ignore" | Uint8Array;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
    },
  ): SovereignSpawnResult;
};

interface ImportMeta {
  readonly dir: string;
  readonly url: string;
  readonly main: boolean;
}

declare module "node:fs" {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export interface Stats {
    readonly size: number;
    readonly mtime: Date;
    readonly mtimeMs: number;
    readonly mode: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    options?: "utf8" | { encoding?: "utf8"; mode?: number },
  ): void;
  export function appendFileSync(
    path: string,
    data: string | Uint8Array,
    options?: "utf8" | { encoding?: "utf8" },
  ): void;
  export function copyFileSync(src: string, dest: string): void;
  export function statSync(path: string): Stats;
  export function readdirSync(path: string): string[];
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Dirent[];
  export function openSync(path: string, flags: string): number;
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  export function closeSync(fd: number): void;
  export function chmodSync(path: string, mode: number): void;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export function normalize(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function parse(path: string): {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
  };
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:readline" {
  export interface Interface extends AsyncIterable<string> {
    close(): void;
  }
  export function createInterface(options: {
    input: unknown;
    crlfDelay?: number;
  }): Interface;
}

declare module "bun:ffi" {
  export type Pointer = number & { readonly __pointerBrand?: unique symbol };

  export const FFIType: {
    readonly void: "void";
    readonly bool: "bool";
    readonly u8: "u8";
    readonly i32: "i32";
    readonly u32: "u32";
    readonly u64: "u64";
    readonly ptr: "ptr";
  };

  export class CString extends String {
    constructor(ptr: Pointer, byteOffset?: number, byteLength?: number);
    override toString(): string;
  }

  export function ptr(typedArray: ArrayBufferView): Pointer;

  export function dlopen<
    T extends Record<string, { args: readonly string[]; returns: string }>,
  >(
    path: string,
    symbols: T,
  ): {
    readonly symbols: {
      [K in keyof T]: (...args: any[]) => any;
    };
    close(): void;
  };
}

declare module "bun:sqlite" {
  export class Statement<
    ResultType = unknown,
    ParamsType extends unknown[] = unknown[],
  > {
    get(...params: ParamsType): ResultType | null;
    all(...params: ParamsType): ResultType[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  }

  export class Database {
    constructor(
      filename: string,
      options?: { create?: boolean; readonly?: boolean },
    );
    run(
      sql: string,
      ...bindings: unknown[]
    ): { changes: number; lastInsertRowid: number };
    prepare<ResultType = unknown, ParamsType extends unknown[] = unknown[]>(
      sql: string,
    ): Statement<ResultType, ParamsType>;
    transaction<Args extends unknown[], Ret>(
      fn: (...args: Args) => Ret,
    ): (...args: Args) => Ret;
    close(throwOnError?: boolean): void;
  }
}

declare module "bun:test" {
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: string): void;
    toMatch(expected: RegExp | string): void;
    toStartWith(expected: string): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeDefined(): void;
    not: {
      toBeNull(): void;
      toBe(expected: unknown): void;
      toContain(expected: string): void;
      toMatch(expected: RegExp | string): void;
    };
  };
  export namespace expect {
    function arrayContaining(arr: readonly unknown[]): unknown;
  }
}
