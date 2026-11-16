/**
 * Aphrody Pure Bun v1.4.4 Zero-Dependency Ambient Type Header (`bun-native.d.ts`)
 *
 * Enables `"dependencies": {}, "devDependencies": {}` across first-party packages
 * while passing `bun check` (TypeScript 7 native Rust checker) with `strict: true`
 * and zero `@types/bun` or `@types/node` npm dependencies.
 */

interface NativeProcess {
  readonly platform: "win32" | "linux" | "darwin" | (string & {});
  readonly arch: "x64" | "arm64" | (string & {});
  readonly argv: string[];
  readonly execPath: string;
  readonly pid: number;
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

declare const process: NativeProcess;

interface BufferInstance extends Uint8Array {
  toString(
    encoding?:
      "utf8" | "utf-8" | "hex" | "base64" | "base64url" | "latin1" | "ascii",
  ): string;
  write(
    str: string,
    offset?: number,
    length?: number,
    encoding?: string,
  ): number;
  equals(other: Uint8Array): boolean;
  includes(
    value: string | number | Uint8Array,
    byteOffset?: number,
    encoding?: string,
  ): boolean;
  subarray(begin?: number, end?: number): BufferInstance;
  slice(begin?: number, end?: number): BufferInstance;
}

interface BufferConstructor {
  from(
    data: string,
    encoding?:
      "utf8" | "utf-8" | "hex" | "base64" | "base64url" | "latin1" | "ascii",
  ): BufferInstance;
  from(data: ArrayLike<number> | ArrayBufferLike | Uint8Array): BufferInstance;
  from(
    buffer: ArrayBufferLike,
    byteOffset?: number,
    length?: number,
  ): BufferInstance;
  alloc(
    size: number,
    fill?: string | Uint8Array | number,
    encoding?: string,
  ): BufferInstance;
  allocUnsafe(size: number): BufferInstance;
  concat(list: readonly Uint8Array[], totalLength?: number): BufferInstance;
  byteLength(
    string: string | ArrayBufferView | ArrayBufferLike,
    encoding?: string,
  ): number;
  isBuffer(obj: unknown): obj is BufferInstance;
}

declare type Buffer = BufferInstance;
declare const Buffer: BufferConstructor;

interface ImportMeta {
  readonly dir: string;
  readonly file: string;
  readonly path: string;
  readonly url: string;
  readonly main: boolean;
}

declare namespace Bun {
  const version: string;
  const revision: string;
  const main: string;
  const env: Record<string, string | undefined>;
  const stdin: BunFile;
  const stdout: BunFile;
  const stderr: BunFile;

  interface BunFile extends Blob {
    readonly name?: string;
    readonly size: number;
    readonly type: string;
    readonly lastModified: number;
    text(): Promise<string>;
    json<T = any>(): Promise<T>;
    bytes(): Promise<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
    stream(): ReadableStream<Uint8Array>;
    exists(): Promise<boolean>;
    delete(): Promise<void>;
    writer(options?: { highWaterMark?: number }): FileSink;
    image(options?: { maxPixels?: number; autoOrient?: boolean }): BunImage;
  }

  interface FileSink {
    write(
      chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
    ): number | Promise<number>;
    flush(): number | Promise<number>;
    end(error?: Error): number | Promise<number>;
  }

  interface BunImage {
    readonly width: number;
    readonly height: number;
    metadata(): Promise<{ width: number; height: number; format: string }>;
    resize(
      width: number,
      height?: number,
      options?: {
        fit?: "fill" | "inside";
        withoutEnlargement?: boolean;
        filter?: string;
      },
    ): BunImage;
    rotate(degrees: 90 | 180 | 270 | -90 | -180 | -270 | number): BunImage;
    flip(): BunImage;
    flop(): BunImage;
    modulate(options: { brightness?: number; saturation?: number }): BunImage;
    jpeg(options?: { quality?: number; progressive?: boolean }): BunImage;
    png(options?: {
      compressionLevel?: number;
      palette?: boolean;
      colors?: number;
      dither?: boolean;
    }): BunImage;
    webp(options?: { quality?: number; lossless?: boolean }): BunImage;
    avif(options?: { quality?: number }): BunImage;
    heic(options?: { quality?: number }): BunImage;
    placeholder(): Promise<string>;
    bytes(): Promise<Uint8Array>;
    buffer(): Promise<Buffer>;
    blob(): Promise<Blob>;
    toBase64(): Promise<string>;
    dataurl(): Promise<string>;
    write(dest: string | BunFile | S3File): Promise<number>;
  }

