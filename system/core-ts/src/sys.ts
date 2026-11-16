// Direct bun:ffi + WebAssembly bridge to the central Layer-0 Pure C, Assembly & WebAssembly Core (`src/` -> `libaysys`).
// Contract: kernel/include/ay/sys.h
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AY_SYS_ABI_VERSION = 1;
export const AY_SYS_LIB_FILE = `${process.platform === "win32" ? "" : "lib"}aysys.${suffix}`;

export const DRM_FORMAT_XRGB8888 = 0x34325258;
export const DRM_FORMAT_ARGB8888 = 0x34325241;
export const EGL_PLATFORM_GBM_KHR = 0x31d7;
export const EGL_PLATFORM_WAYLAND_KHR = 0x31d8;
export const EGL_PLATFORM_D3D12_MESA = 0x31fd;

export const WL_TILE_DWINDLE = 0;
export const WL_TILE_MASTER_STACK = 1;
export const WL_TILE_MONOCLE = 2;

export const STATUS_SUCCESS = 0x00000000;
export const STATUS_OBJECT_NAME_NOT_FOUND = -1073741772; // 0xC0000034 as signed i32
export const STATUS_INVALID_PARAMETER = -1073741811; // 0xC000000D as signed i32

const sysSymbols = {
  ay_sys_abi_version: { args: [], returns: FFIType.u32 },
  ay_rdtsc: { args: [], returns: FFIType.u64 },
  ay_fnv1a64: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
  ay_cpu_probe: { args: [FFIType.ptr], returns: FFIType.i32 },
  drm_fb_cmd2_init: {
    args: [
      FFIType.ptr,
      FFIType.u32,
      FFIType.u32,
      FFIType.u32,
      FFIType.u64,
      FFIType.u32,
    ],
    returns: FFIType.i32,
  },
  mesa_select_egl_platform: {
    args: [FFIType.u32, FFIType.u32, FFIType.u32],
    returns: FFIType.i32,
  },
  wl_pack_size_opcode: {
    args: [FFIType.u32, FFIType.u16],
    returns: FFIType.u32,
  },
  wl_wire_encode: {
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.u32,
      FFIType.u16,
      FFIType.ptr,
      FFIType.u32,
    ],
    returns: FFIType.i32,
  },
  wl_wire_decode_hdr: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  wl_wire_put_string: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  xcb_build_setup_req: { args: [FFIType.ptr], returns: FFIType.i32 },
  xwm_context_init: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.void },
  xwm_handle_client_message: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  xwm_lookup_wl_surface: {
    args: [FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  wl_tile_compute: {
    args: [
      FFIType.u32,
      FFIType.u32,
      FFIType.u32,
      FFIType.u32,
      FFIType.u32,
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
  nt_errno_to_ntstatus: { args: [FFIType.i32], returns: FFIType.i32 },
  nt_status_to_errno: { args: [FFIType.i32], returns: FFIType.i32 },
  wine_pack_server_req: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.u64],
    returns: FFIType.i32,
  },
  wasm_uleb128_decode: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  wasm_inspect_module: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  wasm_simd_dot_i32: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  ay_ui_color_argb: {
    args: [FFIType.u32, FFIType.u32],
    returns: FFIType.u32,
  },
  ay_ui_argb_to_abgr: {
    args: [FFIType.u32],
    returns: FFIType.u32,
  },
  ay_ui_state_blend_argb: {
    args: [FFIType.u32, FFIType.u32, FFIType.u32],
    returns: FFIType.u32,
  },
  ay_ui_spring_init: {
    args: [FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.f32],
    returns: FFIType.i32,
  },
  ay_ui_spring_step: {
    args: [FFIType.ptr, FFIType.f32],
    returns: FFIType.i32,
  },
  ay_ui_window_class: {
    args: [FFIType.u32],
    returns: FFIType.u32,
  },
  ay_ui_compute_shell: {
    args: [FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  ay_ui_emit_m3_card_html: {
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
    returns: FFIType.i32,
  },
  ay_shell_abi_version: { args: [], returns: FFIType.u32 },
  ay_term_theme_count: { args: [], returns: FFIType.u32 },
  ay_term_theme_slug: {
    args: [FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_term_theme_name: {
    args: [FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_term_theme_find: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_term_palette_get: {
    args: [FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  ay_term_palette_argb: {
    args: [FFIType.u32, FFIType.u32],
    returns: FFIType.u32,
  },
  ay_term_format_sgr: {
    args: [FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_term_format_hex: {
    args: [FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_shell_index_count: { args: [], returns: FFIType.u32 },
  ay_shell_index_meta: {
    args: [FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  ay_shell_index_field: {
    args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_shell_index_find: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_shell_index_match: {
    args: [FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_vterm_abi_version: { args: [], returns: FFIType.u32 },
  ay_vterm_state_bytes: { args: [], returns: FFIType.u32 },
  ay_vterm_init: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32],
    returns: FFIType.i32,
  },
  ay_vterm_set_theme: {
    args: [FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  ay_vterm_resize: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32],
    returns: FFIType.i32,
  },
  ay_vterm_feed: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_vterm_reset_dirty: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  ay_vterm_get_meta: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  ay_vterm_get_block: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
  ay_vterm_pack_gpu_cells: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  ay_vterm_copy_row_text: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_vterm_copy_text: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_vterm_drain_replies: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_vterm_scroll_lines: {
    args: [FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  ay_vterm_set_scroll: {
    args: [FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  ay_vterm_get_link: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_vterm_drain_clipboard: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ay_vterm_copy_scrollback_text: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
} as const;

export interface AySysSymbols {
  ay_sys_abi_version(): number;
  ay_rdtsc(): bigint;
  ay_fnv1a64(ptr: number, len: number | bigint): bigint;
  ay_cpu_probe(outPtr: number): number;
  drm_fb_cmd2_init(
    fbPtr: number,
    width: number,
    height: number,
    format: number,
    modifier: number | bigint,
    handle: number,
  ): number;
  mesa_select_egl_platform(
    vendorId: number,
    hasWayland: number,
    hasDrm: number,
  ): number;
  wl_pack_size_opcode(sizeBytes: number, opcode: number): number;
  wl_wire_encode(
    bufPtr: number,
    cap: number | bigint,
    objectId: number,
    opcode: number,
    payloadPtr: number,
    payloadBytes: number,
  ): number;
  wl_wire_decode_hdr(
    bufPtr: number,
    len: number | bigint,
    objectIdOut: number,
    opcodeOut: number,
    sizeOut: number,
  ): number;
  wl_wire_put_string(
    bufPtr: number,
    cap: number | bigint,
    strPtr: number,
    strLen: number | bigint,
  ): number;
  xcb_build_setup_req(bufPtr: number): number;
  xwm_context_init(ctxPtr: number, screen: number): void;
  xwm_handle_client_message(ctxPtr: number, msgPtr: number): number;
  xwm_lookup_wl_surface(ctxPtr: number, xid: number): number;
  wl_tile_compute(
    mode: number,
    outW: number,
    outH: number,
    gapPx: number,
    masterPermille: number,
    idsPtr: number,
    count: number,
    outPtr: number,
  ): number;
  nt_errno_to_ntstatus(err: number): number;
  nt_status_to_errno(status: number): number;
  wine_pack_server_req(
    reqPtr: number,
    opcode: number,
    dataPtr: number,
    dataLen: number,
    replySize: number | bigint,
  ): number;
  wasm_uleb128_decode(
    ptr: number,
    len: number | bigint,
    outVal: number,
    outRead: number,
  ): number;
  wasm_inspect_module(
    ptr: number,
    len: number | bigint,
    outSummary: number,
  ): number;
  wasm_simd_dot_i32(
    aPtr: number,
    bPtr: number,
    len: number | bigint,
    outDot: number,
  ): number;
  ay_ui_color_argb(mode: number, role: number): number;
  ay_ui_argb_to_abgr(argb: number): number;
  ay_ui_state_blend_argb(
    containerArgb: number,
    stateLayerArgb: number,
    state: number,
  ): number;
  ay_ui_spring_init(
    outSpring: number,
    preset: number,
    initial: number,
    target: number,
  ): number;
  ay_ui_spring_step(springPtr: number, dtSeconds: number): number;
  ay_ui_window_class(widthDp: number): number;
  ay_ui_compute_shell(
    widthDp: number,
    heightDp: number,
    outShell: number,
  ): number;
  ay_ui_emit_m3_card_html(
    bufPtr: number,
    cap: number | bigint,
    titlePtr: number,
    titleLen: number | bigint,
    bodyPtr: number,
    bodyLen: number | bigint,
    ctaPtr: number,
    ctaLen: number | bigint,
    hrefPtr: number,
    hrefLen: number | bigint,
  ): number;
  ay_shell_abi_version(): number;
  ay_term_theme_count(): number;
  ay_term_theme_slug(
    themeIdx: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_term_theme_name(
    themeIdx: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_term_theme_find(slugPtr: number, len: number | bigint): number;
  ay_term_palette_get(themeIdx: number, outPtr: number): number;
  ay_term_palette_argb(themeIdx: number, slot: number): number;
  ay_term_format_sgr(
    fgArgb: number,
    bgArgb: number,
    attrs: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_term_format_hex(
    argb: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_shell_index_count(): number;
  ay_shell_index_meta(idx: number, outPtr: number): number;
  ay_shell_index_field(
    idx: number,
    fieldId: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_shell_index_find(slugPtr: number, len: number | bigint): number;
  ay_shell_index_match(
    idx: number,
    queryPtr: number,
    len: number | bigint,
  ): number;
  ay_vterm_abi_version(): number;
  ay_vterm_state_bytes(): number;
  ay_vterm_init(
    vtPtr: number,
    cols: number,
    rows: number,
    themeIdx: number,
  ): number;
  ay_vterm_set_theme(vtPtr: number, themeIdx: number): number;
  ay_vterm_resize(vtPtr: number, cols: number, rows: number): number;
  ay_vterm_feed(vtPtr: number, bytesPtr: number, len: number | bigint): number;
  ay_vterm_reset_dirty(vtPtr: number): number;
  ay_vterm_get_meta(vtPtr: number, outPtr: number): number;
  ay_vterm_get_block(vtPtr: number, idx: number, outPtr: number): number;
  ay_vterm_pack_gpu_cells(
    vtPtr: number,
    outCellsPtr: number,
    maxCells: number,
  ): number;
  ay_vterm_copy_row_text(
    vtPtr: number,
    row: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_vterm_copy_text(
    vtPtr: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_vterm_drain_replies(
    vtPtr: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_vterm_scroll_lines(vtPtr: number, delta: number): number;
  ay_vterm_set_scroll(vtPtr: number, offset: number): number;
  ay_vterm_get_link(
    vtPtr: number,
    slot: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_vterm_drain_clipboard(
    vtPtr: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
  ay_vterm_copy_scrollback_text(
    vtPtr: number,
    startOldest: number,
    rowCount: number,
    dstPtr: number,
    cap: number | bigint,
  ): number;
}

export interface AySysLib {
  symbols: AySysSymbols;
  close(): void;
}

let cachedSys: { lib: AySysLib; path: string } | null | undefined;

export function aySysLibCandidates(): string[] {
  const root = process.env.SRC_ROOT || join(import.meta.dir, "..", "..", "..");
  const target = process.env.CARGO_TARGET_DIR || join(root, "target");
  return [
    process.env.AY_SYS_LIB,
    join(root, "target", "sys", AY_SYS_LIB_FILE),
    join(target, "sys", AY_SYS_LIB_FILE),
    join(homedir(), ".local", "bin", AY_SYS_LIB_FILE),
    join(target, "release", AY_SYS_LIB_FILE),
  ].filter((p): p is string => Boolean(p));
}

export function loadAySys(): { lib: AySysLib; path: string } | null {
  if (cachedSys !== undefined) return cachedSys;
  cachedSys = null;
  for (const candidate of aySysLibCandidates()) {
    if (!existsSync(candidate)) continue;
    try {
      const lib = dlopen(candidate, sysSymbols) as unknown as AySysLib;
      if (lib.symbols.ay_sys_abi_version() === AY_SYS_ABI_VERSION) {
        cachedSys = { lib, path: candidate };
        break;
      }
      lib.close();
    } catch {
      // Try next candidate
    }
  }
  return cachedSys;
}

export interface CpuCapsSnapshot {
  archId: number;
  hasSse42: boolean;
  hasAvx2: boolean;
  hasAvx512f: boolean;
  tscSample: bigint;
}

export function probeSysCpuCaps(): CpuCapsSnapshot {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const buf = new ArrayBuffer(24);
  const u8 = new Uint8Array(buf);
  const rc = loaded.lib.symbols.ay_cpu_probe(ptr(u8));
  if (rc !== 0) throw new Error(`ay_cpu_probe failed: ${rc}`);
  const dv = new DataView(buf);
  return {
    archId: dv.getUint32(0, true),
    hasSse42: dv.getUint32(4, true) !== 0,
    hasAvx2: dv.getUint32(8, true) !== 0,
    hasAvx512f: dv.getUint32(12, true) !== 0,
    tscSample: dv.getBigUint64(16, true),
  };
}

export interface WlBoxRect {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function computeWlTiles(
  mode: number,
  outW: number,
  outH: number,
  gapPx: number,
  masterPermille: number,
  surfaceIds: number[],
): WlBoxRect[] {
  if (surfaceIds.length === 0) return [];
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const ids = new Uint32Array(surfaceIds);
  const outWords = new Uint32Array(surfaceIds.length * 5);
  const n = loaded.lib.symbols.wl_tile_compute(
    mode,
    outW,
    outH,
    gapPx,
    masterPermille,
    ptr(ids),
    ids.length,
    ptr(outWords),
  );
  if (n < 0) throw new Error(`wl_tile_compute failed: ${n}`);
  const rects: WlBoxRect[] = [];
  for (let i = 0; i < n; i++) {
    const base = i * 5;
    rects.push({
      id: outWords[base]!,
      x: outWords[base + 1]!,
      y: outWords[base + 2]!,
      w: outWords[base + 3]!,
      h: outWords[base + 4]!,
    });
  }
  return rects;
}

export interface WasmModuleSummary {
  magic: number;
  version: number;
  sectionMask: number;
  sectionCount: number;
  customSectionCount: number;
  codeBytes: number;
  exportSectionBytes: number;
  totalBytes: number;
}

export function inspectWasmBinary(bytes: Uint8Array): WasmModuleSummary {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const infoBuf = new ArrayBuffer(32);
  const rc = loaded.lib.symbols.wasm_inspect_module(
    ptr(bytes),
    bytes.byteLength,
    ptr(new Uint8Array(infoBuf)),
  );
  if (rc !== 0) throw new Error(`wasm_inspect_module failed: ${rc}`);
  const dv = new DataView(infoBuf);
  return {
    magic: dv.getUint32(0, true),
    version: dv.getUint32(4, true),
    sectionMask: dv.getUint32(8, true),
    sectionCount: dv.getUint32(12, true),
    customSectionCount: dv.getUint32(16, true),
    codeBytes: dv.getUint32(20, true),
    exportSectionBytes: dv.getUint32(24, true),
    totalBytes: dv.getUint32(28, true),
  };
}

export async function instantiateAySysWasm(
  wasmPath?: string,
): Promise<WebAssembly.Instance> {
  const root = process.env.SRC_ROOT || join(import.meta.dir, "..", "..", "..");
  const resolved = wasmPath ?? join(root, "target", "sys", "aysys.wasm");
  const bytes = readFileSync(resolved);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance;
}

export const SHELL_CATEGORIES = [
  "shell",
  "prompt",
  "terminal",
  "cli",
  "tui",
  "font",
  "theme",
  "icon",
] as const;

export const SHELL_SOURCES = [
  "builtin",
  "tools.toml",
  "cargo",
  "nerd-fonts",
  "pkg-mgr",
  "theme-pack",
] as const;

export type ShellCategory = (typeof SHELL_CATEGORIES)[number];
export type ShellSource = (typeof SHELL_SOURCES)[number];

export interface TermPalette {
  slug: string;
  name: string;
  bg: string;
  fg: string;
  cursorBg: string;
  cursorFg: string;
  selectionBg: string;
  selectionFg: string;
  accent: string;
  isDark: boolean;
  ansi: string[];
}

export interface ShellCatalogEntry {
  id: number;
  category: ShellCategory;
  source: ShellSource;
  platforms: { windows: boolean; linux: boolean; macos: boolean };
  slug: string;
  name: string;
  version: string;
  repo: string;
  docs: string;
  config: string;
  binary: string;
}

const textDec = new TextDecoder();
const textEnc = new TextEncoder();

function readCStringWith(
  fn: (dst: number, cap: number) => number,
  cap = 512,
): string {
  const buf = new Uint8Array(cap);
  const n = fn(ptr(buf), buf.byteLength);
  if (n < 0) throw new Error(`C ABI string read failed: ${n}`);
  return textDec.decode(buf.subarray(0, n));
}

export function formatTermHex(argb: number): string {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  return readCStringWith(
    (dst, cap) => loaded.lib.symbols.ay_term_format_hex(argb >>> 0, dst, cap),
    16,
  );
}

export function formatTermSgr(
  fgArgb: number,
  bgArgb: number,
  attrs: number,
): string {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  return readCStringWith(
    (dst, cap) =>
      loaded.lib.symbols.ay_term_format_sgr(
        fgArgb >>> 0,
        bgArgb >>> 0,
        attrs >>> 0,
        dst,
        cap,
      ),
    64,
  );
}

export function getTermPalette(slugOrIdx: string | number): TermPalette | null {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const sym = loaded.lib.symbols;
  let idx: number;
  if (typeof slugOrIdx === "number") {
    idx = slugOrIdx;
  } else {
    const raw = textEnc.encode(slugOrIdx);
    idx = sym.ay_term_theme_find(ptr(raw), raw.byteLength);
  }
  if (idx < 0 || idx >= sym.ay_term_theme_count()) return null;

  const words = new Uint32Array(24);
  if (sym.ay_term_palette_get(idx, ptr(words)) !== 0) return null;
  const ansi: string[] = [];
  for (let i = 0; i < 16; i++) ansi.push(formatTermHex(words[8 + i]!));
  return {
    slug: readCStringWith((d, c) => sym.ay_term_theme_slug(idx, d, c), 64),
    name: readCStringWith((d, c) => sym.ay_term_theme_name(idx, d, c), 64),
    bg: formatTermHex(words[0]!),
    fg: formatTermHex(words[1]!),
    cursorBg: formatTermHex(words[2]!),
    cursorFg: formatTermHex(words[3]!),
    selectionBg: formatTermHex(words[4]!),
    selectionFg: formatTermHex(words[5]!),
    accent: formatTermHex(words[6]!),
    isDark: words[7] === 1,
    ansi,
  };
}

export function listTermThemes(): TermPalette[] {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const count = loaded.lib.symbols.ay_term_theme_count();
  const out: TermPalette[] = [];
  for (let i = 0; i < count; i++) {
    const p = getTermPalette(i);
    if (p) out.push(p);
  }
  return out;
}

function readShellEntry(idx: number): ShellCatalogEntry | null {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const sym = loaded.lib.symbols;
  if (idx < 0 || idx >= sym.ay_shell_index_count()) return null;
  const meta = new Uint32Array(6);
  if (sym.ay_shell_index_meta(idx, ptr(meta)) !== 0) return null;
  const f = (id: number) =>
    readCStringWith((d, c) => sym.ay_shell_index_field(idx, id, d, c), 256);
  const plat = meta[3]!;
  return {
    id: meta[0]!,
    category: SHELL_CATEGORIES[meta[1]!] ?? "cli",
    source: SHELL_SOURCES[meta[2]!] ?? "builtin",
    platforms: {
      windows: (plat & 1) !== 0,
      linux: (plat & 2) !== 0,
      macos: (plat & 4) !== 0,
    },
    slug: f(0),
    name: f(1),
    version: f(2),
    repo: f(3),
    docs: f(4),
    config: f(5),
    binary: f(6),
  };
}

export function findShellEntry(slug: string): ShellCatalogEntry | null {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const raw = textEnc.encode(slug);
  const idx = loaded.lib.symbols.ay_shell_index_find(ptr(raw), raw.byteLength);
  return idx >= 0 ? readShellEntry(idx) : null;
}

export function listShellCatalog(
  category?: ShellCategory,
): ShellCatalogEntry[] {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const n = loaded.lib.symbols.ay_shell_index_count();
  const out: ShellCatalogEntry[] = [];
  for (let i = 0; i < n; i++) {
    const e = readShellEntry(i);
    if (e && (!category || e.category === category)) out.push(e);
  }
  return out;
}

export function searchShellCatalog(query: string): ShellCatalogEntry[] {
  const loaded = loadAySys();
  if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
  const sym = loaded.lib.symbols;
  const raw = textEnc.encode(query);
  const n = sym.ay_shell_index_count();
  const out: ShellCatalogEntry[] = [];
  for (let i = 0; i < n; i++) {
    if (sym.ay_shell_index_match(i, ptr(raw), raw.byteLength) === 1) {
      const e = readShellEntry(i);
      if (e) out.push(e);
    }
  }
  return out;
}

export const AY_VTERM_ABI_VERSION = 1;
export const AY_VTERM_MAX_COLS = 240;
export const AY_VTERM_MAX_ROWS = 80;
export const AY_VTERM_GPU_CELL_U32S = 5;

export interface VTermMeta {
  abiVersion: number;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  cursorStyle: number;
  altScreen: boolean;
  bracketedPaste: boolean;
  appCursor: boolean;
  mouseMode: number;
  titleDirty: boolean;
  mouseFormat: number;
  themeIdx: number;
  scrollCount: number;
  feedBytes: number;
  blockCount: number;
  failedCount: number;
  lastExitCode: number;
  dirtyRows: [number, number, number];
  title: string;
  scrollbackLen: number;
  viewOffset: number;
  replyPending: number;
  kittyFlags: number;
  syncOutput: boolean;
  focusEvents: boolean;
  cwdDirty: boolean;
  clipDirty: boolean;
  cwd: string;
}

export interface VTermBlock {
  id: number;
  startRow: number;
  cmdRow: number;
  outRow: number;
  endRow: number;
  exitCode: number;
  state: "empty" | "prompt" | "input" | "running" | "done";
  command: string;
  failed: boolean;
}

const VTERM_BLOCK_STATES = [
  "empty",
  "prompt",
  "input",
  "running",
  "done",
] as const;

export class VTerm {
  private readonly sym: AySysSymbols;
  private readonly stateBuf: Uint8Array;
  private readonly statePtr: number;
  private readonly metaBuf = new Uint8Array(468);
  private readonly blockBuf = new Uint8Array(152);
  private readonly replyScratch = new Uint8Array(512);
  private readonly clipScratch = new Uint8Array(1024);
  private textScratch = new Uint8Array(
    AY_VTERM_MAX_COLS * AY_VTERM_MAX_ROWS * 4,
  );
  private gpuScratch = new Uint32Array(
    AY_VTERM_MAX_COLS * AY_VTERM_MAX_ROWS * AY_VTERM_GPU_CELL_U32S,
  );

  constructor(cols = 120, rows = 36, themeSlugOrIdx: string | number = 0) {
    const loaded = loadAySys();
    if (!loaded) throw new Error(`${AY_SYS_LIB_FILE} not loaded`);
    this.sym = loaded.lib.symbols;
    const nBytes = this.sym.ay_vterm_state_bytes();
    this.stateBuf = new Uint8Array(nBytes);
    this.statePtr = ptr(this.stateBuf);
    const themeIdx = this.resolveThemeIdx(themeSlugOrIdx);
    const rc = this.sym.ay_vterm_init(this.statePtr, cols, rows, themeIdx);
    if (rc !== 0) throw new Error(`ay_vterm_init failed: ${rc}`);
  }

  private resolveThemeIdx(themeSlugOrIdx: string | number): number {
    if (typeof themeSlugOrIdx === "number") return themeSlugOrIdx >>> 0;
    const raw = textEnc.encode(themeSlugOrIdx);
    const found = this.sym.ay_term_theme_find(ptr(raw), raw.byteLength);
    return found >= 0 ? found : 0;
  }

  feed(input: string | Uint8Array): void {
    const raw = typeof input === "string" ? textEnc.encode(input) : input;
    if (raw.byteLength === 0) return;
    const rc = this.sym.ay_vterm_feed(this.statePtr, ptr(raw), raw.byteLength);
    if (rc !== 0) throw new Error(`ay_vterm_feed failed: ${rc}`);
  }

  resize(cols: number, rows: number): void {
    const rc = this.sym.ay_vterm_resize(this.statePtr, cols, rows);
    if (rc !== 0) throw new Error(`ay_vterm_resize failed: ${rc}`);
  }

  setTheme(themeSlugOrIdx: string | number): number {
    const idx = this.resolveThemeIdx(themeSlugOrIdx);
    const rc = this.sym.ay_vterm_set_theme(this.statePtr, idx);
    if (rc !== 0) throw new Error(`ay_vterm_set_theme failed: ${rc}`);
    return idx;
  }

  resetDirty(): void {
    this.sym.ay_vterm_reset_dirty(this.statePtr);
  }

  meta(): VTermMeta {
    const rc = this.sym.ay_vterm_get_meta(this.statePtr, ptr(this.metaBuf));
    if (rc !== 0) throw new Error(`ay_vterm_get_meta failed: ${rc}`);
    const dv = new DataView(
      this.metaBuf.buffer,
      this.metaBuf.byteOffset,
      this.metaBuf.byteLength,
    );
    const titleLen = dv.getUint32(56, true);
    const title = textDec.decode(this.metaBuf.subarray(60, 60 + titleLen));
    const cwdLen = Math.min(dv.getUint32(208, true), 255);
    const cwd = textDec.decode(this.metaBuf.subarray(212, 212 + cwdLen));
    return {
      abiVersion: dv.getUint32(0, true),
      cols: dv.getUint16(4, true),
      rows: dv.getUint16(6, true),
      cursorX: dv.getUint16(8, true),
      cursorY: dv.getUint16(10, true),
      cursorVisible: this.metaBuf[12] !== 0,
      cursorStyle: this.metaBuf[13]!,
      altScreen: this.metaBuf[14] !== 0,
      bracketedPaste: this.metaBuf[15] !== 0,
      appCursor: this.metaBuf[16] !== 0,
      mouseMode: this.metaBuf[17]!,
      titleDirty: this.metaBuf[18] !== 0,
      mouseFormat: this.metaBuf[19]!,
      themeIdx: dv.getUint32(20, true),
      scrollCount: dv.getUint32(24, true),
      feedBytes: dv.getUint32(28, true),
      blockCount: dv.getUint32(32, true),
      failedCount: dv.getUint32(36, true),
      lastExitCode: dv.getInt32(40, true),
      dirtyRows: [
        dv.getUint32(44, true),
        dv.getUint32(48, true),
        dv.getUint32(52, true),
      ],
      title,
      scrollbackLen: dv.getUint32(188, true),
      viewOffset: dv.getUint32(192, true),
      replyPending: dv.getUint32(196, true),
      kittyFlags: dv.getUint32(200, true),
      syncOutput: this.metaBuf[204] !== 0,
      focusEvents: this.metaBuf[205] !== 0,
      cwdDirty: this.metaBuf[206] !== 0,
      clipDirty: this.metaBuf[207] !== 0,
      cwd,
    };
  }

  blocks(): VTermBlock[] {
    const m = this.meta();
    const out: VTermBlock[] = [];
    const dv = new DataView(
      this.blockBuf.buffer,
      this.blockBuf.byteOffset,
      this.blockBuf.byteLength,
    );
    for (let i = 0; i < m.blockCount; i++) {
      if (
        this.sym.ay_vterm_get_block(this.statePtr, i, ptr(this.blockBuf)) !== 0
      )
        break;
      const exitCode = dv.getInt32(12, true);
      const stateIdx = dv.getUint32(16, true);
      const state = VTERM_BLOCK_STATES[stateIdx] ?? "empty";
      const cmdLen = Math.min(dv.getUint32(20, true), 127);
      out.push({
        id: dv.getUint32(0, true),
        startRow: dv.getUint16(4, true),
        cmdRow: dv.getUint16(6, true),
        outRow: dv.getUint16(8, true),
        endRow: dv.getUint16(10, true),
        exitCode,
        state,
        command: textDec.decode(this.blockBuf.subarray(24, 24 + cmdLen)),
        failed: state === "done" && exitCode !== 0,
      });
    }
    return out;
  }

  rowText(row: number): string {
    const n = this.sym.ay_vterm_copy_row_text(
      this.statePtr,
      row,
      ptr(this.textScratch),
      this.textScratch.byteLength,
    );
    if (n < 0) return "";
    return textDec.decode(this.textScratch.subarray(0, n));
  }

  text(): string {
    const n = this.sym.ay_vterm_copy_text(
      this.statePtr,
      ptr(this.textScratch),
      this.textScratch.byteLength,
    );
    if (n < 0) throw new Error(`ay_vterm_copy_text failed: ${n}`);
    return textDec.decode(this.textScratch.subarray(0, n));
  }

  lines(): string[] {
    const raw = this.text();
    return raw ? raw.split("\n") : [];
  }

  packGpuCells(): Uint32Array {
    const maxCells = AY_VTERM_MAX_COLS * AY_VTERM_MAX_ROWS;
    const count = this.sym.ay_vterm_pack_gpu_cells(
      this.statePtr,
      ptr(this.gpuScratch),
      maxCells,
    );
    if (count < 0) throw new Error(`ay_vterm_pack_gpu_cells failed: ${count}`);
    return this.gpuScratch.subarray(0, count * AY_VTERM_GPU_CELL_U32S);
  }

  drainReplies(): Uint8Array {
    const n = this.sym.ay_vterm_drain_replies(
      this.statePtr,
      ptr(this.replyScratch),
      this.replyScratch.byteLength,
    );
    if (n <= 0) return new Uint8Array(0);
    return this.replyScratch.slice(0, n);
  }

  scrollLines(delta: number): number {
    return this.sym.ay_vterm_scroll_lines(this.statePtr, delta | 0);
  }

  setScroll(offset: number): number {
    return this.sym.ay_vterm_set_scroll(this.statePtr, offset >>> 0);
  }

  getLink(slot: number): string {
    if (slot <= 0) return "";
    const n = this.sym.ay_vterm_get_link(
      this.statePtr,
      slot >>> 0,
      ptr(this.textScratch),
      1024,
    );
    if (n <= 0) return "";
    return textDec.decode(this.textScratch.subarray(0, n));
  }

  drainClipboard(): string {
    const n = this.sym.ay_vterm_drain_clipboard(
      this.statePtr,
      ptr(this.clipScratch),
      this.clipScratch.byteLength,
    );
    if (n <= 0) return "";
    return textDec.decode(this.clipScratch.subarray(0, n));
  }

  scrollbackText(startOldest = 0, rowCount = 1024): string {
    const cap = Math.max(this.textScratch.byteLength, rowCount * 256);
    const buf =
      cap <= this.textScratch.byteLength
        ? this.textScratch
        : new Uint8Array(cap);
    const n = this.sym.ay_vterm_copy_scrollback_text(
      this.statePtr,
      startOldest >>> 0,
      rowCount >>> 0,
      ptr(buf),
      buf.byteLength,
    );
    if (n <= 0) return "";
    return textDec.decode(buf.subarray(0, n));
  }
}
