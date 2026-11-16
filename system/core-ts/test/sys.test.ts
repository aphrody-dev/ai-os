import { describe, expect, test } from "bun:test";
import { ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AY_SYS_ABI_VERSION,
  DRM_FORMAT_ARGB8888,
  EGL_PLATFORM_D3D12_MESA,
  EGL_PLATFORM_GBM_KHR,
  EGL_PLATFORM_WAYLAND_KHR,
  STATUS_OBJECT_NAME_NOT_FOUND,
  STATUS_SUCCESS,
  WL_TILE_DWINDLE,
  WL_TILE_MASTER_STACK,
  computeWlTiles,
  findShellEntry,
  formatTermHex,
  formatTermSgr,
  getTermPalette,
  inspectWasmBinary,
  instantiateAySysWasm,
  listShellCatalog,
  listTermThemes,
  loadAySys,
  probeSysCpuCaps,
  searchShellCatalog,
  VTerm,
} from "../src/sys.ts";

describe("sys/ Layer-0 Pure C + x86_64 ASM Tree (libaysys)", () => {
  test("executes arch/x86/entry_64.S + kernel/sys.c (ay_rdtsc, ay_fnv1a64, ay_cpu_probe)", () => {
    const loaded = loadAySys();
    expect(loaded).not.toBeNull();
    const sym = loaded!.lib.symbols;

    expect(sym.ay_sys_abi_version()).toBe(AY_SYS_ABI_VERSION);

    const t1 = sym.ay_rdtsc();
    const t2 = sym.ay_rdtsc();
    expect(t2 >= t1).toBe(true);

    const payload = Buffer.from("sys-linux-wayland-wine-nt", "utf8");
    const h = sym.ay_fnv1a64(ptr(payload), payload.byteLength);
    expect(h !== 0n).toBe(true);

    const caps = probeSysCpuCaps();
    expect(caps.archId).toBe(1);
    expect(caps.hasSse42).toBe(true);
    expect(caps.hasAvx2).toBe(true);
  });

  test("drivers/gpu/drm: packs drm_mode_fb_cmd2 and selects Mesa 26.3 EGL 1.5 platforms", () => {
    const sym = loadAySys()!.lib.symbols;

    const fbBuf = new ArrayBuffer(104);
    const rc = sym.drm_fb_cmd2_init(
      ptr(new Uint8Array(fbBuf)),
      1920,
      1080,
      DRM_FORMAT_ARGB8888,
      0n,
      7,
    );
    expect(rc).toBe(0);

    const dv = new DataView(fbBuf);
    expect(dv.getUint32(4, true)).toBe(1920);
    expect(dv.getUint32(36, true)).toBe(7680);

    expect(sym.mesa_select_egl_platform(0, 1, 1)).toBe(
      EGL_PLATFORM_WAYLAND_KHR,
    );
    expect(sym.mesa_select_egl_platform(0, 0, 1)).toBe(EGL_PLATFORM_GBM_KHR);
    expect(sym.mesa_select_egl_platform(1, 0, 0)).toBe(EGL_PLATFORM_D3D12_MESA);
  });

  test("wayland/wire.c + xwm.c: Wayland 1.26 32-bit wire & XWayland WL_SURFACE_ID pairing", () => {
    const sym = loadAySys()!.lib.symbols;

    const dst = new Uint8Array(64);
    const args = new Uint32Array([42, 0, 0]);
    const nBytes = sym.wl_wire_encode(
      ptr(dst),
      dst.byteLength,
      10,
      1,
      ptr(args),
      args.length,
    );
    expect(nBytes).toBe(20);

    const outObj = new Uint32Array(1);
    const outOp = new Uint16Array(1);
    const outSz = new Uint16Array(1);
    expect(
      sym.wl_wire_decode_hdr(
        ptr(dst),
        nBytes,
        ptr(outObj),
        ptr(outOp),
        ptr(outSz),
      ),
    ).toBe(0);
    expect(outObj[0]).toBe(10);
    expect(outOp[0]).toBe(1);
    expect(outSz[0]).toBe(20);

    const xwmCtx = new Uint8Array(8 + 128 * 20);
    const WL_SURFACE_ID_ATOM = 297;
    sym.xwm_context_init(ptr(xwmCtx), WL_SURFACE_ID_ATOM);

    const clientMsg = new ArrayBuffer(32);
    const dv = new DataView(clientMsg);
    dv.setUint8(0, 33 | 0x80);
    dv.setUint8(1, 32);
    dv.setUint32(4, 0x00400001, true);
    dv.setUint32(8, WL_SURFACE_ID_ATOM, true);
    dv.setUint32(12, 55, true);

    expect(
      sym.xwm_handle_client_message(
        ptr(xwmCtx),
        ptr(new Uint8Array(clientMsg)),
      ),
    ).toBe(0);
    expect(sym.xwm_lookup_wl_surface(ptr(xwmCtx), 0x00400001)).toBe(55);
  });

  test("nt/status.c + wine/server_proto.c: NTSTATUS <-> -errno bijection & 64-byte wineserver request", () => {
    const sym = loadAySys()!.lib.symbols;

    expect(sym.nt_errno_to_ntstatus(0)).toBe(STATUS_SUCCESS);
    expect(sym.nt_errno_to_ntstatus(-2)).toBe(STATUS_OBJECT_NAME_NOT_FOUND);
    expect(sym.nt_status_to_errno(STATUS_OBJECT_NAME_NOT_FOUND)).toBe(-2);

    const req64 = new ArrayBuffer(64);
    const inline = Buffer.from("ntdll", "utf8");
    const packed = sym.wine_pack_server_req(
      ptr(new Uint8Array(req64)),
      42,
      ptr(inline),
      inline.byteLength,
      4096n,
    );
    expect(packed).toBe(64);

    const dv = new DataView(req64);
    expect(dv.getInt32(0, true)).toBe(42);
    expect(dv.getUint32(4, true)).toBe(5);
    expect(dv.getBigUint64(8, true)).toBe(4096n);
  });

  test("wayland/tiler.c + freestanding WASM32 parity", async () => {
    const rects = computeWlTiles(
      WL_TILE_DWINDLE,
      1920,
      1080,
      8,
      550,
      [101, 102, 103],
    );
    expect(rects).toHaveLength(3);
    expect(
      computeWlTiles(WL_TILE_MASTER_STACK, 1280, 720, 4, 500, [1, 2]),
    ).toHaveLength(2);

    const wasm = await instantiateAySysWasm();
    const exports = wasm.exports as {
      memory: WebAssembly.Memory;
      ay_sys_abi_version: () => number;
      nt_errno_to_ntstatus: (e: number) => number;
      wasm_simd_dot_i32: (
        aPtr: number,
        bPtr: number,
        count: number,
        outPtr: number,
      ) => number;
    };
    expect(exports.ay_sys_abi_version()).toBe(AY_SYS_ABI_VERSION);
    expect(exports.nt_errno_to_ntstatus(-2)).toBe(STATUS_OBJECT_NAME_NOT_FOUND);

    // Execute WebAssembly SIMD128 dot-product kernel inside linear memory
    const memI32 = new Int32Array(exports.memory.buffer, 1024, 16);
    for (let i = 0; i < 8; i++) {
      memI32[i] = i + 1;
      memI32[8 + i] = 10;
    }
    const outPtr = 2048;
    expect(exports.wasm_simd_dot_i32(1024, 1024 + 32, 8, outPtr)).toBe(0);
    const dv = new DataView(exports.memory.buffer);
    expect(dv.getBigInt64(outPtr, true)).toBe(360n);

    // Inspect compiled Wasm32 + WASI-SDK 34 + Wayland compositor binaries via C parser
    const root = join(import.meta.dir, "..", "..", "..");
    const ayWasm = inspectWasmBinary(
      readFileSync(join(root, "target", "sys", "aysys.wasm")),
    );
    expect(ayWasm.magic).toBe(0x6d736100);
    expect(ayWasm.version).toBe(1);
    expect(ayWasm.codeBytes).toBeGreaterThan(1000);

    const wasiCli = inspectWasmBinary(
      readFileSync(join(root, "target", "sys", "ay-wasm-inspect.wasm")),
    );
    expect(wasiCli.magic).toBe(0x6d736100);
    expect(wasiCli.totalBytes).toBeGreaterThan(5000);

    const wlComp = inspectWasmBinary(
      readFileSync(join(root, "apps", "web", "public", "wayland.wasm")),
    );
    expect(wlComp.magic).toBe(0x6d736100);
    expect(wlComp.exportSectionBytes).toBeGreaterThan(50);

    const m3Site = inspectWasmBinary(
      readFileSync(join(root, "target", "sys", "ay-m3-site.wasm")),
    );
    expect(m3Site.magic).toBe(0x6d736100);
    expect(m3Site.totalBytes).toBeGreaterThan(5000);
  });

  test("ui/m3.c: exact M3 colors, Expressive springs, adaptive shell & zero-alloc SSR HTML parity across DLL and Wasm", async () => {
    const sym = loadAySys()!.lib.symbols;

    // Exact seed #135B82 vibrant M3 roles (matches frameworks/design/tokens/tokens.json)
    expect(sym.ay_ui_color_argb(0, 8) >>> 0).toBe(0xff006492); // light primary
    expect(sym.ay_ui_color_argb(1, 8) >>> 0).toBe(0xff8bceff); // dark primary
    expect(sym.ay_ui_argb_to_abgr(0xff006492) >>> 0).toBe(0xff926400);

    // Expressive Fast-Spatial spring (damping 0.6, stiffness 800 -> overshoot > 1.0 before settling)
    const springBuf = new Float32Array(5);
    expect(sym.ay_ui_spring_init(ptr(springBuf), 0, 0, 1)).toBe(0);
    expect(springBuf[3]).toBeCloseTo(0.6, 4);
    expect(springBuf[4]).toBeCloseTo(800, 1);

    let maxVal = 0;
    let settled = 0;
    for (let frame = 0; frame < 90; frame++) {
      settled = sym.ay_ui_spring_step(ptr(springBuf), 1 / 120);
      if (springBuf[0]! > maxVal) maxVal = springBuf[0]!;
      if (settled === 1) break;
    }
    expect(maxVal).toBeGreaterThan(1.02); // Expressive spatial bounce
    expect(settled).toBe(1);
    expect(springBuf[0]).toBeCloseTo(1.0, 3);

    // Adaptive window classes & shell layout
    expect(sym.ay_ui_window_class(390)).toBe(0); // compact
    expect(sym.ay_ui_window_class(768)).toBe(1); // medium
    expect(sym.ay_ui_window_class(1440)).toBe(3); // large

    const shellWords = new Uint32Array(11);
    expect(sym.ay_ui_compute_shell(1440, 900, ptr(shellWords))).toBe(0);
    expect(shellWords[1]).toBe(9); // AY_UI_COMP_NAVIGATION_RAIL
    expect(shellWords[4]).toBe(3); // 3 columns
    expect(shellWords[5]).toBe(220); // 220dp wide rail on large

    // Zero-allocation Pure C SSR HTML card with XSS escaping
    const htmlBuf = new Uint8Array(1024);
    const title = Buffer.from("M3 <C & Wasm>", "utf8");
    const body = Buffer.from("Compose-first spring tokens", "utf8");
    const cta = Buffer.from("Launch", "utf8");
    const href = Buffer.from("/m3/", "utf8");
    const written = sym.ay_ui_emit_m3_card_html(
      ptr(htmlBuf),
      htmlBuf.byteLength,
      ptr(title),
      title.byteLength,
      ptr(body),
      body.byteLength,
      ptr(cta),
      cta.byteLength,
      ptr(href),
      href.byteLength,
    );
    expect(written).toBeGreaterThan(100);
    const html = new TextDecoder().decode(htmlBuf.subarray(0, written));
    expect(html).toContain("M3 &lt;C &amp; Wasm&gt;");
    expect(html).toContain(
      '<md-filled-button href="/m3/">Launch</md-filled-button>',
    );
    expect(html).toContain("var(--md-sys-color-surface-container-low)");

    // Verify freestanding Wasm32 exports exact same M3 colors
    const wasm = await instantiateAySysWasm();
    const exp = wasm.exports as {
      ay_ui_color_argb: (mode: number, role: number) => number;
      ay_ui_window_class: (w: number) => number;
    };
    expect(exp.ay_ui_color_argb(0, 8) >>> 0).toBe(0xff006492);
    expect(exp.ay_ui_color_argb(1, 8) >>> 0).toBe(0xff8bceff);
    expect(exp.ay_ui_window_class(1680)).toBe(4);
  });

  test("ui/shell_kit.c: terminal palettes, truecolor SGR & O(log N) 2026 shell/CLI/TUI catalog", async () => {
    const sym = loadAySys()!.lib.symbols;
    expect(sym.ay_shell_abi_version()).toBe(1);

    const themes = listTermThemes();
    expect(themes.length).toBeGreaterThanOrEqual(9);
    const aphrodyDark = getTermPalette("aphrody-m3-dark");
    expect(aphrodyDark).not.toBeNull();
    expect(aphrodyDark!.name).toBe("Aphrody M3 Dark");
    expect(aphrodyDark!.bg).toBe("#0C141B");
    expect(aphrodyDark!.ansi).toHaveLength(16);

    expect(formatTermHex(0xff89b4fa)).toBe("#89B4FA");
    expect(
      formatTermSgr(0xff89b4fa, 0xff1e1e2e, (1 << 0) | (1 << 4) | (1 << 5)),
    ).toBe("\x1b[1;38;2;137;180;250;48;2;30;30;46m");

    // Every catalog slug must be strictly ascending for O(log N) binary search
    const catalog = listShellCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(40);
    for (let i = 1; i < catalog.length; i++) {
      expect(catalog[i - 1]!.slug < catalog[i]!.slug).toBe(true);
    }
    for (const entry of catalog) {
      const found = findShellEntry(entry.slug);
      expect(found?.slug).toBe(entry.slug);
      expect(found?.docs).toStartWith("https://");
    }

    const starship = findShellEntry("STARSHIP");
    expect(starship?.version).toBe("1.27.0");
    expect(starship?.category).toBe("prompt");

    const nfMatches = searchShellCatalog("nerd-fonts");
    expect(nfMatches.some((e) => e.slug === "cascadia-code-nf")).toBe(true);

    const wasm = await instantiateAySysWasm();
    const exp = wasm.exports as {
      ay_shell_abi_version: () => number;
      ay_shell_index_count: () => number;
      ay_term_theme_count: () => number;
    };
    expect(exp.ay_shell_abi_version()).toBe(1);
    expect(exp.ay_shell_index_count()).toBe(catalog.length);
    expect(exp.ay_term_theme_count()).toBe(themes.length);
  });

  test("ui/vterm.c: Pure-C ECMA-48, UTF-8, alt-screen, scrollback, CPR/DA1/Kitty/OSC8, OSC-133 & WASM32 parity", async () => {
    const sym = loadAySys()!.lib.symbols;
    expect(sym.ay_vterm_abi_version()).toBe(2);
    expect(sym.ay_vterm_state_bytes()).toBeGreaterThan(4_000_000);

    const vt = new VTerm(80, 24, "aphrody-m3-dark");
    vt.feed("\x1b]0;aphrody-term\x07");
    vt.feed(
      "\x1b]133;A\x07❯ \x1b]133;B\x07cargo test --broken\r\n\x1b]133;C\x07\x1b[38;2;255;100;80merror[E0425]\x1b[0m: missing symbol\r\n\x1b]133;D;101\x07",
    );

    const meta = vt.meta();
    expect(meta.cols).toBe(80);
    expect(meta.rows).toBe(24);
    expect(meta.title).toBe("aphrody-term");
    expect(meta.failedCount).toBe(1);
    expect(meta.lastExitCode).toBe(101);
    expect(meta.blockCount).toBe(1);

    const blocks = vt.blocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.failed).toBe(true);
    expect(blocks[0]!.exitCode).toBe(101);
    expect(blocks[0]!.command).toContain("cargo test --broken");

    const screenText = vt.text();
    expect(screenText).toContain("cargo test --broken");
    expect(screenText).toContain("error[E0425]: missing symbol");

    // Verify packed WebGPU storage cells (`cp`, ABGR foreground 24-bit color)
    const gpu = vt.packGpuCells();
    expect(gpu.length).toBe(80 * 24 * 5);
    // Row 1 col 0 has 'e' (0x65) with RGB(255,100,80) -> ABGR 0xFF5064FF
    const row1Base = 80 * 5;
    expect(gpu[row1Base]).toBe("e".codePointAt(0)!);
    expect(gpu[row1Base + 1]! >>> 0).toBe(0xff5064ff);

    // Alt-screen isolates primary grid cleanly
    vt.feed("\x1b[?1049h\x1b[2J\x1b[HOpenCode TUI 🚀");
    expect(vt.meta().altScreen).toBe(true);
    expect(vt.text()).toContain("OpenCode TUI");
    vt.feed("\x1b[?1049l");
    expect(vt.meta().altScreen).toBe(false);
    expect(vt.text()).toContain("cargo test --broken");

    // Theme switching preserves non-default SGR and swaps palette fg/bg
    const catIdx = vt.setTheme("catppuccin-mocha");
    expect(catIdx).toBeGreaterThan(0);

    // Parity against freestanding aysys.wasm WebAssembly 3.0 export
    const wasm = await instantiateAySysWasm();
    const exp = wasm.exports as {
      memory: WebAssembly.Memory;
      ay_vterm_abi_version: () => number;
      ay_vterm_state_bytes: () => number;
      ay_vterm_init: (
        vt: number,
        cols: number,
        rows: number,
        theme: number,
      ) => number;
      ay_vterm_feed: (vt: number, ptr: number, len: number) => number;
      ay_vterm_copy_text: (vt: number, dst: number, cap: number) => number;
    };
    expect(exp.ay_vterm_abi_version()).toBe(2);
    const bytesNeeded = exp.ay_vterm_state_bytes();
    expect(bytesNeeded).toBe(sym.ay_vterm_state_bytes());

    const startByte = exp.memory.buffer.byteLength;
    const growPages = Math.ceil((bytesNeeded + 8192) / 65536);
    exp.memory.grow(growPages);
    const vtPtr = startByte;
    const inPtr = startByte + bytesNeeded + 64;
    const outPtr = inPtr + 512;
    expect(exp.ay_vterm_init(vtPtr, 40, 12, 0)).toBe(0);
    const msg = Buffer.from("Hello \x1b[32mWasm32\x1b[0m VT!", "utf8");
    new Uint8Array(exp.memory.buffer, inPtr, msg.byteLength).set(msg);
    expect(exp.ay_vterm_feed(vtPtr, inPtr, msg.byteLength)).toBe(0);
    const nOut = exp.ay_vterm_copy_text(vtPtr, outPtr, 512);
    expect(
      new TextDecoder().decode(new Uint8Array(exp.memory.buffer, outPtr, nOut)),
    ).toBe("Hello Wasm32 VT!");

    // v2 protocol coverage: scrollback, CPR/DA1/OSC11 replies, separated mouse modes,
    // colon truecolor SGR, synchronized output (?2026), Kitty keyboard stack, OSC 7/8/52
    const protoVt = new VTerm(80, 5, "aphrody-m3-dark");
    for (let i = 0; i < 12; i++) protoVt.feed(`line-${i}\r\n`);
    expect(protoVt.meta().scrollbackLen).toBeGreaterThanOrEqual(8);
    expect(protoVt.scrollLines(4)).toBe(4);
    expect(protoVt.text()).not.toContain("line-11");
    expect(protoVt.scrollLines(-4)).toBe(0);
    expect(protoVt.scrollbackText(0, 20)).toContain("line-0");

    protoVt.feed(
      "\x1b[6n\x1b[c\x1b[?2026h\x1b[?1002;1006h\x1b[>7u\x1b[38:2::10:20:30mX",
    );
    const replies = new TextDecoder().decode(protoVt.drainReplies());
    expect(replies).toContain("\x1b[");
    expect(replies).toContain("R");
    expect(replies).toContain("?62;");
    const pm = protoVt.meta();
    expect(pm.syncOutput).toBe(true);
    expect(pm.mouseMode).toBe(3); // 1002 button-event not overwritten by 1006!
    expect(pm.mouseFormat).toBe(2); // 1006 SGR format
    expect(pm.kittyFlags).toBe(7);

    protoVt.feed(
      "\x1b]7;file://host/C:/aphrody\x07\x1b]8;;https://aphrody.com\x07LINK\x1b]8;;\x07",
    );
    protoVt.feed("\x1b]52;c;SGVsbG8=\x07");
    expect(protoVt.meta().cwd).toContain("/C:/aphrody");
    expect(protoVt.getLink(1)).toBe("https://aphrody.com");
    expect(protoVt.drainClipboard()).toBe("Hello");
  });
});