  class Image implements BunImage {
    static backend: "bun" | "system";
    static fromClipboard(): BunImage | null;
    readonly width: number;
    readonly height: number;
    constructor(
      input: string | ArrayBufferView | ArrayBuffer | Blob,
      options?: { maxPixels?: number; autoOrient?: boolean },
    );
    metadata(): Promise<{ width: number; height: number; format: string }>;
    resize(
      width: number,
      height?: number,
      options?: {
        fit?: "fill" | "inside";
        withoutEnlargement?: boolean;
        filter?: string;
      },
    ): BunImage;
    rotate(degrees: number): BunImage;
    flip(): BunImage;
    flop(): BunImage;
    modulate(options: { brightness?: number; saturation?: number }): BunImage;
    jpeg(options?: { quality?: number; progressive?: boolean }): BunImage;
    png(options?: {
      compressionLevel?: number;
      palette?: boolean;
      colors?: number;
      dither?: boolean;
    }): BunImage;
    webp(options?: { quality?: number; lossless?: boolean }): BunImage;
    avif(options?: { quality?: number }): BunImage;
    heic(options?: { quality?: number }): BunImage;
    placeholder(): Promise<string>;
    bytes(): Promise<Uint8Array>;
    buffer(): Promise<Buffer>;
    blob(): Promise<Blob>;
    toBase64(): Promise<string>;
    dataurl(): Promise<string>;
    write(dest: string | BunFile | S3File): Promise<number>;
  }

  interface S3Options {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
    acl?: string;
    virtualHostedStyle?: boolean;
  }

  interface S3File extends Blob {
    readonly name?: string;
    text(): Promise<string>;
    json<T = any>(): Promise<T>;
    bytes(): Promise<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
    stream(): ReadableStream<Uint8Array>;
    exists(): Promise<boolean>;
    stat(): Promise<{
      size: number;
      etag: string;
      lastModified: Date;
      type: string;
    }>;
    write(
      data: string | ArrayBufferView | ArrayBuffer | Blob | Response,
      options?: {
        type?: string;
        acl?: string;
        contentDisposition?: string;
        contentEncoding?: string;
      },
    ): Promise<number>;
    writer(options?: {
      type?: string;
      retry?: number;
      queueSize?: number;
      partSize?: number;
    }): FileSink;
    presign(options?: {
      expiresIn?: number;
      method?: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
      acl?: string;
      type?: string;
      contentDisposition?: string;
    }): string;
    delete(): Promise<void>;
    unlink(): Promise<void>;
    image(options?: { maxPixels?: number; autoOrient?: boolean }): BunImage;
  }

  class S3Client {
    constructor(options?: S3Options);
    file(path: string, options?: S3Options): S3File;
    write(
      path: string,
      data: string | ArrayBufferView | ArrayBuffer | Blob | Response,
      options?: S3Options & { type?: string },
    ): Promise<number>;
    presign(
      path: string,
      options?: S3Options & {
        expiresIn?: number;
        method?: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
        acl?: string;
        type?: string;
        contentDisposition?: string;
      },
    ): string;
    exists(path: string, options?: S3Options): Promise<boolean>;
    stat(
      path: string,
      options?: S3Options,
    ): Promise<{
      size: number;
      etag: string;
      lastModified: Date;
      type: string;
    }>;
    delete(path: string, options?: S3Options): Promise<void>;
    unlink(path: string, options?: S3Options): Promise<void>;
    list(
      input?: { prefix?: string; maxKeys?: number; continuationToken?: string },
      options?: S3Options,
    ): Promise<any>;
  }

  const s3: S3Client;

  interface SQLQuery<T = any> extends Promise<T> {
    values(): Promise<any[][]>;
    raw(): Promise<Buffer[]>;
    simple(): this;
  }

  interface SQLInstance {
    <T = any>(strings: TemplateStringsArray, ...values: unknown[]): SQLQuery<T>;
    (value: unknown, ...columns: string[]): unknown;
    begin<T>(fn: (tx: SQLInstance) => Promise<T> | T): Promise<T>;
    unsafe<T = any>(query: string, params?: unknown[]): SQLQuery<T>;
    file<T = any>(path: string, params?: unknown[]): SQLQuery<T>;
    reserve(): Promise<SQLInstance & { release(): void }>;
    close(options?: { timeout?: number }): Promise<void>;
  }

