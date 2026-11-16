// Zero-dep Pure C11 WebAssembly 3.0 (`aysys.wasm`) Virtual Terminal binding.
// Multiple terminal panes live cleanly inside WASM linear memory with zero JS duplicate VT parser.

const dec = new TextDecoder();
const enc = new TextEncoder();

export const VTERM_GPU_STRIDE_U32 = 5;
const BLOCK_STATES = ["empty", "prompt", "input", "running", "done"];

function argbToCss(argb) {
  return `#${((argb >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}

function argbToAbgr(argb) {
  const u = argb >>> 0;
  return ((u & 0xff00ff00) | ((u & 0xff) << 16) | ((u >>> 16) & 0xff)) >>> 0;
}

export async function loadVTermWasm(wasmUrl = "/aysys.wasm") {
  let instance;
  if (typeof WebAssembly.instantiateStreaming === "function") {
    try {
      ({ instance } = await WebAssembly.instantiateStreaming(
        fetch(wasmUrl),
        {},
      ));
    } catch {
      const resp = await fetch(wasmUrl);
      ({ instance } = await WebAssembly.instantiate(
        await resp.arrayBuffer(),
        {},
      ));
    }
  } else {
    const resp = await fetch(wasmUrl);
    ({ instance } = await WebAssembly.instantiate(
      await resp.arrayBuffer(),
      {},
    ));
  }

  const exp = instance.exports;
  const stateBytes = exp.ay_vterm_state_bytes();
  const maxCells = 240 * 80;
  const scratchBytes = maxCells * 20 + 65536;

  const baseByte = exp.memory.buffer.byteLength;
  const strideBytes = Math.ceil((stateBytes + 64) / 64) * 64;
  // Reserve shared scratch + 2 panes upfront; grow dynamically as split panes/tabs open
  const initialPoolPages = Math.ceil((scratchBytes + strideBytes * 2) / 65536);
  exp.memory.grow(initialPoolPages);

  const inPtr = baseByte;
  const metaPtr = baseByte + 16384;
  const blockPtr = baseByte + 17024;
  const textPtr = baseByte + 18000;
  const gpuPtr = baseByte + 65536;
  const arenaStart = baseByte + scratchBytes;
  const freeSlots = [];
  let nextSlot = 0;

  function allocState() {
    if (freeSlots.length > 0) return freeSlots.pop();
    const ptr = arenaStart + nextSlot * strideBytes;
    const neededEnd = ptr + strideBytes;
    if (neededEnd > exp.memory.buffer.byteLength) {
      const extraPages = Math.ceil(
        (neededEnd - exp.memory.buffer.byteLength) / 65536,
      );
      exp.memory.grow(extraPages);
    }
    nextSlot++;
    return ptr;
  }

  function listThemes() {
    const count = exp.ay_term_theme_count();
    const out = [];
    for (let i = 0; i < count; i++) {
      const nSlug = exp.ay_term_theme_slug(i, textPtr, 64);
      const slug = dec.decode(
        new Uint8Array(exp.memory.buffer, textPtr, Math.max(0, nSlug)),
      );
      const nName = exp.ay_term_theme_name(i, textPtr + 64, 64);
      const name = dec.decode(
        new Uint8Array(exp.memory.buffer, textPtr + 64, Math.max(0, nName)),
      );
      exp.ay_term_palette_get(i, metaPtr);
      const w = new Uint32Array(exp.memory.buffer, metaPtr, 24);
      out.push({
        idx: i,
        slug,
        name,
        bgArgb: w[0] >>> 0,
        fgArgb: w[1] >>> 0,
        cursorBgArgb: w[2] >>> 0,
        cursorFgArgb: w[3] >>> 0,
        selBgArgb: w[4] >>> 0,
        selFgArgb: w[5] >>> 0,
        accentArgb: w[6] >>> 0,
        bg: argbToCss(w[0]),
        fg: argbToCss(w[1]),
        cursorBgAbgr: argbToAbgr(w[2]),
        cursorFgAbgr: argbToAbgr(w[3]),
        selBgAbgr: argbToAbgr(w[4]),
        selFgAbgr: argbToAbgr(w[5]),
        accentAbgr: argbToAbgr(w[6]),
        isDark: w[7] === 1,
      });
    }
    return out;
  }

  function findThemeIdx(slug) {
    const bytes = enc.encode(slug);
    new Uint8Array(exp.memory.buffer, inPtr, bytes.byteLength).set(bytes);
    const idx = exp.ay_term_theme_find(inPtr, bytes.byteLength);
    return idx >= 0 ? idx : 0;
  }

  function createPane(cols = 120, rows = 34, themeSlug = "aphrody-m3-dark") {
    const statePtr = allocState();
    const themeIdx = findThemeIdx(themeSlug);
    exp.ay_vterm_init(statePtr, cols, rows, themeIdx);

    return {
      feed(bytesOrText) {
        const u8 =
          typeof bytesOrText === "string"
            ? enc.encode(bytesOrText)
            : bytesOrText;
        for (let off = 0; off < u8.byteLength; off += 16000) {
          const slice = u8.subarray(off, Math.min(u8.byteLength, off + 16000));
          new Uint8Array(exp.memory.buffer, inPtr, slice.byteLength).set(slice);
          exp.ay_vterm_feed(statePtr, inPtr, slice.byteLength);
        }
      },
      resize(c, r) {
        exp.ay_vterm_resize(statePtr, c, r);
      },
      setTheme(slug) {
        const idx = findThemeIdx(slug);
        exp.ay_vterm_set_theme(statePtr, idx);
        return idx;
      },
      resetDirty() {
        exp.ay_vterm_reset_dirty(statePtr);
      },
      meta() {
        exp.ay_vterm_get_meta(statePtr, metaPtr);
        const dv = new DataView(exp.memory.buffer, metaPtr, 468);
        const titleLen = dv.getUint32(56, true);
        const title = dec.decode(
          new Uint8Array(exp.memory.buffer, metaPtr + 60, titleLen),
        );
        const cwdLen = Math.min(dv.getUint32(208, true), 255);
        const cwd = dec.decode(
          new Uint8Array(exp.memory.buffer, metaPtr + 212, cwdLen),
        );
        return {
          abiVersion: dv.getUint32(0, true),
          cols: dv.getUint16(4, true),
          rows: dv.getUint16(6, true),
          cursorX: dv.getUint16(8, true),
          cursorY: dv.getUint16(10, true),
          cursorVisible: dv.getUint8(12) !== 0,
          cursorStyle: dv.getUint8(13),
          altScreen: dv.getUint8(14) !== 0,
          bracketedPaste: dv.getUint8(15) !== 0,
          appCursor: dv.getUint8(16) !== 0,
          mouseMode: dv.getUint8(17),
          titleDirty: dv.getUint8(18) !== 0,
          mouseFormat: dv.getUint8(19),
          themeIdx: dv.getUint32(20, true),
          scrollCount: dv.getUint32(24, true),
          feedBytes: dv.getUint32(28, true),
          blockCount: dv.getUint32(32, true),
          failedCount: dv.getUint32(36, true),
          lastExitCode: dv.getInt32(40, true),
          dirtyMask:
            (dv.getUint32(44, true) |
              dv.getUint32(48, true) |
              dv.getUint32(52, true)) !==
            0,
          title,
          scrollbackLen: dv.getUint32(188, true),
          viewOffset: dv.getUint32(192, true),
          replyPending: dv.getUint32(196, true),
          kittyFlags: dv.getUint32(200, true),
          syncOutput: dv.getUint8(204) !== 0,
          focusEvents: dv.getUint8(205) !== 0,
          cwdDirty: dv.getUint8(206) !== 0,
          clipDirty: dv.getUint8(207) !== 0,
          cwd,
        };
      },
      blocks() {
        const m = this.meta();
        const out = [];
        const dv = new DataView(exp.memory.buffer, blockPtr, 152);
        for (let i = 0; i < m.blockCount; i++) {
          if (exp.ay_vterm_get_block(statePtr, i, blockPtr) !== 0) break;
          const exitCode = dv.getInt32(12, true);
          const stateIdx = dv.getUint32(16, true);
          const state = BLOCK_STATES[stateIdx] ?? "empty";
          const cmdLen = Math.min(dv.getUint32(20, true), 127);
          const command = dec.decode(
            new Uint8Array(exp.memory.buffer, blockPtr + 24, cmdLen),
          );
          out.push({
            id: dv.getUint32(0, true),
            startRow: dv.getUint16(4, true),
            cmdRow: dv.getUint16(6, true),
            outRow: dv.getUint16(8, true),
            endRow: dv.getUint16(10, true),
            exitCode,
            state,
            command,
            failed: state === "done" && exitCode !== 0,
          });
        }
        return out;
      },
      rowText(r) {
        const n = exp.ay_vterm_copy_row_text(statePtr, r >>> 0, textPtr, 4096);
        if (n <= 0) return "";
        return dec.decode(new Uint8Array(exp.memory.buffer, textPtr, n));
      },
      text() {
        const n = exp.ay_vterm_copy_text(statePtr, textPtr, 46000);
        if (n <= 0) return "";
        return dec.decode(new Uint8Array(exp.memory.buffer, textPtr, n));
      },
      scrollLines(delta) {
        return exp.ay_vterm_scroll_lines(statePtr, delta | 0);
      },
      setScroll(offset) {
        return exp.ay_vterm_set_scroll(statePtr, offset >>> 0);
      },
      drainReplies() {
        const n = exp.ay_vterm_drain_replies(statePtr, textPtr, 512);
        if (n <= 0) return new Uint8Array(0);
        return new Uint8Array(exp.memory.buffer, textPtr, n).slice();
      },
      getLink(slot) {
        if (!slot) return "";
        const n = exp.ay_vterm_get_link(statePtr, slot >>> 0, textPtr, 512);
        if (n <= 0) return "";
        return dec.decode(new Uint8Array(exp.memory.buffer, textPtr, n));
      },
      drainClipboard() {
        const n = exp.ay_vterm_drain_clipboard(statePtr, textPtr, 1024);
        if (n <= 0) return "";
        return dec.decode(new Uint8Array(exp.memory.buffer, textPtr, n));
      },
      dispose() {
        freeSlots.push(statePtr);
      },
      packGpuCells() {
        const count = exp.ay_vterm_pack_gpu_cells(statePtr, gpuPtr, maxCells);
        return new Uint32Array(
          exp.memory.buffer,
          gpuPtr,
          Math.max(0, count) * VTERM_GPU_STRIDE_U32,
        );
      },
    };
  }

  return {
    abiVersion: exp.ay_vterm_abi_version(),
    stateBytes,
    listThemes,
    createPane,
  };
}
