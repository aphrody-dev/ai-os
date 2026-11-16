// Aphrody AI-First WebGPU Terminal Host (aysys.wasm + Procedural WGSL SDF + Multi-Pane + AI-OS SSE)
import { loadVTermWasm, VTERM_GPU_STRIDE_U32 } from "./vterm-wasm.js";

const BASE_FONT_STACK =
  '"Google Sans Code", "Symbols Nerd Font Mono", "Material Symbols Rounded", Consolas, monospace';

const DEC_TO_RGBA = (abgr) =>
  `rgba(${abgr & 0xff}, ${(abgr >>> 8) & 0xff}, ${(abgr >>> 16) & 0xff}, 1)`;

const isProceduralGlyph = (cp) =>
  (cp >= 0x2500 && cp <= 0x259f) || (cp >= 0xe0b0 && cp <= 0xe0b3);

class GlyphAtlas {
  constructor(fontSizePx, dpr) {
    this.dpr = Math.max(1, dpr);
    this.fontSizeCss = fontSizePx;
    this.fontPx = Math.round(fontSizePx * this.dpr);
    this.atlasSize = 2048;
    this.canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(this.atlasSize, this.atlasSize)
        : Object.assign(document.createElement("canvas"), {
            width: this.atlasSize,
            height: this.atlasSize,
          });
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    this.entries = new Map();
    this.dirty = true;
    this.measure();
    this.reset();
  }

  measure() {
    this.ctx.font = `400 ${this.fontPx}px ${BASE_FONT_STACK}`;
    const m = this.ctx.measureText("MMMMMMMMMM");
    this.cellW = Math.max(8, Math.ceil(m.width / 10));
    this.cellH = Math.max(14, Math.ceil(this.fontPx * 1.32));
    this.baseline = Math.round(this.cellH * 0.78);
  }

  setFontSize(fontSizePx, dpr) {
    this.fontSizeCss = Math.max(11, Math.min(36, fontSizePx));
    this.dpr = Math.max(1, dpr);
    this.fontPx = Math.round(this.fontSizeCss * this.dpr);
    this.measure();
    this.reset();
  }

  reset() {
    this.ctx.clearRect(0, 0, this.atlasSize, this.atlasSize);
    this.entries.clear();
    this.cursorX = 2;
    this.cursorY = 2;
    this.rowH = this.cellH + 2;
    this.dirty = true;
    for (let cp = 33; cp <= 126; cp++) this.getGlyph(cp, 0);
  }

  getGlyph(cp, flags) {
    if (cp <= 32 || (flags & 512) !== 0 || isProceduralGlyph(cp)) return null;
    const bold = (flags & 1) !== 0 ? 1 : 0;
    const italic = (flags & 4) !== 0 ? 1 : 0;
    const wide = (flags & 256) !== 0 ? 1 : 0;
    const key = `${cp}:${bold}:${italic}:${wide}`;
    const hit = this.entries.get(key);
    if (hit) return hit;

    const gw = wide ? this.cellW * 2 : this.cellW;
    const gh = this.cellH;
    if (this.cursorX + gw + 2 >= this.atlasSize) {
      this.cursorX = 2;
      this.cursorY += this.rowH;
    }
    if (this.cursorY + gh + 2 >= this.atlasSize) {
      this.reset();
    }

    const x = this.cursorX;
    const y = this.cursorY;
    this.cursorX += gw + 2;

    const ch = String.fromCodePoint(cp);
    this.ctx.save();
    this.ctx.font = `${italic ? "italic " : ""}${bold ? "700" : "400"} ${this.fontPx}px ${BASE_FONT_STACK}`;
    this.ctx.fillStyle = "#FFFFFF";
    this.ctx.textBaseline = "alphabetic";
    this.ctx.textAlign = "left";
    this.ctx.clearRect(x, y, gw, gh);
    this.ctx.fillText(ch, x, y + this.baseline, gw + 2);
    this.ctx.restore();

    const uv = [
      x / this.atlasSize,
      y / this.atlasSize,
      gw / this.atlasSize,
      gh / this.atlasSize,
    ];
    const rec = { uv, x, y, gw, gh, ch };
    this.entries.set(key, rec);
    this.dirty = true;
    return rec;
  }
}

class WebGpuRenderer {
  constructor(canvas, shaderCode, atlas) {
    this.canvas = canvas;
    this.shaderCode = shaderCode;
    this.atlas = atlas;
    this.ready = false;
    this.adapterInfo = null;
    this.paneSlots = new Map();
  }

  async init() {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) return false;
    this.adapterInfo = adapter.info
      ? {
          vendor: adapter.info.vendor || "",
          architecture: adapter.info.architecture || "",
          device: adapter.info.device || "",
        }
      : null;
    this.device = await adapter.requestDevice();
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx = this.canvas.getContext("webgpu");
    this.ctx.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });

    const module = this.device.createShaderModule({ code: this.shaderCode });
    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.maxCells = 240 * 80;
    this.atlasTex = this.device.createTexture({
      size: [this.atlas.atlasSize, this.atlas.atlasSize, 1],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.sampler = this.device.createSampler({
      magFilter: "nearest",
      minFilter: "linear",
    });
    this.ready = true;
    return true;
  }

  getSlot(paneId) {
    let slot = this.paneSlots.get(paneId);
    if (slot) return slot;
    const uniformBuf = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const cellBuf = this.device.createBuffer({
      size: this.maxCells * 20,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const glyphBuf = this.device.createBuffer({
      size: this.maxCells * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: cellBuf } },
        { binding: 2, resource: { buffer: glyphBuf } },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: this.atlasTex.createView() },
      ],
    });
    slot = {
      uniformBuf,
      cellBuf,
      glyphBuf,
      bindGroup,
      glyphHostScratch: new Float32Array(this.maxCells * 4),
      uniformHostScratch: new ArrayBuffer(96),
    };
    this.paneSlots.set(paneId, slot);
    return slot;
  }

  dropSlot(paneId) {
    const slot = this.paneSlots.get(paneId);
    if (!slot) return;
    slot.uniformBuf.destroy();
    slot.cellBuf.destroy();
    slot.glyphBuf.destroy();
    this.paneSlots.delete(paneId);
  }

  renderPanes(entries, activeBgArgb) {
    if (!this.ready || !entries.length) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw < 4 || ch < 4) return;

    const prepared = [];
    for (const ent of entries) {
      const count = ent.packedCells.length / VTERM_GPU_STRIDE_U32;
      if (count === 0) continue;
      const vx = Math.max(0, Math.min(cw - 1, Math.floor(ent.rectPx.x)));
      const vy = Math.max(0, Math.min(ch - 1, Math.floor(ent.rectPx.y)));
      const vw = Math.max(1, Math.min(cw - vx, Math.floor(ent.rectPx.w)));
      const vh = Math.max(1, Math.min(ch - vy, Math.floor(ent.rectPx.h)));
      if (vw < 4 || vh < 4) continue;

      const slot = this.getSlot(ent.paneId);
      const gOut = slot.glyphHostScratch;
      const pc = ent.packedCells;
      for (let i = 0; i < count; i++) {
        const base = i * VTERM_GPU_STRIDE_U32;
        const cp = pc[base];
        const flags = pc[base + 3];
        const rec = this.atlas.getGlyph(cp, flags);
        const o = i * 4;
        if (rec) {
          gOut[o] = rec.uv[0];
          gOut[o + 1] = rec.uv[1];
          gOut[o + 2] = rec.uv[2];
          gOut[o + 3] = rec.uv[3];
        } else {
          gOut[o] = 0;
          gOut[o + 1] = 0;
          gOut[o + 2] = 0;
          gOut[o + 3] = 0;
        }
      }

      const dv = new DataView(slot.uniformHostScratch);
      const cursorVis =
        ent.meta.cursorVisible && ent.meta.viewOffset === 0
          ? ent.meta.cursorStyle
          : 0;
      dv.setFloat32(0, vw, true);
      dv.setFloat32(4, vh, true);
      dv.setFloat32(8, this.atlas.cellW, true);
      dv.setFloat32(12, this.atlas.cellH, true);
      dv.setFloat32(16, this.atlas.atlasSize, true);
      dv.setFloat32(20, this.atlas.atlasSize, true);
      dv.setUint32(24, ent.meta.cols, true);
      dv.setUint32(28, ent.meta.rows, true);
      dv.setUint32(32, ent.meta.cursorX, true);
      dv.setUint32(36, ent.meta.cursorY, true);
      dv.setUint32(40, cursorVis, true);
      dv.setUint32(44, ent.blinkOn ? 1 : 0, true);
      dv.setInt32(48, ent.selStart, true);
      dv.setInt32(52, ent.selEnd, true);
      dv.setUint32(56, ent.theme.selBgAbgr, true);
      dv.setUint32(60, ent.theme.selFgAbgr, true);
      dv.setUint32(64, ent.theme.cursorBgAbgr, true);
      dv.setUint32(68, ent.theme.cursorFgAbgr, true);
      dv.setUint32(72, ent.theme.accentAbgr, true);
      dv.setUint32(76, 0xff5555ff, true);
      dv.setFloat32(80, ent.timeSec, true);
      dv.setUint32(84, ent.hoverLinkSlot >>> 0, true);
      dv.setUint32(88, ent.focused ? 1 : 0, true);
      dv.setUint32(92, 0, true);

      this.device.queue.writeBuffer(
        slot.uniformBuf,
        0,
        slot.uniformHostScratch,
      );
      this.device.queue.writeBuffer(
        slot.cellBuf,
        0,
        pc.buffer,
        pc.byteOffset,
        pc.byteLength,
      );
      this.device.queue.writeBuffer(
        slot.glyphBuf,
        0,
        gOut.buffer,
        gOut.byteOffset,
        count * 16,
      );

      prepared.push({ slot, count, vx, vy, vw, vh });
    }

    if (this.atlas.dirty) {
      this.device.queue.copyExternalImageToTexture(
        { source: this.atlas.canvas },
        { texture: this.atlasTex },
        [this.atlas.atlasSize, this.atlas.atlasSize],
      );
      this.atlas.dirty = false;
    }

    if (!prepared.length) return;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          clearValue: {
            r: ((activeBgArgb >>> 16) & 0xff) / 255,
            g: ((activeBgArgb >>> 8) & 0xff) / 255,
            b: (activeBgArgb & 0xff) / 255,
            a: 1,
          },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    for (const item of prepared) {
      pass.setViewport(item.vx, item.vy, item.vw, item.vh, 0, 1);
      pass.setScissorRect(item.vx, item.vy, item.vw, item.vh);
      pass.setBindGroup(0, item.slot.bindGroup);
      pass.draw(6, item.count, 0, 0);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}