  interface SQLConstructor {
    new (
      urlOrOptions?: string | URL | Record<string, unknown>,
      options?: Record<string, unknown>,
    ): SQLInstance;
  }

  const SQL: SQLConstructor;
  const sql: SQLInstance;

  class Archive {
    constructor(
      entriesOrTarball:
        | Record<string, string | Blob | ArrayBufferView | ArrayBuffer>
        | ArrayBufferView
        | ArrayBuffer
        | Blob,
      options?: { compress?: "gzip"; level?: number },
    );
    extract(
      targetDir: string,
      options?: { glob?: string | readonly string[] },
    ): Promise<number>;
    files(glob?: string | readonly string[]): Promise<Map<string, File>>;
    bytes(): Promise<Uint8Array>;
    blob(): Promise<Blob>;
  }

  interface GlobScanOptions {
    cwd?: string;
    dot?: boolean;
    absolute?: boolean;
    followSymlinks?: boolean;
    throwErrorOnBrokenSymlink?: boolean;
    onlyFiles?: boolean;
  }

  class Glob {
    constructor(pattern: string);
    scan(optionsOrCwd?: string | GlobScanOptions): AsyncIterable<string>;
    scanSync(optionsOrCwd?: string | GlobScanOptions): Iterable<string>;
    match(str: string): boolean;
  }

  type DigestEncoding = "hex" | "base64" | "base64url";

  class CryptoHasher {
    static hash(
      algorithm: string,
      data: string | ArrayBufferView | ArrayBuffer,
      encoding: DigestEncoding,
    ): string;
    static hash(
      algorithm: string,
      data: string | ArrayBufferView | ArrayBuffer,
    ): Uint8Array;
    constructor(
      algorithm: string,
      secretKey?: string | ArrayBufferView | ArrayBuffer,
    );
    update(
      data: string | ArrayBufferView | ArrayBuffer,
      inputEncoding?: string,
    ): this;
    digest(): Uint8Array;
    digest(encoding: DigestEncoding): string;
  }

  interface HashNamespace {
    (
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number | bigint,
    ): bigint | number;
    wyhash(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number | bigint,
    ): bigint;
    crc32(data: string | ArrayBufferView | ArrayBuffer, seed?: number): number;
    adler32(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number,
    ): number;
    cityHash32(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number,
    ): number;
    cityHash64(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number | bigint,
    ): bigint;
    xxHash32(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number,
    ): number;
    xxHash64(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number | bigint,
    ): bigint;
    xxHash3(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number | bigint,
    ): bigint;
    murmur32v3(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number,
    ): number;
    murmur32v2(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number,
    ): number;
    murmur64v2(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number | bigint,
    ): bigint;
    rapidhash(
      data: string | ArrayBufferView | ArrayBuffer,
      seed?: number | bigint,
    ): bigint;
  }

  const hash: HashNamespace;

  const password: {
    hash(
      password: string | ArrayBufferView,
      options?:
        | {
            algorithm?: "argon2id" | "argon2i" | "argon2d";
            memoryCost?: number;
            timeCost?: number;
          }
        | { algorithm: "bcrypt"; cost?: number },
    ): Promise<string>;
    verify(
      password: string | ArrayBufferView,
      hash: string,
      algorithm?: string,
    ): Promise<boolean>;
    hashSync(
      password: string | ArrayBufferView,
      options?: Record<string, unknown>,
    ): string;
    verifySync(
      password: string | ArrayBufferView,
      hash: string,
      algorithm?: string,
    ): boolean;
  };

  const semver: {
    satisfies(version: string, range: string): boolean;
    order(a: string, b: string): -1 | 0 | 1;
  };

  function color(
    input: string | number | Record<string, number> | number[],
    outputFormat?: string,
  ): any;

  type TranspilerLoader = "jsx" | "js" | "ts" | "tsx";

  class Transpiler {
    constructor(options?: {
      loader?: TranspilerLoader;
      target?: "browser" | "bun" | "node";
      define?: Record<string, string>;
      tsconfig?: string | Record<string, unknown>;
      trimUnusedImports?: boolean;
      minifyWhitespace?: boolean;
      inline?: boolean;
    });
    transform(code: string, loader?: TranspilerLoader): Promise<string>;
    transformSync(code: string, loader?: TranspilerLoader): string;
    scan(code: string): {
      exports: string[];
      imports: Array<{ path: string; kind: string }>;
    };
    scanImports(code: string): Array<{ path: string; kind: string }>;
  }

