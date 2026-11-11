interface SovereignProcess {
  readonly platform: string;
  readonly arch: string;
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
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

interface SovereignAsyncProc {
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
      encoding: "hex" | "base64",
    ): string;
  };
  which(bin: string): string | null;
  nanoseconds(): number;
  plugin(spec: unknown): void;
  file(path: string): { text(): Promise<string> };
  serve(options: {
    port?: number;
    hostname?: string;
    idleTimeout?: number;
    fetch(req: Request): Response | Promise<Response>;
  }): SovereignServer;
  spawn(
    cmd: string[],
    options?: {
      stdin?:
        | "pipe"
        | "inherit"
        | "ignore"
        | Uint8Array
        | ReadableStream<Uint8Array>
        | null;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
    },
  ): SovereignAsyncProc;
  spawnSync(
    cmd: string[],
    options?: {
      stdin?: "pipe" | "inherit" | "ignore" | Uint8Array | null;
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
  }
  export interface Stats {
    readonly size: number;
    readonly mtime: Date;
  }
  export function existsSync(path: string): boolean;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): string | undefined;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    encoding?: "utf8",
  ): void;
  export function statSync(path: string): Stats;
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Dirent[];
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
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
    readonly f32: "f32";
    readonly f64: "f64";
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
    readonly symbols: Record<keyof T, (...args: any[]) => any>;
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
    run(...params: unknown[]): void;
  }

  export class Database {
    constructor(
      filename: string,
      options?: { create?: boolean; readonly?: boolean },
    );
    exec(sql: string): void;
    run(sql: string, ...bindings: unknown[]): void;
    query<ResultType = unknown, ParamsType extends unknown[] = unknown[]>(
      sql: string,
    ): Statement<ResultType, ParamsType>;
    prepare<ResultType = unknown, ParamsType extends unknown[] = unknown[]>(
      sql: string,
    ): Statement<ResultType, ParamsType>;
    transaction<Args extends unknown[], Ret>(
      fn: (...args: Args) => Ret,
    ): (...args: Args) => Ret;
    close(throwOnError?: boolean): void;
  }
}

declare module "bun" {
  export interface BunPlugin {
    name: string;
    setup(build: {
      onResolve(
        opts: { filter: RegExp },
        cb: (args: { path: string }) => { path: string; namespace?: string },
      ): void;
      onLoad(
        opts: { filter: RegExp; namespace?: string },
        cb: (args: { path: string }) => { loader: string; contents: string },
      ): void;
    }): void;
  }
  export function plugin(p: BunPlugin): void;
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
    not: {
      toBeNull(): void;
      toBe(expected: unknown): void;
    };
  };
  export namespace expect {
    function arrayContaining(arr: readonly unknown[]): unknown;
  }
}
