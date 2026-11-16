declare var process: any;
declare var Buffer: any;
declare var Bun: any;

interface ImportMeta {
  dir: string;
  url: string;
}

declare module "fs" {
  export function existsSync(path: any): boolean;
  export function mkdirSync(path: any, options?: any): any;
  export function rmSync(path: any, options?: any): void;
  export function readFileSync(path: any, options?: any): any;
  export function writeFileSync(path: any, data: any, options?: any): void;
  export function statSync(path: any): any;
  export function readdirSync(path: any, options?: any): any;
}

declare module "path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
}

declare module "bun:test" {
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function expect(actual: any): any;
}