  interface BunPlugin {
    name: string;
    target?: "bun" | "browser" | "node";
    setup(build: PluginBuilder): void | Promise<void>;
  }

  interface PluginBuilder {
    onStart(callback: () => void | Promise<void>): void;
    onResolve(
      args: { filter: RegExp; namespace?: string },
      callback: (args: {
        path: string;
        importer: string;
        namespace: string;
      }) =>
        | { path: string; namespace?: string; external?: boolean }
        | undefined
        | void
        | Promise<
            | { path: string; namespace?: string; external?: boolean }
            | undefined
            | void
          >,
    ): void;
    onLoad(
      args: { filter: RegExp; namespace?: string },
      callback: (args: {
        path: string;
        namespace: string;
        loader: string;
        defer: () => Promise<void>;
      }) =>
        | {
            contents?: string | Uint8Array;
            exports?: Record<string, unknown>;
            loader?: string;
          }
        | undefined
        | void
        | Promise<
            | {
                contents?: string | Uint8Array;
                exports?: Record<string, unknown>;
                loader?: string;
              }
            | undefined
            | void
          >,
    ): void;
    config?: Record<string, unknown>;
  }

  function plugin(plg: BunPlugin): void;

  interface BuildArtifact extends Blob {
    readonly path: string;
    readonly loader: string;
    readonly hash: string | null;
    readonly kind: "entry-point" | "chunk" | "asset" | "sourcemap" | "bytecode";
    readonly sourcemap: BuildArtifact | null;
  }

  interface BuildOutput {
    success: boolean;
    outputs: BuildArtifact[];
    logs: Array<{ message: string; level: string }>;
  }

  function build(options: {
    entrypoints: string[];
    outdir?: string;
    target?: "bun" | "browser" | "node";
    format?: "esm" | "cjs" | "iife";
    minify?:
      | boolean
      | { whitespace?: boolean; identifiers?: boolean; syntax?: boolean };
    sourcemap?: "none" | "linked" | "inline" | "external" | boolean;
    splitting?: boolean;
    bytecode?: boolean;
    plugins?: BunPlugin[];
    external?: string[];
    define?: Record<string, string>;
    naming?: string | Record<string, string>;
  }): Promise<BuildOutput>;

  interface Server {
    readonly port: number;
    readonly hostname: string;
    readonly url: URL;
    readonly development: boolean;
    stop(closeActiveConnections?: boolean): void;
    reload(options: Record<string, unknown>): void;
    upgrade(
      req: Request,
      options?: { headers?: HeadersInit; data?: unknown },
    ): boolean;
    publish(
      topic: string,
      data: string | ArrayBufferView | ArrayBuffer,
      compress?: boolean,
    ): number;
  }

  function serve(options: {
    port?: number;
    hostname?: string;
    idleTimeout?: number;
    development?: boolean | { hmr?: boolean; console?: boolean };
    routes?: Record<string, any>;
    fetch?: (
      this: Server,
      req: Request,
      server: Server,
    ) => Response | Promise<Response | undefined> | undefined;
    websocket?: Record<string, any>;
    tls?: Record<string, any>;
    error?: (error: Error) => Response | Promise<Response>;
  }): Server;

  interface Subprocess {
    readonly pid: number;
    readonly stdin: FileSink | number | undefined;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exited: Promise<number>;
    readonly exitCode: number | null;
    kill(exitCode?: number | string): void;
    unref(): void;
    ref(): void;
  }

  interface SyncSubprocess {
    readonly pid: number;
    readonly exitCode: number;
    readonly success: boolean;
    readonly stdout: Buffer;
    readonly stderr: Buffer;
  }

  function spawn(
    cmd:
      | string[]
      | {
          cmd: string[];
          cwd?: string;
          env?: Record<string, string | undefined>;
          stdin?: any;
          stdout?: any;
          stderr?: any;
        },
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: "pipe" | "inherit" | "ignore" | Uint8Array | Blob | null;
      stdout?: "pipe" | "inherit" | "ignore" | null;
      stderr?: "pipe" | "inherit" | "ignore" | null;
      onExit?: (...args: any[]) => void;
    },
  ): Subprocess;