class Canvas2dRenderer {
  constructor(canvas, atlas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.atlas = atlas;
  }

  renderPanes(entries, activeBgArgb) {
    const ctx = this.ctx;
    ctx.fillStyle = `rgb(${(activeBgArgb >>> 16) & 0xff}, ${(activeBgArgb >>> 8) & 0xff}, ${activeBgArgb & 0xff})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const cw = this.atlas.cellW;
    const ch = this.atlas.cellH;
    for (const ent of entries) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ent.rectPx.x, ent.rectPx.y, ent.rectPx.w, ent.rectPx.h);
      ctx.clip();
      ctx.translate(ent.rectPx.x, ent.rectPx.y);

      const lo = Math.min(ent.selStart, ent.selEnd);
      const hi = Math.max(ent.selStart, ent.selEnd);
      const n = ent.packedCells.length / VTERM_GPU_STRIDE_U32;
      for (let i = 0; i < n; i++) {
        const base = i * VTERM_GPU_STRIDE_U32;
        const cp = ent.packedCells[base];
        const fg = ent.packedCells[base + 1];
        const bg = ent.packedCells[base + 2];
        const flags = ent.packedCells[base + 3];
        const pos = ent.packedCells[base + 4];
        const col = pos & 0xffff;
        const row = pos >>> 16;
        const x = col * cw;
        const y = row * ch;
        const sel = ent.selStart >= 0 && ent.selEnd >= 0 && i >= lo && i <= hi;

        ctx.fillStyle = DEC_TO_RGBA(sel ? ent.theme.selBgAbgr : bg);
        ctx.fillRect(x, y, cw, ch);
        if ((flags & 4096) !== 0 && col === 0) {
          ctx.fillStyle = "#ff5e7e";
          ctx.fillRect(x, y, 3, ch);
        }
        if (cp > 32 && (flags & 512) === 0) {
          const bold = (flags & 1) !== 0 ? "700 " : "400 ";
          const italic = (flags & 4) !== 0 ? "italic " : "";
          ctx.font = `${italic}${bold}${this.atlas.fontPx}px ${BASE_FONT_STACK}`;
          ctx.fillStyle = DEC_TO_RGBA(sel ? ent.theme.selFgAbgr : fg);
          ctx.textBaseline = "alphabetic";
          ctx.fillText(String.fromCodePoint(cp), x, y + this.atlas.baseline);
        }
      }
      if (ent.meta.cursorVisible && ent.meta.viewOffset === 0 && ent.blinkOn) {
        const cx = ent.meta.cursorX * cw;
        const cy = ent.meta.cursorY * ch;
        ctx.fillStyle = DEC_TO_RGBA(ent.theme.cursorBgAbgr);
        ctx.fillRect(cx, cy, Math.max(2, cw * 0.14), ch);
      }
      ctx.restore();
    }
  }
}

function encodeKeyEvent(ev, meta) {
  const mod =
    1 +
    (ev.shiftKey ? 1 : 0) +
    (ev.altKey ? 2 : 0) +
    (ev.ctrlKey ? 4 : 0) +
    (ev.metaKey ? 8 : 0);

  if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.length === 1) {
    const code = ev.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      if (meta.kittyFlags > 0 && ev.key >= "a" && ev.key <= "z") {
        return `\x1b[${ev.key.charCodeAt(0)};${mod}u`;
      }
      return String.fromCharCode(code - 64);
    }
  }

  const csi = meta.appCursor && mod === 1 ? "\x1bO" : "\x1b[";
  const modSuffix = mod > 1 ? `;${mod}` : "";
  switch (ev.key) {
    case "Enter":
      return meta.kittyFlags > 0 && mod > 1 ? `\x1b[13;${mod}u` : "\r";
    case "Backspace":
      return meta.kittyFlags > 0 && mod > 1 ? `\x1b[127;${mod}u` : "\x7f";
    case "Tab":
      return ev.shiftKey && mod === 2
        ? "\x1b[Z"
        : mod > 1
          ? `\x1b[9;${mod}u`
          : "\t";
    case "Escape":
      return meta.kittyFlags > 0 ? `\x1b[27${modSuffix}u` : "\x1b";
    case "ArrowUp":
      return mod > 1 ? `\x1b[1;${mod}A` : `${csi}A`;
    case "ArrowDown":
      return mod > 1 ? `\x1b[1;${mod}B` : `${csi}B`;
    case "ArrowRight":
      return mod > 1 ? `\x1b[1;${mod}C` : `${csi}C`;
    case "ArrowLeft":
      return mod > 1 ? `\x1b[1;${mod}D` : `${csi}D`;
    case "Home":
      return mod > 1 ? `\x1b[1;${mod}H` : `${csi}H`;
    case "End":
      return mod > 1 ? `\x1b[1;${mod}F` : `${csi}F`;
    case "Insert":
      return `\x1b[2${modSuffix}~`;
    case "Delete":
      return `\x1b[3${modSuffix}~`;
    case "PageUp":
      return `\x1b[5${modSuffix}~`;
    case "PageDown":
      return `\x1b[6${modSuffix}~`;
    case "F1":
      return mod > 1 ? `\x1b[1;${mod}P` : "\x1bOP";
    case "F2":
      return mod > 1 ? `\x1b[1;${mod}Q` : "\x1bOQ";
    case "F3":
      return mod > 1 ? `\x1b[1;${mod}R` : "\x1bOR";
    case "F4":
      return mod > 1 ? `\x1b[1;${mod}S` : "\x1bOS";
    case "F5":
      return `\x1b[15${modSuffix}~`;
    case "F6":
      return `\x1b[17${modSuffix}~`;
    case "F7":
      return `\x1b[18${modSuffix}~`;
    case "F8":
      return `\x1b[19${modSuffix}~`;
    case "F9":
      return `\x1b[20${modSuffix}~`;
    case "F10":
      return `\x1b[21${modSuffix}~`;
    case "F11":
      return `\x1b[23${modSuffix}~`;
    case "F12":
      return `\x1b[24${modSuffix}~`;
    default:
      if (ev.altKey && !ev.ctrlKey && ev.key.length === 1) {
        return `\x1b${ev.key}`;
      }
      return null;
  }
}

class OfflineSandboxShell {
  constructor(pane, themes, openAsk) {
    this.pane = pane;
    this.themes = themes;
    this.openAsk = openAsk;
    this.line = "";
    this.vterm = pane.vterm;
    this.write(
      "\x1b]133;A\x07\x1b[1;38;2;139;206;255maphrody-wasm32\x1b[0m \x1b[38;2;148;226;213m~/src\x1b[0m \x1b]133;B\x07",
    );
  }
  prompt(exitCode = 0) {
    this.write(
      `\x1b]133;D;${exitCode}\x07\r\n\x1b]133;A\x07\x1b[1;38;2;139;206;255maphrody-wasm32\x1b[0m \x1b[38;2;148;226;213m~/src\x1b[0m \x1b]133;B\x07`,
    );
  }
  write(s) {
    this.vterm.feed(s);
    this.pane.dirty = true;
  }
  send(data) {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const cmd = this.line.trim();
        this.line = "";
        this.write("\r\n\x1b]133;C\x07");
        const rc = this.exec(cmd);
        this.prompt(rc);
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.write("\b \b");
        }
      } else if (ch >= " ") {
        this.line += ch;
        this.write(ch);
      }
    }
  }
  exec(cmd) {
    if (!cmd) return 0;
    if (cmd === "help") {
      this.write(
        "Aphrody WebGPU + aysys.wasm standalone shell\r\nCommands: help | themes | protocols | errordemo | boxdemo | clear",
      );
      return 0;
    }
    if (cmd === "clear") {
      this.write("\x1b[2J\x1b[H");
      return 0;
    }
    if (cmd === "themes") {
      this.write(this.themes.map((t) => `${t.slug} (${t.name})`).join("  "));
      return 0;
    }
    if (cmd === "protocols") {
      this.write("OpenRouter SSE | ACP | MCP | A2A | WebMCP | OpenCode TUI");
      return 0;
    }
    if (cmd === "boxdemo") {
      this.write(
        "\x1b[38;2;139;206;255m╭────────────────────────────╮\r\n│ \x1b[4:3mWebGPU SDF\x1b[0m  ▇▅▃▂  \x1b[38;2;148;226;213m▒░\x1b[0m │\r\n╰────────────────────────────╯",
      );
      return 0;
    }
    if (cmd === "errordemo") {
      this.write(
        "\x1b[38;2;255;94;126merror[E0425]\x1b[0m: simulated build failure (exit 101) - click 'Ask AI' or press Ctrl+Alt+.",
      );
      return 101;
    }
    this.write(
      `wasmsh: command queued (${cmd}) — attach local 'ai-os term' daemon for live ConPTY.`,
    );
    return 0;
  }
}

async function boot() {
  const qParams = new URLSearchParams(location.search);
  const daemonBase = (qParams.get("daemon") ?? "").replace(/\/+$/, "");
  const wasmUrl = new URL("./aysys.wasm", import.meta.url).toString();
  const wgslUrl = new URL("./term.wgsl", import.meta.url).toString();

  const [vtRuntime, shaderCode, infoRes] = await Promise.all([
    loadVTermWasm(wasmUrl),
    fetch(wgslUrl).then((r) => r.text()),
    fetch(`${daemonBase}/api/info`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    document.fonts.load('400 20px "Google Sans Code"').catch(() => []),
  ]);

  const themes = vtRuntime.listThemes();
  const info = infoRes
    ? { ...infoRes, daemonConnected: true }
    : {
        daemonConnected: false,
        profiles: [],
        themes,
        ai: { engines: [], models: [], openrouterModels: [] },
        panes: [],
      };

  const canvas = document.getElementById("term-canvas");
  const splitStage = document.getElementById("split-stage");
  const inputSink = document.getElementById("term-input");
  const tabsEl = document.getElementById("pane-tabs");
  const backendBadge = document.getElementById("gpu-badge");
  const sbPill = document.getElementById("sb-pill");
  const errorPill = document.getElementById("error-pill");
  const linkTooltip = document.getElementById("link-tooltip");
  const themeSelect = document.getElementById("theme-select");
  const engineSelect = document.getElementById("ai-engine");
  const modelSelect = document.getElementById("ai-model");
  const aiPanel = document.getElementById("ai-panel");
  const aiFeed = document.getElementById("ai-feed");
  const aiPrompt = document.getElementById("ai-prompt");
  const aiSend = document.getElementById("ai-send");
  const inlineBar = document.getElementById("inline-ai-bar");
  const inlineInput = document.getElementById("inline-ai-input");
  const inlineRun = document.getElementById("inline-ai-run");
  const inlineClose = document.getElementById("inline-ai-close");
  const paletteDlg = document.getElementById("cmd-palette");
  const paletteInput = document.getElementById("palette-input");
  const paletteList = document.getElementById("palette-list");

  const atlas = new GlyphAtlas(20, window.devicePixelRatio || 1);
  const webgpu = new WebGpuRenderer(canvas, shaderCode, atlas);
  let hasWebGpu = false;
  try {
    hasWebGpu = await webgpu.init();
  } catch {
    hasWebGpu = false;
  }
  const c2d = hasWebGpu ? null : new Canvas2dRenderer(canvas, atlas);
  const hwLabel = webgpu.adapterInfo
    ? `${webgpu.adapterInfo.vendor || "GPU"}${webgpu.adapterInfo.architecture ? ` ${webgpu.adapterInfo.architecture}` : ""}`
    : "WebGPU";
  const updateGpuBadge = (fpsText = "") => {
    backendBadge.textContent = hasWebGpu
      ? `WebGPU · ${hwLabel} · ${atlas.fontSizeCss}px${fpsText}`
      : `Canvas2D · ${atlas.fontSizeCss}px`;
  };
  updateGpuBadge();

  for (const t of themes) {
    themeSelect.add(new Option(t.name, t.slug));
  }
  themeSelect.value = qParams.get("theme") || "aphrody-m3-dark";

  const populateCatalog = (ai) => {
    if (ai?.engines?.length) {
      const prev = engineSelect.value;
      engineSelect.innerHTML = "";
      engineSelect.add(new Option("Auto (OpenRouter / AI-OS)", "auto"));
      for (const e of ai.engines) {
        engineSelect.add(new Option(e.label, e.id));
      }
      if ([...engineSelect.options].some((o) => o.value === prev)) {
        engineSelect.value = prev;
      }
    }
    if (ai?.models?.length) {
      const prevM = modelSelect.value;
      modelSelect.innerHTML = `<option value="">Auto model</option>`;
      for (const m of ai.models) modelSelect.add(new Option(m, m));
      if ([...modelSelect.options].some((o) => o.value === prevM)) {
        modelSelect.value = prevM;
      }
    }
  };
  populateCatalog(info.ai);

  // Split tree + workspace state
  // Workspace = tab tree; activeWorkspaceIndex points into workspaces[].
  const panes = new Map();
  const workspaces = [];
  let activeWsIdx = 0;
  let activeId = null;
  let selPaneId = null;
  let selStart = -1;
  let selEnd = -1;
  let selecting = false;
  let mouseDownBtn = -1;
  let hoverPaneId = null;
  let hoverLinkSlot = 0;
  let hoverLinkUrl = "";
  let lastFailedSnapshot = null;

  const currentWorkspace = () => workspaces[activeWsIdx] ?? null;
  const activePane = () => (activeId ? panes.get(activeId) : null);

  function collectLeafIds(node, out = []) {
    if (!node) return out;
    if (node.kind === "leaf") out.push(node.paneId);
    else {
      collectLeafIds(node.a, out);
      collectLeafIds(node.b, out);
    }
    return out;
  }

  function replaceLeafWithSplit(node, targetId, newId, dir) {
    if (!node) return null;
    if (node.kind === "leaf") {
      if (node.paneId !== targetId) return node;
      return {
        kind: "split",
        dir,
        ratio: 0.5,
        a: node,
        b: { kind: "leaf", paneId: newId },
      };
    }
    return {
      ...node,
      a: replaceLeafWithSplit(node.a, targetId, newId, dir),
      b: replaceLeafWithSplit(node.b, targetId, newId, dir),
    };
  }

  function removeLeaf(node, targetId) {
    if (!node) return null;
    if (node.kind === "leaf") return node.paneId === targetId ? null : node;
    const nextA = removeLeaf(node.a, targetId);
    const nextB = removeLeaf(node.b, targetId);
    if (!nextA) return nextB;
    if (!nextB) return nextA;
    return { ...node, a: nextA, b: nextB };
  }

  function findWorkspaceContaining(paneId) {
    return workspaces.findIndex((ws) =>
      collectLeafIds(ws.root).includes(paneId),
    );
  }

  function applyThemeCss(slug) {
    const t = themes.find((x) => x.slug === slug) ?? themes[0];
    if (!t) return;
    document.documentElement.style.setProperty("--term-bg", t.bg);
    document.documentElement.style.setProperty("--term-fg", t.fg);
    for (const p of panes.values()) {
      p.vterm.setTheme(slug);
      p.themeSlug = slug;
      p.dirty = true;
    }
    if (activePane()?.ws?.readyState === 1) {
      activePane().ws.send(JSON.stringify({ type: "theme", slug }));
    }
  }

  function shortTitle(rawTitle, fallback) {
    const raw = String(rawTitle || fallback || "shell").trim();
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : raw;
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    workspaces.forEach((ws, idx) => {
      const ids = collectLeafIds(ws.root);
      const primary = panes.get(ids.includes(activeId) ? activeId : ids[0]);
      if (!primary) return;
      const fullTitle = primary.title || primary.label;
      const base = shortTitle(primary.title, primary.label);
      const wrap = document.createElement("div");
      wrap.className = `tab-wrap${idx === activeWsIdx ? " active" : ""}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = fullTitle;
      btn.textContent = ids.length > 1 ? `${base} [${ids.length}]` : base;
      btn.onclick = () => {
        activeWsIdx = idx;
        switchPane(ids[0]);
        renderLayout();
      };
      const cls = document.createElement("button");
      cls.type = "button";
      cls.className = "tab-close";
      cls.textContent = "×";
      cls.title = "Close tab";
      cls.onclick = (e) => {
        e.stopPropagation();
        for (const id of ids) closePane(id);
      };
      wrap.append(btn, cls);
      tabsEl.appendChild(wrap);
    });
  }

  function syncCanvasSize() {
    const stageRect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const physW = Math.max(320, Math.floor(stageRect.width * dpr));
    const physH = Math.max(200, Math.floor(stageRect.height * dpr));
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width = physW;
      canvas.height = physH;
    }
    return { stageRect, dpr };
  }

  function measureAllVisiblePaneRects() {
    const { stageRect, dpr } = syncCanvasSize();
    const rects = new Map();
    for (const bodyEl of splitStage.querySelectorAll(".pane-body")) {
      const pid = bodyEl.dataset.paneId;
      const r = bodyEl.getBoundingClientRect();
      const x = Math.max(0, Math.floor((r.left - stageRect.left) * dpr));
      const y = Math.max(0, Math.floor((r.top - stageRect.top) * dpr));
      const w = Math.max(16, Math.floor(r.width * dpr));
      const h = Math.max(16, Math.floor(r.height * dpr));
      const cols = Math.max(12, Math.min(240, Math.floor(w / atlas.cellW)));
      const rows = Math.max(4, Math.min(80, Math.floor(h / atlas.cellH)));
      rects.set(pid, { x, y, w, h, cols, rows, cssRect: r });
    }
    return rects;
  }

  function resizeVisiblePanes() {
    const rects = measureAllVisiblePaneRects();
    for (const [pid, rect] of rects.entries()) {
      const p = panes.get(pid);
      if (!p) continue;
      const m = p.vterm.meta();
      if (m.cols !== rect.cols || m.rows !== rect.rows) {
        p.vterm.resize(rect.cols, rect.rows);
        p.dirty = true;
        if (p.ws?.readyState === 1) {
          p.ws.send(
            JSON.stringify({
              type: "resize",
              cols: rect.cols,
              rows: rect.rows,
            }),
          );
        }
      }
    }
  }

  function buildSplitDom(node) {
    if (!node) return document.createElement("div");
    if (node.kind === "leaf") {
      const p = panes.get(node.paneId);
      const leaf = document.createElement("div");
      leaf.className = `pane-leaf${node.paneId === activeId ? " focused" : ""}`;
      leaf.dataset.paneId = node.paneId;

      const head = document.createElement("div");
      head.className = "pane-head";
      const titleSpan = document.createElement("span");
      titleSpan.className = "pane-head-title";
      const fullTitle = p?.title || p?.label || node.paneId;
      const cwd = p?.cwdShort ? ` · ${p.cwdShort}` : "";
      titleSpan.title = `${fullTitle}${cwd}`;
      titleSpan.textContent = `${shortTitle(p?.title, p?.label || node.paneId)}${cwd}`;
      const acts = document.createElement("div");
      acts.className = "pane-head-actions";
      const bSh = document.createElement("button");
      bSh.type = "button";
      bSh.textContent = "Split H";
      bSh.onclick = (e) => {
        e.stopPropagation();
        switchPane(node.paneId);
        splitActivePane("h");
      };
      const bSv = document.createElement("button");
      bSv.type = "button";
      bSv.textContent = "Split V";
      bSv.onclick = (e) => {
        e.stopPropagation();
        switchPane(node.paneId);
        splitActivePane("v");
      };
      const bClose = document.createElement("button");
      bClose.type = "button";
      bClose.textContent = "×";
      bClose.title = "Close pane";
      bClose.onclick = (e) => {
        e.stopPropagation();
        closePane(node.paneId);
      };
      acts.append(bSh, bSv, bClose);
      head.append(titleSpan, acts);
      head.onmousedown = () => switchPane(node.paneId);

      const body = document.createElement("div");
      body.className = "pane-body";
      body.dataset.paneId = node.paneId;

      const track = document.createElement("div");
      track.className = "pane-scroll-track";
      const thumb = document.createElement("div");
      thumb.className = "pane-scroll-thumb";
      track.appendChild(thumb);
      body.appendChild(track);

      leaf.append(head, body);
      return leaf;
    }

    const branch = document.createElement("div");
    branch.className = `split-branch dir-${node.dir}`;
    const childA = buildSplitDom(node.a);
    const childB = buildSplitDom(node.b);
    childA.style.flex = `${node.ratio} 1 0`;
    childB.style.flex = `${1 - node.ratio} 1 0`;

    const div = document.createElement("div");
    div.className = "split-divider";
    div.onmousedown = (e) => {
      e.preventDefault();
      const box = branch.getBoundingClientRect();
      const onMove = (me) => {
        const nextRatio =
          node.dir === "h"
            ? (me.clientX - box.left) / Math.max(1, box.width)
            : (me.clientY - box.top) / Math.max(1, box.height);
        node.ratio = Math.max(0.18, Math.min(0.82, nextRatio));
        childA.style.flex = `${node.ratio} 1 0`;
        childB.style.flex = `${1 - node.ratio} 1 0`;
        resizeVisiblePanes();
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

    branch.append(childA, div, childB);
    return branch;
  }

  function renderLayout() {
    splitStage.innerHTML = "";
    const ws = currentWorkspace();
    if (ws?.root) {
      splitStage.appendChild(buildSplitDom(ws.root));
      resizeVisiblePanes();
    }
    renderTabs();
    updateScrollHud();
  }

  function updateScrollHud() {
    const p = activePane();
    if (!p) {
      sbPill.hidden = true;
      return;
    }
    const m = p.vterm.meta();
    if (m.viewOffset > 0 && !m.altScreen) {
      sbPill.hidden = false;
      sbPill.textContent = `History +${m.viewOffset}/${m.scrollbackLen} · Jump Bottom`;
    } else {
      sbPill.hidden = true;
    }
    for (const leaf of splitStage.querySelectorAll(".pane-leaf")) {
      const pid = leaf.dataset.paneId;
      const pane = panes.get(pid);
      const track = leaf.querySelector(".pane-scroll-track");
      const thumb = leaf.querySelector(".pane-scroll-thumb");
      if (!pane || !track || !thumb) continue;
      const pm = pane.vterm.meta();
      if (pm.scrollbackLen > 0 && !pm.altScreen) {
        track.classList.add("visible");
        const total = pm.scrollbackLen + pm.rows;
        const pctH = Math.max(0.08, pm.rows / total);
        const topFrac =
          pm.scrollbackLen > 0 ? (pm.scrollbackLen - pm.viewOffset) / total : 0;
        thumb.style.height = `${Math.round(pctH * 100)}%`;
        thumb.style.top = `${Math.round(topFrac * 100)}%`;
      } else {
        track.classList.remove("visible");
      }
      const headTitle = leaf.querySelector(".pane-head-title");
      if (headTitle) {
        const cwd = pm.cwd ? ` · ${pm.cwd.replace(/^file:\/\/[^/]*/, "")}` : "";
        headTitle.title = `${pane.title || pane.label}${cwd}`;
        headTitle.textContent = `${shortTitle(pane.title, pane.label)}${cwd}`;
      }
    }
  }

  function switchPane(id) {
    if (!panes.has(id)) return;
    activeId = id;
    const wsIdx = findWorkspaceContaining(id);
    if (wsIdx >= 0) activeWsIdx = wsIdx;
    for (const leaf of splitStage.querySelectorAll(".pane-leaf")) {
      leaf.classList.toggle("focused", leaf.dataset.paneId === id);
    }
    const p = panes.get(id);
    if (p) p.dirty = true;
    renderTabs();
    updateScrollHud();
    inputSink.focus();
  }

  function showErrorPill(command, exitCode, outputTail) {
    lastFailedSnapshot = { command, exitCode, outputTail };
    errorPill.hidden = false;
    errorPill.textContent = `Exit ${exitCode}${command ? ` · ${command.slice(0, 36)}` : ""} — Diagnose AI (Ctrl+Alt+.)`;
  }

  async function createPaneRecord(profileId) {
    const rects = measureAllVisiblePaneRects();
    const curRect = activeId ? rects.get(activeId) : null;
    const cols = curRect?.cols ?? 120;
    const rows = curRect?.rows ?? 36;
    const themeSlug = themeSelect.value || "aphrody-m3-dark";

    if (!info.daemonConnected) {
      const id = `sandbox-${Date.now().toString(36)}-${panes.size + 1}`;
      const vt = vtRuntime.createPane(cols, rows, themeSlug);
      const pane = {
        id,
        label: "wasmsh (local WASM)",
        title: "wasmsh",
        themeSlug,
        vterm: vt,
        dirty: true,
        lastCells: null,
        lastCols: cols,
        syncHoldSince: 0,
        sandbox: null,
        write(data) {
          this.sandbox.send(data);
        },
      };
      pane.sandbox = new OfflineSandboxShell(pane, themes, () => askAi(true));
      panes.set(id, pane);
      return pane;
    }

    const resp = await fetch(`${daemonBase}/api/panes`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: profileId,
        cols,
        rows,
        theme: themeSlug,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const summary = await resp.json();
    return attachPaneRecord(summary);
  }

  function attachPaneRecord(summary) {
    const vt = vtRuntime.createPane(
      summary.cols,
      summary.rows,
      summary.themeSlug || themeSelect.value,
    );
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = daemonBase ? new URL(daemonBase).host : location.host;
    const ws = new WebSocket(`${wsProto}//${wsHost}/ws/pty/${summary.id}`);
    ws.binaryType = "arraybuffer";

    const pane = {
      id: summary.id,
      label: summary.label,
      title: summary.title,
      themeSlug: summary.themeSlug,
      vterm: vt,
      ws,
      dirty: true,
      lastCells: null,
      lastCols: summary.cols,
      syncHoldSince: 0,
      lastFailedCount: 0,
      write(data) {
        if (ws.readyState === 1) ws.send(data);
      },
    };

    ws.onopen = () => {
      const rects = measureAllVisiblePaneRects();
      const r = rects.get(pane.id);
      if (r) {
        pane.vterm.resize(r.cols, r.rows);
        ws.send(JSON.stringify({ type: "resize", cols: r.cols, rows: r.rows }));
      }
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        pane.vterm.feed(new Uint8Array(ev.data));
        // Mirror any locally triggered responses in browser? PTY daemon already replies directly!
        pane.dirty = true;
        const m = pane.vterm.meta();
        if (m.syncOutput) {
          if (!pane.syncHoldSince) pane.syncHoldSince = performance.now();
        } else {
          pane.syncHoldSince = 0;
        }
        if (m.titleDirty && m.title) {
          pane.title = m.title;
          renderTabs();
        }
        if (m.failedCount > pane.lastFailedCount) {
          pane.lastFailedCount = m.failedCount;
          const b = [...pane.vterm.blocks()].reverse().find((x) => x.failed);
          if (b) showErrorPill(b.command, b.exitCode, "");
        }
        if (pane.id === activeId) updateScrollHud();
      } else {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "block_error" && msg.block) {
            showErrorPill(
              msg.block.command,
              msg.block.exitCode,
              msg.outputTail,
            );
          } else if (msg.type === "clipboard" && msg.text) {
            navigator.clipboard?.writeText(msg.text).catch(() => {});
          } else if (msg.type === "exit") {
            pane.title = `${pane.label} (exit ${msg.exitCode ?? 0})`;
            renderTabs();
          }
        } catch {}
      }
    };

    panes.set(pane.id, pane);
    return pane;
  }

  async function spawnNewTab(profileId) {
    const pane = await createPaneRecord(profileId);
    workspaces.push({ root: { kind: "leaf", paneId: pane.id } });
    activeWsIdx = workspaces.length - 1;
    activeId = pane.id;
    renderLayout();
    inputSink.focus();
    return pane;
  }

  async function splitActivePane(dir = "h", profileId) {
    const ws = currentWorkspace();
    if (!ws || !activeId) return spawnNewTab(profileId || profiles[0].id);
    const pane = await createPaneRecord(profileId || profiles[0].id);
    ws.root = replaceLeafWithSplit(ws.root, activeId, pane.id, dir);
    activeId = pane.id;
    renderLayout();
    inputSink.focus();
    return pane;
  }

  async function closePane(id) {
    const p = panes.get(id);
    if (!p) return;
    panes.delete(id);
    try {
      p.ws?.close();
    } catch {}
    p.vterm.dispose?.();
    if (hasWebGpu) webgpu.dropSlot(id);
    if (info.daemonConnected) {
      void fetch(`${daemonBase}/api/panes/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      }).catch(() => {});
    }
    const wsIdx = findWorkspaceContaining(id);
    if (wsIdx >= 0) {
      const nextRoot = removeLeaf(workspaces[wsIdx].root, id);
      if (nextRoot) {
        workspaces[wsIdx].root = nextRoot;
        if (activeId === id) {
          activeId = collectLeafIds(nextRoot)[0] ?? null;
        }
      } else {
        workspaces.splice(wsIdx, 1);
        activeWsIdx = Math.max(0, Math.min(activeWsIdx, workspaces.length - 1));
        const rem = currentWorkspace();
        activeId = rem ? (collectLeafIds(rem.root)[0] ?? null) : null;
      }
    }
    if (workspaces.length === 0) {
      await spawnNewTab(profiles[0].id);
      return;
    }
    renderLayout();
  }

  function extractCommandsClient(md) {
    const cmds = [];
    const seen = new Set();
    const re =
      /```(?:sh|bash|zsh|pwsh|powershell|cmd|shell)?\r?\n([\s\S]*?)```/gi;
    for (const m of md.matchAll(re)) {
      for (const l of (m[1] || "").split(/\r?\n/)) {
        const c = l.trim();
        if (c && !c.startsWith("#") && !seen.has(c)) {
          seen.add(c);
          cmds.push(c);
        }
      }
    }
    return cmds.slice(0, 8);
  }

  async function streamAiRequest(promptText, onMeta, onDelta, onDone) {
    const r = await fetch(`${daemonBase}/api/ai/stream`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        engine: engineSelect.value,
        model: modelSelect.value || undefined,
        prompt: promptText,
        paneId: activeId,
        includeScreen: true,
        includeFailedBlock: true,
      }),
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let evName = "message";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const blk of blocks) {
        let dataStr = "";
        evName = "message";
        for (const line of blk.split("\n")) {
          if (line.startsWith("event:")) evName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        const payload = JSON.parse(dataStr);
        if (evName === "meta") onMeta(payload);
        else if (evName === "delta") onDelta(payload.text || "");
        else if (evName === "done") onDone(payload);
        else if (evName === "error")
          throw new Error(payload.error || "Stream error");
      }
    }
  }

  async function askAi(autoError = false) {
    aiPanel.classList.add("open");
    const promptText = autoError
      ? `Diagnose the latest failing command${lastFailedSnapshot?.command ? ` (${lastFailedSnapshot.command}, exit ${lastFailedSnapshot.exitCode})` : ""} and give a concise fix.`
      : aiPrompt.value.trim();
    if (!promptText) {
      aiPrompt.focus();
      return;
    }
    if (!autoError) aiPrompt.value = "";

    const userCard = document.createElement("div");
    userCard.className = "ai-msg user";
    userCard.textContent = promptText;
    aiFeed.appendChild(userCard);

    const botCard = document.createElement("div");
    botCard.className = "ai-msg agent";
    const head = document.createElement("div");
    head.className = "ai-meta";
    head.textContent = `Streaming via ${engineSelect.value}...`;
    const body = document.createElement("pre");
    body.className = "ai-text";
    body.textContent = "";
    botCard.append(head, body);
    aiFeed.appendChild(botCard);
    aiFeed.scrollTop = aiFeed.scrollHeight;

    let accText = "";
    let finishedPayload = null;
    try {
      await streamAiRequest(
        promptText,
        (meta) => {
          head.textContent = `${meta.protocol}${meta.model ? ` · ${meta.model}` : ""} · streaming...`;
        },
        (delta) => {
          accText += delta;
          body.textContent = accText;
          aiFeed.scrollTop = aiFeed.scrollHeight;
        },
        (done) => {
          finishedPayload = done;
        },
      );
      const data = finishedPayload ?? {
        protocol: engineSelect.value,
        model: modelSelect.value,
        text: accText,
        ms: 0,
        commands: extractCommandsClient(accText),
      };
      head.textContent = `${data.protocol}${data.model ? ` · ${data.model}` : ""} · ${data.ms}ms`;
      body.textContent = data.text || accText;

      for (const cmd of data.commands || []) {
        const bar = document.createElement("div");
        bar.className = "ai-cmd-bar";
        const code = document.createElement("code");
        code.textContent = cmd;
        const ins = document.createElement("button");
        ins.type = "button";
        ins.textContent = "Insert";
        ins.onclick = () => {
          activePane()?.write(cmd);
          inputSink.focus();
        };
        const runBtn = document.createElement("button");
        runBtn.type = "button";
        runBtn.className = "primary";
        runBtn.textContent = "Run";
        runBtn.onclick = () => {
          activePane()?.write(`${cmd}\r`);
          inputSink.focus();
        };
        bar.append(code, ins, runBtn);
        botCard.appendChild(bar);
      }
      errorPill.hidden = true;
    } catch (e) {
      body.textContent = `Agent error: ${e.message ?? e}`;
    }
    aiFeed.scrollTop = aiFeed.scrollHeight;
  }

  async function runInlineAi() {
    const q = inlineInput.value.trim();
    if (!q) return;
    inlineRun.disabled = true;
    inlineRun.textContent = "...";
    let text = "";
    try {
      let cmds = [];
      await streamAiRequest(
        `Return ONLY a single runnable shell command in a \`\`\`sh block for this intent: ${q}`,
        () => {},
        (d) => {
          text += d;
        },
        (done) => {
          cmds = done.commands || extractCommandsClient(done.text || text);
        },
      );
      const cmd = cmds[0] || text.trim();
      if (cmd) {
        activePane()?.write(cmd);
      }
      inlineBar.classList.remove("open");
      inlineInput.value = "";
      inputSink.focus();
    } catch (e) {
      inlineInput.value = `Error: ${e.message ?? e}`;
    } finally {
      inlineRun.disabled = false;
      inlineRun.textContent = "Generate";
    }
  }

  const profileBar = document.getElementById("profile-bar");
  const profiles = info.profiles?.length
    ? info.profiles
    : [{ id: "wasmsh", label: "WASM Sandbox" }];
  for (const prof of profiles.slice(0, 5)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `+ ${prof.label}`;
    b.onclick = () => spawnNewTab(prof.id);
    profileBar.appendChild(b);
  }

  if (info.panes?.length) {
    for (const s of info.panes) {
      const p = attachPaneRecord(s);
      workspaces.push({ root: { kind: "leaf", paneId: p.id } });
    }
    activeWsIdx = 0;
    activeId = info.panes[0].id;
    renderLayout();
  } else {
    await spawnNewTab(profiles[0].id);
  }

  // Lazy-populate remote model catalog after first frame is already ready
  if (info.daemonConnected) {
    fetch(`${daemonBase}/api/ai/catalog`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((cat) => {
        if (cat) populateCatalog(cat);
      })
      .catch(() => {});
  }

  // Keyboard & AZERTY IME input
  inputSink.addEventListener("input", () => {
    const v = inputSink.value;
    if (v) {
      inputSink.value = "";
      const p = activePane();
      if (p) {
        if (p.vterm.meta().viewOffset > 0) p.vterm.setScroll(0);
        p.write(v);
        p.dirty = true;
      }
    }
  });

  function getSelectedText(pane) {
    if (
      !pane ||
      selPaneId !== pane.id ||
      selStart < 0 ||
      selEnd < 0 ||
      selStart === selEnd
    ) {
      return pane?.vterm.text() ?? "";
    }
    const lo = Math.min(selStart, selEnd);
    const hi = Math.max(selStart, selEnd);
    const m = pane.vterm.meta();
    const cols = pane.lastCols || m.cols;
    const cells = pane.lastCells;
    if (!cells) return pane.vterm.text();
    const r0 = Math.floor(lo / cols);
    const c0 = lo % cols;
    const r1 = Math.floor(hi / cols);
    const c1 = hi % cols;
    const lines = [];
    for (let r = r0; r <= r1; r++) {
      const startC = r === r0 ? c0 : 0;
      const endC = r === r1 ? c1 : cols - 1;
      let line = "";
      for (let c = startC; c <= endC; c++) {
        const cp = cells[(r * cols + c) * VTERM_GPU_STRIDE_U32];
        if (cp > 0) line += String.fromCodePoint(cp);
      }
      lines.push(line.replace(/\s+$/, ""));
    }
    return lines.join("\n");
  }

  inputSink.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyP") {
      ev.preventDefault();
      openPalette();
      return;
    }
    if (ev.ctrlKey && !ev.shiftKey && ev.code === "KeyK") {
      ev.preventDefault();
      inlineBar.classList.toggle("open");
      if (inlineBar.classList.contains("open")) inlineInput.focus();
      else inputSink.focus();
      return;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === "Period") {
      ev.preventDefault();
      aiPanel.classList.toggle("open");
      return;
    }
    if (ev.ctrlKey && ev.altKey && ev.code === "Period") {
      ev.preventDefault();
      askAi(true);
      return;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyC") {
      ev.preventDefault();
      navigator.clipboard
        ?.writeText(getSelectedText(activePane()))
        .catch(() => {});
      return;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyV") {
      ev.preventDefault();
      navigator.clipboard
        ?.readText()
        .then((txt) => {
          const pane = activePane();
          if (!pane || !txt) return;
          const m = pane.vterm.meta();
          pane.write(m.bracketedPaste ? `\x1b[200~${txt}\x1b[201~` : txt);
        })
        .catch(() => {});
      return;
    }
    if (ev.shiftKey && (ev.key === "PageUp" || ev.key === "PageDown")) {
      const p = activePane();
      if (p && !p.vterm.meta().altScreen) {
        ev.preventDefault();
        const delta = Math.max(3, Math.floor(p.vterm.meta().rows / 2));
        p.vterm.scrollLines(ev.key === "PageUp" ? delta : -delta);
        p.dirty = true;
        updateScrollHud();
        return;
      }
    }
    if (ev.ctrlKey && (ev.key === "=" || ev.key === "+")) {
      ev.preventDefault();
      atlas.setFontSize(atlas.fontSizeCss + 2, window.devicePixelRatio || 1);
      updateGpuBadge();
      resizeVisiblePanes();
      return;
    }
    if (ev.ctrlKey && ev.key === "-") {
      ev.preventDefault();
      atlas.setFontSize(atlas.fontSizeCss - 2, window.devicePixelRatio || 1);
      updateGpuBadge();
      resizeVisiblePanes();
      return;
    }

    const pane = activePane();
    if (!pane) return;
    const m = pane.vterm.meta();
    const seq = encodeKeyEvent(ev, m);
    if (seq !== null) {
      ev.preventDefault();
      if (m.viewOffset > 0) {
        pane.vterm.setScroll(0);
        pane.dirty = true;
        updateScrollHud();
      }
      pane.write(seq);
    }
  });

  function pointerToPaneCell(ev) {
    const bodyEl = ev.target?.closest?.(".pane-body");
    const targetPid = bodyEl?.dataset?.paneId || activeId;
    const p = panes.get(targetPid);
    if (!p || !bodyEl) return null;
    const rect = bodyEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const m = p.vterm.meta();
    const col = Math.max(
      0,
      Math.min(
        m.cols - 1,
        Math.floor(((ev.clientX - rect.left) * dpr) / atlas.cellW),
      ),
    );
    const row = Math.max(
      0,
      Math.min(
        m.rows - 1,
        Math.floor(((ev.clientY - rect.top) * dpr) / atlas.cellH),
      ),
    );
    return {
      pane: p,
      paneId: p.id,
      col,
      row,
      idx: row * m.cols + col,
      meta: m,
    };
  }

  function encodeSgrMouse(btnCode, col, row, release, ev) {
    let b = btnCode;
    if (ev.shiftKey) b |= 4;
    if (ev.altKey) b |= 8;
    if (ev.ctrlKey) b |= 16;
    return `\x1b[<${b};${col + 1};${row + 1}${release ? "m" : "M"}`;
  }

  splitStage.addEventListener("mousedown", (ev) => {
    const hit = pointerToPaneCell(ev);
    if (!hit) return;
    switchPane(hit.paneId);
    if (ev.ctrlKey && hoverLinkUrl && ev.button === 0) {
      ev.preventDefault();
      if (/^https?:\/\//i.test(hoverLinkUrl)) {
        window.open(hoverLinkUrl, "_blank", "noopener,noreferrer");
      }
      return;
    }
    if (hit.meta.mouseMode !== 0 && !ev.shiftKey) {
      ev.preventDefault();
      mouseDownBtn = ev.button === 2 ? 2 : ev.button === 1 ? 1 : 0;
      hit.pane.write(encodeSgrMouse(mouseDownBtn, hit.col, hit.row, false, ev));
      return;
    }
    selecting = true;
    selPaneId = hit.paneId;
    selStart = selEnd = hit.idx;
    hit.pane.dirty = true;
  });

  splitStage.addEventListener("mousemove", (ev) => {
    const hit = pointerToPaneCell(ev);
    if (!hit) return;
    if (hit.pane.lastCells && !selecting) {
      const cellFlags =
        hit.pane.lastCells[hit.idx * VTERM_GPU_STRIDE_U32 + 3] ?? 0;
      const slot = (cellFlags & 1024) !== 0 ? (cellFlags >>> 18) & 15 : 0;
      const url = slot > 0 ? hit.pane.vterm.getLink(slot) : "";
      if (slot !== hoverLinkSlot || hit.paneId !== hoverPaneId) {
        hoverPaneId = hit.paneId;
        hoverLinkSlot = slot;
        hoverLinkUrl = url;
        hit.pane.dirty = true;
        if (url) {
          linkTooltip.hidden = false;
          linkTooltip.textContent = `Ctrl+Click: ${url}`;
        } else {
          linkTooltip.hidden = true;
        }
      }
    }
    if (selecting && selPaneId === hit.paneId) {
      selEnd = hit.idx;
      hit.pane.dirty = true;
      return;
    }
    if (mouseDownBtn >= 0 && hit.meta.mouseMode >= 3 && !ev.shiftKey) {
      hit.pane.write(
        encodeSgrMouse(mouseDownBtn | 32, hit.col, hit.row, false, ev),
      );
    } else if (hit.meta.mouseMode === 4 && !ev.shiftKey) {
      hit.pane.write(encodeSgrMouse(35, hit.col, hit.row, false, ev));
    }
  });

  window.addEventListener("mouseup", (ev) => {
    if (mouseDownBtn >= 0) {
      const hit = pointerToPaneCell(ev);
      if (hit && hit.meta.mouseMode !== 0) {
        hit.pane.write(
          encodeSgrMouse(mouseDownBtn, hit.col, hit.row, true, ev),
        );
      }
      mouseDownBtn = -1;
    }
    selecting = false;
  });

  splitStage.addEventListener(
    "wheel",
    (ev) => {
      const hit = pointerToPaneCell(ev) ?? {
        pane: activePane(),
        col: 0,
        row: 0,
        meta: activePane()?.vterm.meta(),
      };
      if (!hit.pane || !hit.meta) return;
      ev.preventDefault();
      if (hit.meta.mouseMode !== 0 && !ev.shiftKey) {
        const btn = ev.deltaY < 0 ? 64 : 65;
        hit.pane.write(encodeSgrMouse(btn, hit.col, hit.row, false, ev));
      } else if (!hit.meta.altScreen) {
        hit.pane.vterm.scrollLines(ev.deltaY < 0 ? 3 : -3);
        hit.pane.dirty = true;
        updateScrollHud();
      }
    },
    { passive: false },
  );

  window.addEventListener("resize", () => resizeVisiblePanes());
  themeSelect.onchange = () => applyThemeCss(themeSelect.value);
  sbPill.onclick = () => {
    const p = activePane();
    if (p) {
      p.vterm.setScroll(0);
      p.dirty = true;
      updateScrollHud();
    }
  };
  document.getElementById("btn-split-h").onclick = () => splitActivePane("h");
  document.getElementById("btn-split-v").onclick = () => splitActivePane("v");
  document.getElementById("btn-inline-ai").onclick = () => {
    inlineBar.classList.toggle("open");
    if (inlineBar.classList.contains("open")) inlineInput.focus();
  };
  document.getElementById("btn-diagnose").onclick = () => askAi(true);
  errorPill.onclick = () => askAi(true);
  aiSend.onclick = () => askAi(false);
  inlineRun.onclick = () => runInlineAi();
  inlineClose.onclick = () => {
    inlineBar.classList.remove("open");
    inputSink.focus();
  };
  inlineInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      runInlineAi();
    } else if (ev.key === "Escape") {
      inlineBar.classList.remove("open");
      inputSink.focus();
    }
  });
  document.getElementById("btn-toggle-ai").onclick = () => {
    aiPanel.classList.toggle("open");
    resizeVisiblePanes();
  };
  if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
    new ResizeObserver(() => resizeVisiblePanes()).observe(
      canvas.parentElement,
    );
  }
  document.getElementById("btn-palette").onclick = () => openPalette();
  aiPrompt.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      askAi(false);
    }
  });

  function openPalette() {
    const items = [
      ...themes.map((t) => ({
        title: `Theme: ${t.name}`,
        run: () => {
          themeSelect.value = t.slug;
          applyThemeCss(t.slug);
        },
      })),
      ...profiles.map((prof) => ({
        title: `New Tab: ${prof.label}`,
        run: () => spawnNewTab(prof.id),
      })),
      {
        title: "Split Horizontal (Side by Side)",
        run: () => splitActivePane("h"),
      },
      {
        title: "Split Vertical (Stacked)",
        run: () => splitActivePane("v"),
      },
      {
        title: "Inline AI Command Prompt (Ctrl+K)",
        run: () => {
          inlineBar.classList.add("open");
          inlineInput.focus();
        },
      },
      {
        title: "Font Size: 20px Google Sans Code (Reset)",
        run: () => {
          atlas.setFontSize(20, window.devicePixelRatio || 1);
          updateGpuBadge();
          resizeVisiblePanes();
        },
      },
      {
        title: "Toggle AI Agent Panel (Ctrl+Shift+.)",
        run: () => aiPanel.classList.toggle("open"),
      },
      { title: "Ask AI about Last Error (Ctrl+Alt+.)", run: () => askAi(true) },
    ];
    const renderItems = (q) => {
      paletteList.innerHTML = "";
      for (const it of items.filter((x) =>
        x.title.toLowerCase().includes(q.toLowerCase()),
      )) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = it.title;
        b.onclick = () => {
          paletteDlg.close();
          it.run();
        };
        paletteList.appendChild(b);
      }
    };
    renderItems("");
    paletteInput.value = "";
    paletteInput.oninput = () => renderItems(paletteInput.value);
    paletteDlg.showModal();
    paletteInput.focus();
  }

  const webmcpTools = [
    {
      name: "term_read_screen",
      description:
        "Read visible text & OSC 133 semantic blocks from active Aphrody WebGPU pane",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const p = activePane();
        return p
          ? {
              text: p.vterm.text(),
              meta: p.vterm.meta(),
              blocks: p.vterm.blocks(),
            }
          : {};
      },
    },
    {
      name: "term_send_keys",
      description: "Send keystrokes or command text to active terminal pane",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (a) => {
        activePane()?.write(String(a.text ?? ""));
        return { ok: true };
      },
    },
  ];

  let renderCount = 0;
  let lastFpsStamp = performance.now();
  let measuredFps = 0;

  window.__aphrodyTerm = {
    hasWebGpu,
    adapterInfo: webgpu.adapterInfo,
    themesCount: themes.length,
    activePaneId: () => activeId,
    getPaneIds: () => [...panes.keys()],
    splitPane: (dir = "h") => splitActivePane(dir),
    closePane: (id) => closePane(id ?? activeId),
    scrollLines: (delta) => {
      const p = activePane();
      if (!p) return 0;
      const v = p.vterm.scrollLines(delta);
      p.dirty = true;
      updateScrollHud();
      return v;
    },
    getText: () => activePane()?.vterm.text() ?? "",
    getMeta: () => activePane()?.vterm.meta() ?? null,
    getBlocks: () => activePane()?.vterm.blocks() ?? [],
    getStats: () => ({ hasWebGpu, measuredFps, renderCount }),
    webmcpTools: webmcpTools.map((t) => t.name),
  };

  if (navigator.modelContext?.registerTool) {
    for (const tool of webmcpTools) {
      try {
        navigator.modelContext.registerTool(tool);
      } catch {}
    }
  }

  // Dirty-driven + ?2026 synchronized frame loop across all split panes in 1 GPU render pass
  let lastBlink = true;
  const startMs = performance.now();
  function frame(now) {
    const ws = currentWorkspace();
    const visibleIds = ws ? collectLeafIds(ws.root) : [];
    const blinkOn = Math.floor(now / 530) % 2 === 0;
    let anyDirty = blinkOn !== lastBlink;

    for (const pid of visibleIds) {
      const p = panes.get(pid);
      if (!p) continue;
      const m = p.vterm.meta();
      // Hold off redraw briefly during CSI ? 2026 h/l synchronized update (80ms cap)
      if (m.syncOutput && p.syncHoldSince && now - p.syncHoldSince < 80) {
        continue;
      }
      if (p.dirty) anyDirty = true;
    }

    if (anyDirty && visibleIds.length > 0) {
      lastBlink = blinkOn;
      const rects = measureAllVisiblePaneRects();
      const entries = [];
      let activeBgArgb = themes[0]?.bgArgb ?? 0xff0c141b;
      for (const pid of visibleIds) {
        const p = panes.get(pid);
        const rectPx = rects.get(pid);
        if (!p || !rectPx) continue;
        p.dirty = false;
        const meta = p.vterm.meta();
        const packed = p.vterm.packGpuCells();
        // Copy snapshot per pane so subsequent packGpuCells() calls never overwrite shared WASM gpuPtr
        p.lastCells = new Uint32Array(packed);
        p.lastCols = meta.cols;
        const t = themes.find((x) => x.slug === p.themeSlug) ?? themes[0];
        if (pid === activeId) activeBgArgb = t.bgArgb;
        entries.push({
          paneId: pid,
          packedCells: p.lastCells,
          meta,
          theme: t,
          rectPx,
          selStart: selPaneId === pid ? selStart : -1,
          selEnd: selPaneId === pid ? selEnd : -1,
          blinkOn,
          focused: pid === activeId,
          hoverLinkSlot: hoverPaneId === pid ? hoverLinkSlot : 0,
          timeSec: (now - startMs) / 1000,
        });
      }
      if (entries.length > 0) {
        if (hasWebGpu) webgpu.renderPanes(entries, activeBgArgb);
        else c2d.renderPanes(entries, activeBgArgb);
        renderCount++;
        if (now - lastFpsStamp >= 1000) {
          measuredFps = renderCount;
          renderCount = 0;
          lastFpsStamp = now;
          updateGpuBadge(` · ${measuredFps} rps`);
        }
      }
      const ap = activePane();
      if (ap) inputSink.setAttribute("aria-label", `Terminal ${ap.title}`);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