  function spawnSync(
    cmd:
      | string[]
      | {
          cmd: string[];
          cwd?: string;
          env?: Record<string, string | undefined>;
          stdin?: any;
          stdout?: any;
          stderr?: any;
        },
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: "pipe" | "inherit" | "ignore" | Uint8Array | null;
      stdout?: "pipe" | "inherit" | "ignore" | null;
      stderr?: "pipe" | "inherit" | "ignore" | null;
      timeout?: number;
    },
  ): SyncSubprocess;

  interface ShellPromise extends Promise<ShellOutput> {
    quiet(): ShellPromise;
    nothrow(): ShellPromise;
    text(encoding?: string): Promise<string>;
    json<T = any>(): Promise<T>;
    lines(): AsyncIterable<string>;
    blob(): Promise<Blob>;
    cwd(newCwd: string): ShellPromise;
    env(newEnv: Record<string, string | undefined>): ShellPromise;
  }

  interface ShellOutput {
    readonly stdout: Buffer;
    readonly stderr: Buffer;
    readonly exitCode: number;
    text(encoding?: string): string;
    json<T = any>(): T;
    bytes(): Uint8Array;
    blob(): Blob;
  }

  function $(
    strings: TemplateStringsArray,
    ...expressions: unknown[]
  ): ShellPromise;

  function file(
    path: string | URL | Uint8Array | ArrayBufferLike,
    options?: { type?: string },
  ): BunFile;
  function write(
    destination: string | URL | BunFile | S3File,
    input:
      | string
      | Blob
      | ArrayBufferView
      | ArrayBuffer
      | Response
      | BunFile
      | S3File
      | Archive,
    options?: { createPath?: boolean; mode?: number },
  ): Promise<number>;

  function sleep(ms: number | Date): Promise<void>;
  function sleepSync(ms: number): void;
  function which(
    bin: string,
    options?: { PATH?: string; cwd?: string },
  ): string | null;
  function randomUUIDv7(
    encoding?: "hex" | "base64" | "base64url",
    timestamp?: number,
  ): string;
  function randomUUIDv7(encoding: "buffer", timestamp?: number): Buffer;
  function nanoseconds(): number;
  function stringWidth(
    input: string,
    options?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean },
  ): number;
  function inspect(
    value: unknown,
    options?: { colors?: boolean; depth?: number; sorted?: boolean },
  ): string;
  function escapeHTML(value: string | object | number | boolean): string;
  function deepEquals(a: unknown, b: unknown, strict?: boolean): boolean;

  function gzipSync(
    data: Uint8Array,
    options?: { level?: number; memLevel?: number; windowBits?: number },
  ): Uint8Array;
  function gunzipSync(data: Uint8Array): Uint8Array;
  function deflateSync(
    data: Uint8Array,
    options?: { level?: number; memLevel?: number; windowBits?: number },
  ): Uint8Array;
  function inflateSync(data: Uint8Array): Uint8Array;
  function zstdCompressSync(
    data: Uint8Array | ArrayBuffer | string,
    options?: { level?: number },
  ): Uint8Array;
  function zstdDecompressSync(data: Uint8Array | ArrayBuffer): Uint8Array;
  function zstdCompress(
    data: Uint8Array | ArrayBuffer | string,
    options?: { level?: number },
  ): Promise<Uint8Array>;
  function zstdDecompress(data: Uint8Array | ArrayBuffer): Promise<Uint8Array>;

  const TOML: { parse(input: string): Record<string, any> };
  const YAML: { parse(input: string): any; stringify(value: unknown): string };
  const JSON5: { parse(input: string): any; stringify(value: unknown): string };
  const JSONL: {
    parse(input: string | Uint8Array): any[];
    parseChunk(input: string | Uint8Array): any;
  };
  const dns: {
    lookup(
      hostname: string,
      options?: Record<string, unknown>,
    ): Promise<Array<{ address: string; family: number; ttl?: number }>>;
    prefetch(hostname: string, port?: number): void;
    getCacheStats(): Record<string, number>;
  };
}

declare module "bun" {
  export import version = Bun.version;
  export import revision = Bun.revision;
  export import main = Bun.main;
  export import env = Bun.env;
  export import file = Bun.file;
  export import write = Bun.write;
  export import serve = Bun.serve;
  export import build = Bun.build;
  export import spawn = Bun.spawn;
  export import spawnSync = Bun.spawnSync;
  export import sleep = Bun.sleep;
  export import sleepSync = Bun.sleepSync;
  export import which = Bun.which;
  export import randomUUIDv7 = Bun.randomUUIDv7;
  export import nanoseconds = Bun.nanoseconds;
  export import stringWidth = Bun.stringWidth;
  export import inspect = Bun.inspect;
  export import escapeHTML = Bun.escapeHTML;
  export import deepEquals = Bun.deepEquals;
  export import plugin = Bun.plugin;
  export import color = Bun.color;
  export import semver = Bun.semver;
  export import password = Bun.password;
  export import hash = Bun.hash;
  export import CryptoHasher = Bun.CryptoHasher;
  export import Glob = Bun.Glob;
  export import Transpiler = Bun.Transpiler;
  export import Archive = Bun.Archive;
  export import Image = Bun.Image;
  export import S3Client = Bun.S3Client;
  export import s3 = Bun.s3;
  export import SQL = Bun.SQL;
  export import sql = Bun.sql;
  export import $ = Bun.$;
  export import gzipSync = Bun.gzipSync;
  export import gunzipSync = Bun.gunzipSync;
  export import deflateSync = Bun.deflateSync;
  export import inflateSync = Bun.inflateSync;
  export import zstdCompressSync = Bun.zstdCompressSync;
  export import zstdDecompressSync = Bun.zstdDecompressSync;
  export import zstdCompress = Bun.zstdCompress;
  export import zstdDecompress = Bun.zstdDecompress;
  export import TOML = Bun.TOML;
  export import YAML = Bun.YAML;
  export import JSON5 = Bun.JSON5;
  export import JSONL = Bun.JSONL;
  export import dns = Bun.dns;
  export type BunPlugin = Bun.BunPlugin;
  export type BunFile = Bun.BunFile;
  export type S3File = Bun.S3File;
  export type Server = Bun.Server;
}

declare module "bun:sqlite" {
  export class Statement<ResultType = any, ParamsType extends any[] = any[]> {
    get(...params: ParamsType): ResultType | null;
    all(...params: ParamsType): ResultType[];
    values(...params: ParamsType): any[][];
    run(...params: any[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
    finalize(): void;
    toString(): string;
  }

  export class Database {
    static deserialize(
      serialized: Uint8Array,
      options?: { readonly?: boolean; strict?: boolean },
    ): Database;
    constructor(
      filename?: string | Uint8Array,
      options?:
        | number
        | {
            readonly?: boolean;
            create?: boolean;
            readwrite?: boolean;
            strict?: boolean;
            safeIntegers?: boolean;
          },
    );
    query<ResultType = any, ParamsType extends any[] = any[]>(
      sql: string,
    ): Statement<ResultType, ParamsType>;
    prepare<ResultType = any, ParamsType extends any[] = any[]>(
      sql: string,
      params?: ParamsType,
    ): Statement<ResultType, ParamsType>;
    run(
      sql: string,
      ...bindings: any[]
    ): { changes: number; lastInsertRowid: number | bigint };
    exec(
      sql: string,
      ...bindings: any[]
    ): { changes: number; lastInsertRowid: number | bigint };
    transaction<T extends (...args: any[]) => any>(
      fn: T,
    ): T & {
      deferred: T;
      immediate: T;
      exclusive: T;
    };
    serialize(name?: string): Uint8Array;
    loadExtension(extension: string, entryPoint?: string): void;
    close(throwOnError?: boolean): void;
  }
}

declare module "bun:ffi" {
  export type Pointer = number & { readonly __pointerBrand?: unique symbol };

  export const suffix: "dll" | "so" | "dylib";

  export const FFIType: {
    readonly void: "void";
    readonly bool: "bool";
    readonly char: "char";
    readonly i8: "i8";
    readonly u8: "u8";
    readonly i16: "i16";
    readonly u16: "u16";
    readonly i32: "i32";
    readonly u32: "u32";
    readonly i64: "i64";
    readonly u64: "u64";
    readonly i64_fast: "i64_fast";
    readonly u64_fast: "u64_fast";
    readonly f32: "f32";
    readonly f64: "f64";
    readonly ptr: "ptr";
    readonly pointer: "pointer";
    readonly cstring: "cstring";
    readonly buffer: "buffer";
    readonly function: "function";
  };

  export class CString extends String {
    readonly ptr: Pointer;
    readonly byteOffset?: number;
    readonly byteLength?: number;
    constructor(
      ptr: Pointer | number,
      byteOffset?: number,
      byteLength?: number,
    );
    override toString(): string;
  }

  export function ptr(data: ArrayBufferView | ArrayBuffer): Pointer;
  export function ptr(
    data: ArrayBufferView | ArrayBuffer,
    byteOffset: number,
  ): Pointer;
  export function toArrayBuffer(
    ptr: Pointer | number,
    byteOffset?: number,
    byteLength?: number,
  ): ArrayBuffer;

  export const read: {
    u8(ptr: Pointer | number, offset?: number): number;
    i8(ptr: Pointer | number, offset?: number): number;
    u16(ptr: Pointer | number, offset?: number): number;
    i16(ptr: Pointer | number, offset?: number): number;
    u32(ptr: Pointer | number, offset?: number): number;
    i32(ptr: Pointer | number, offset?: number): number;
    u64(ptr: Pointer | number, offset?: number): bigint;
    i64(ptr: Pointer | number, offset?: number): bigint;
    f32(ptr: Pointer | number, offset?: number): number;
    f64(ptr: Pointer | number, offset?: number): number;
    ptr(ptr: Pointer | number, offset?: number): number;
  };

  export function dlopen<
    T extends Record<string, { args?: readonly string[]; returns?: string }>,
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

declare module "bun:test" {
  export interface Matchers<T = any> {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toContainEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toHaveProperty(keyPath: string | string[], value?: unknown): void;
    toMatch(expected: RegExp | string): void;
    toMatchObject(expected: Record<string, unknown> | unknown[]): void;
    toStartWith(expected: string): void;
    toEndWith(expected: string): void;
    toBeGreaterThan(expected: number | bigint): void;
    toBeGreaterThanOrEqual(expected: number | bigint): void;
    toBeLessThan(expected: number | bigint): void;
    toBeLessThanOrEqual(expected: number | bigint): void;
    toBeCloseTo(expected: number, numDigits?: number): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeNaN(): void;
    toBeInstanceOf(expected: unknown): void;
    toBeArray(): void;
    toThrow(
      expected?: string | RegExp | Error | (new (...args: any[]) => any),
    ): void;
    not: Matchers<T>;
    resolves: Matchers<Awaited<T>>;
    rejects: Matchers<unknown>;
  }

  export function describe(name: string, fn: () => void | Promise<void>): void;
  export namespace describe {
    function skip(name: string, fn: () => void | Promise<void>): void;
    function only(name: string, fn: () => void | Promise<void>): void;
    function todo(name: string, fn?: () => void | Promise<void>): void;
  }

  export interface TestFn {
    (
      name: string,
      fn: () => void | Promise<void>,
      timeout?: number | { timeout?: number },
    ): void;
    skip(name: string, fn: () => void | Promise<void>): void;
    only(name: string, fn: () => void | Promise<void>): void;
    todo(name: string, fn?: () => void | Promise<void>): void;
    if(condition: boolean): TestFn;
    skipIf(condition: boolean): TestFn;
  }

  export const test: TestFn;
  export const it: TestFn;
  export function beforeAll(
    fn: () => void | Promise<void>,
    timeout?: number,
  ): void;
  export function afterAll(
    fn: () => void | Promise<void>,
    timeout?: number,
  ): void;
  export function beforeEach(
    fn: () => void | Promise<void>,
    timeout?: number,
  ): void;
  export function afterEach(
    fn: () => void | Promise<void>,
    timeout?: number,
  ): void;
  export function expect<T = any>(actual: T): Matchers<T>;
  export namespace expect {
    function arrayContaining(arr: readonly unknown[]): any;
    function objectContaining(obj: Record<string, unknown>): any;
    function stringContaining(str: string): any;
    function stringMatching(str: string | RegExp): any;
    function anything(): any;
    function any(ctor: unknown): any;
  }
  export function mock<
    T extends (...args: any[]) => any = (...args: any[]) => any,
  >(impl?: T): T & { mockClear(): void };
  export function spyOn<T extends object, K extends keyof T>(
    obj: T,
    method: K,
  ): any;
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
    isSymbolicLink(): boolean;
  }
  export function existsSync(path: string | URL): boolean;
  export function mkdirSync(
    path: string | URL,
    options?: { recursive?: boolean; mode?: number },
  ): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(
    path: string | URL,
    encoding: "utf8" | "utf-8" | { encoding: "utf8" | "utf-8" },
  ): string;
  export function readFileSync(path: string | URL): Buffer;
  export function readFileSync(
    path: string | URL,
    options?: string | { encoding?: string | null },
  ): any;
  export function writeFileSync(
    path: string | URL,
    data: string | ArrayBufferView,
    options?: string | { encoding?: string; mode?: number },
  ): void;
  export function appendFileSync(
    path: string | URL,
    data: string | ArrayBufferView,
    options?: string | { encoding?: string; mode?: number },
  ): void;
  export function copyFileSync(
    src: string | URL,
    dest: string | URL,
    mode?: number,
  ): void;
  export function statSync(path: string | URL): Stats;
  export function lstatSync(path: string | URL): Stats;
  export function readdirSync(
    path: string | URL,
    options: { withFileTypes: true; recursive?: boolean },
  ): Dirent[];
  export function readdirSync(
    path: string | URL,
    options?: { withFileTypes?: false; recursive?: boolean },
  ): string[];
  export function unlinkSync(path: string | URL): void;
  export function rmSync(
    path: string | URL,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
  export function renameSync(
    oldPath: string | URL,
    newPath: string | URL,
  ): void;
  export function chmodSync(path: string | URL, mode: number): void;
  export function realpathSync(path: string | URL): string;
}

declare module "fs" {
  export * from "node:fs";
}

declare module "node:fs/promises" {
  export function readFile(
    path: string | URL,
    encoding: "utf8" | "utf-8",
  ): Promise<string>;
  export function readFile(path: string | URL): Promise<Buffer>;
  export function writeFile(
    path: string | URL,
    data: string | ArrayBufferView,
    encoding?: string,
  ): Promise<void>;
  export function mkdir(
    path: string | URL,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<string | undefined>;
  export function rm(
    path: string | URL,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  export function readdir(
    path: string | URL,
    options?: Record<string, unknown>,
  ): Promise<any[]>;
  export function stat(path: string | URL): Promise<import("node:fs").Stats>;
}

declare module "node:path" {
  export const sep: "\\" | "/";
  export const delimiter: ";" | ":";
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
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

declare module "path" {
  export * from "node:path";
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
  export function platform(): string;
  export function arch(): string;
  export function cpus(): Array<{ model: string; speed: number }>;
  export function hostname(): string;
}

declare module "os" {
  export * from "node:os";
}

declare module "node:child_process" {
  export interface ExecSyncOptions {
    cwd?: string;
    encoding?: "utf8" | "utf-8" | "buffer" | string;
    env?: Record<string, string | undefined>;
    stdio?:
      "pipe" | "ignore" | "inherit" | Array<"pipe" | "ignore" | "inherit">;
    timeout?: number;
    windowsHide?: boolean;
  }
  export function execSync(
    command: string,
    options: ExecSyncOptions & { encoding: "utf8" | "utf-8" },
  ): string;
  export function execSync(
    command: string,
    options?: ExecSyncOptions,
  ): Buffer | string;

  export interface SpawnSyncOptions {
    cwd?: string;
    encoding?: "utf8" | "utf-8" | string;
    env?: Record<string, string | undefined>;
    stdio?:
      "pipe" | "ignore" | "inherit" | Array<"pipe" | "ignore" | "inherit">;
    shell?: boolean;
    timeout?: number;
    windowsHide?: boolean;
  }
  export interface SpawnSyncReturns<T = string | Buffer> {
    pid: number;
    output: Array<T | null>;
    stdout: T;
    stderr: T;
    status: number | null;
    signal: string | null;
    error?: Error;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions & { encoding: "utf8" | "utf-8" },
  ): SpawnSyncReturns<string>;
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: SpawnSyncOptions,
  ): SpawnSyncReturns<any>;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | ArrayBufferView, inputEncoding?: string): this;
    digest(): Buffer;
    digest(encoding: "hex" | "base64" | "base64url"): string;
  }
  export interface Hmac {
    update(data: string | ArrayBufferView, inputEncoding?: string): this;
    digest(): Buffer;
    digest(encoding: "hex" | "base64" | "base64url"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function createHmac(
    algorithm: string,
    key: string | ArrayBufferView,
  ): Hmac;
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  export function timingSafeEqual(
    a: ArrayBufferView,
    b: ArrayBufferView,
  ): boolean;
}

declare module "node:stream/web" {
  export const ReadableStream: typeof globalThis.ReadableStream;
  export const WritableStream: typeof globalThis.WritableStream;
  export const TransformStream: typeof globalThis.TransformStream;
}

declare module "node:zlib" {
  export const constants: Record<string, number>;
  export function brotliCompressSync(
    buf: ArrayBufferView | string,
    options?: Record<string, unknown>,
  ): Buffer;
  export function brotliDecompressSync(buf: ArrayBufferView): Buffer;
  export function gzipSync(
    buf: ArrayBufferView | string,
    options?: Record<string, unknown>,
  ): Buffer;
  export function gunzipSync(buf: ArrayBufferView): Buffer;
}
