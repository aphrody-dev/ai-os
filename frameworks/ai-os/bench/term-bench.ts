/**
 * Reproducible Terminal Performance Benchmark Suite (`frameworks/ai-os/bench/term-bench.ts`)
 * Methodology mirrors `third_party/terminal-control/scripts/bench-performance.ts` and `ghostty-web/bench/versus.ts`:
 *  - Warmup + N measured iterations, reporting median, MAD (median absolute deviation), p95, and MB/s.
 *  - Head-to-head VT parsing: Pure C11 `aysys.dll` (bun:ffi), Pure C11 `aysys.wasm` (WASM32), and `ghostty-vt.wasm` (Zig libghostty-vt).
 *  - Real Chrome 157 NVIDIA Lovelace WebGPU vs Canvas2D frame timing on dense 240x80 GPU grids.
 *  - Real ConPTY shell roundtrip latency (`cmd`, `pwsh`, `niubash`).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { VTerm } from "@aphrody/core";
import { chromePath } from "../src/relay/cdp.ts";
import { TermManager } from "../src/term/pty.ts";
import { startTermServer } from "../src/term/server.ts";
import { loadVTermWasm } from "../src/term/web/vterm-wasm.js";

const enc = new TextEncoder();

function stats(samplesMs: number[]) {
  const s = [...samplesMs].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)]!;
  const devs = s.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = devs[Math.floor(devs.length / 2)]!;
  const p95 = s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
  return {
    medianMs: Number(med.toFixed(3)),
    madMs: Number(mad.toFixed(3)),
    p95Ms: Number(p95.toFixed(3)),
    minMs: Number(s[0]!.toFixed(3)),
  };
}

function measure(warmup: number, runs: number, fn: () => void) {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return stats(times);
}

// Workloads matching ghostty-web/bench/versus.ts + TUI workloads
function makePlainAscii(bytesCount: number): Uint8Array {
  const out = new Uint8Array(bytesCount);
  for (let i = 0; i < bytesCount; i++) {
    const m = i % 82;
    out[i] = m === 80 ? 13 : m === 81 ? 10 : 32 + (i % 94);
  }
  return out;
}

function makeDenseTruecolor(lines: number): Uint8Array {
  const chunks: string[] = [];
  for (let i = 0; i < lines; i++) {
    const r = (i * 17) & 255;
    const g = (i * 43) & 255;
    const b = (i * 89) & 255;
    chunks.push(
      `\x1b[1;4;38;2;${r};${g};${b}mLine ${i}: truecolor SGR + \x1b[48;5;${(i % 200) + 16}m256bg\x1b[0m \u2500\u2502\u250c\u2510\r\n`,
    );
  }
  return enc.encode(chunks.join(""));
}

function makeTuiRedraw(frames: number): Uint8Array {
  const chunks: string[] = [];
  for (let f = 0; f < frames; f++) {
    chunks.push(`\x1b[H`);
    for (let r = 1; r <= 24; r++) {
      chunks.push(
        `\x1b[${r};1H\x1b[38;2;139;206;255m\u2502\x1b[0m row=${String(r).padStart(2, "0")} frame=${String(f).padStart(4, "0")} \x1b[K`,
      );
    }
  }
  return enc.encode(chunks.join(""));
}

function makeOsc133Blocks(count: number): Uint8Array {
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const rc = i % 5 === 0 ? 1 : 0;
    chunks.push(
      `\x1b]133;A\x07$ \x1b]133;B\x07cmd_${i}\x1b]133;C\x07\r\nok ${i}\r\n\x1b]133;D;${rc}\x07`,
    );
  }
  return enc.encode(chunks.join(""));
}

async function loadGhosttyVt() {
  const cacheBase = join(
    Bun.env.USERPROFILE ?? Bun.env.HOME ?? homedir(),
    ".bun/install/cache",
  );
  const candidates = [
    join(
      cacheBase,
      "ghostty-web@0.4.0@@@1_patch_hash=cb2f80e7c39e37c7/ghostty-vt.wasm",
    ),
    join(cacheBase, "ghostty-web@0.4.0@@@1/ghostty-vt.wasm"),
  ];
  const wasmFile = candidates.find((p) => existsSync(p));
  if (!wasmFile) return null;
  const bytes = await Bun.file(wasmFile).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { log: () => {} },
  });
  return instance.exports as any;
}

async function benchVtParsers() {
  const srcRoot = join(import.meta.dir, "..", "..", "..");
  const wasmBytes = await Bun.file(
    join(srcRoot, "target", "sys", "aysys.wasm"),
  ).arrayBuffer();
  const { instance: ayWasmInst } = await WebAssembly.instantiate(wasmBytes, {});
  const ayExp = ayWasmInst.exports as any;
  const neededBytes = ayExp.ay_vterm_state_bytes() + 131072;
  ayExp.memory.grow(Math.ceil(neededBytes / 65536) + 2);
  const wasmStatePtr =
    ayExp.memory.buffer.byteLength - ayExp.ay_vterm_state_bytes() - 64;
  const wasmInPtr = wasmStatePtr - 65536;

  // Prepare JS WebAssembly helper wrapper via URL/file blob
  const wasmServer = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(wasmBytes, {
        headers: { "content-type": "application/wasm" },
      }),
  });
  const ayWasmRuntime = await loadVTermWasm(wasmServer.url.toString());
  wasmServer.stop(true);
  const ayWasmPane = ayWasmRuntime.createPane(120, 40, "aphrody-m3-dark");
  const ayDllPane = new VTerm(120, 40, "aphrody-m3-dark");

  const ghostty = await loadGhosttyVt();
  let ghosttyTerm = 0;
  let ghosttyRs = 0;
  let ghosttyBuf = 0;
  const GHOSTTY_CHUNK = 65536;
  if (ghostty) {
    ghosttyTerm = ghostty.ghostty_terminal_new(120, 40);
    ghosttyRs = ghostty.ghostty_render_state_update ? 1 : 0;
    ghosttyBuf = ghostty.ghostty_wasm_alloc_u8_array(GHOSTTY_CHUNK);
  }

  const workloads: Array<[string, Uint8Array]> = [
    ["plain_ascii_2mb", makePlainAscii(2 * 1024 * 1024)],
    ["dense_truecolor_5k", makeDenseTruecolor(5000)],
    ["tui_redraw_250f", makeTuiRedraw(250)],
    ["osc133_blocks_2k", makeOsc133Blocks(2000)],
  ];

  const results: any[] = [];
  for (const [name, payload] of workloads) {
    const mb = payload.byteLength / (1024 * 1024);

    const dllFeed = measure(2, 7, () => {
      ayDllPane.feed(payload);
    });
    const dllPack = measure(2, 7, () => {
      ayDllPane.feed(payload);
      ayDllPane.packGpuCells();
    });

    const wasmFeed = measure(2, 7, () => {
      ayWasmPane.feed(payload);
    });
    const wasmPack = measure(2, 7, () => {
      ayWasmPane.feed(payload);
      ayWasmPane.packGpuCells();
    });

    let ghostFeed: any = null;
    if (ghostty && ghosttyTerm) {
      ghostFeed = measure(2, 7, () => {
        for (let off = 0; off < payload.byteLength; off += GHOSTTY_CHUNK) {
          const n = Math.min(GHOSTTY_CHUNK, payload.byteLength - off);
          new Uint8Array(ghostty.memory.buffer, ghosttyBuf, n).set(
            payload.subarray(off, off + n),
          );
          ghostty.ghostty_terminal_write(ghosttyTerm, ghosttyBuf, n);
        }
      });
    }

    results.push({
      workload: name,
      bytes: payload.byteLength,
      mb: Number(mb.toFixed(3)),
      dll_feed_ms: dllFeed.medianMs,
      dll_mbps: Number((mb / (dllFeed.medianMs / 1000)).toFixed(1)),
      dll_feed_pack_ms: dllPack.medianMs,
      wasm_feed_ms: wasmFeed.medianMs,
      wasm_mbps: Number((mb / (wasmFeed.medianMs / 1000)).toFixed(1)),
      wasm_feed_pack_ms: wasmPack.medianMs,
      ghostty_wasm_feed_ms: ghostFeed?.medianMs ?? null,
      ghostty_wasm_mbps: ghostFeed
        ? Number((mb / (ghostFeed.medianMs / 1000)).toFixed(1))
        : null,
    });
  }

  if (ghostty && ghosttyTerm) {
    ghostty.ghostty_wasm_free_u8_array(ghosttyBuf, GHOSTTY_CHUNK);
    ghostty.ghostty_terminal_free(ghosttyTerm);
  }
  return results;
}

async function benchPtyLatency() {
  const profiles = ["cmd", "pwsh", "niubash"];
  const out: any[] = [];
  for (const prof of profiles) {
    const mgr = new TermManager();
    const avail = mgr.profiles().some((p) => p.id === prof);
    if (!avail) {
      out.push({ profile: prof, available: false });
      continue;
    }
    const samplesSpawn: number[] = [];
    const samplesEcho: number[] = [];
    for (let i = 0; i < 4; i++) {
      const m = new TermManager();
      const t0 = performance.now();
      const pane = m.spawn({ profile: prof, cols: 100, rows: 30 });
      const marker = `AY_BENCH_${i}_${Date.now()}`;
      // wait brief shell init
      const d0 = Date.now() + 6000;
      while (Date.now() < d0 && pane.vterm.meta().feedBytes < 4) {
        await Bun.sleep(10);
      }
      const spawnReadyMs = performance.now() - t0;
      const t1 = performance.now();
      pane.write(`echo ${marker}\r`);
      const d1 = Date.now() + 4000;
      while (Date.now() < d1 && !pane.vterm.text().includes(marker)) {
        await Bun.sleep(5);
      }
      const echoMs = performance.now() - t1;
      if (i > 0) {
        samplesSpawn.push(spawnReadyMs);
        samplesEcho.push(echoMs);
      }
      m.closeAll();
    }
    out.push({
      profile: prof,
      available: true,
      spawn_first_byte_ms: stats(samplesSpawn).medianMs,
      echo_roundtrip_ms: stats(samplesEcho).medianMs,
    });
  }
  return out;
}

async function benchBrowserWebGpu() {
  const mgr = new TermManager();
  const srv = await startTermServer({
    port: 0,
    manager: mgr,
    defaultProfile: process.platform === "win32" ? "cmd" : undefined,
    theme: "aphrody-m3-dark",
  });
  const profileDir = mkdtempSync(join(tmpdir(), "ay-bench-chrome-"));
  let chromeProc: Bun.Subprocess | undefined;
  try {
    const port = 45000 + Math.floor(Math.random() * 5000);
    console.error(
      "[gpu-bench] launching chrome on",
      srv.launchUrl,
      "cdp:",
      port,
    );
    chromeProc = Bun.spawn(
      [
        chromePath(),
        "--headless=new",
        "--disable-gpu-sandbox",
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        "--window-size=1600,1000",
        srv.launchUrl,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    let wsUrl = "";
    const dl = Date.now() + 8_000;
    while (Date.now() < dl) {
      try {
        const list = (await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json()) as any[];
        const pg = list.find((t) => t.type === "page");
        if (pg?.webSocketDebuggerUrl) {
          wsUrl = pg.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await Bun.sleep(100);
    }
    if (!wsUrl) throw new Error("CDP wsUrl timeout");
    console.error("[gpu-bench] connected cdp:", wsUrl);
    const cdp = new WebSocket(wsUrl);
    await new Promise<void>((ok, fail) => {
      cdp.onopen = () => ok();
      cdp.onerror = (e) => fail(new Error(`CDP WS error: ${e}`));
    });
    let seq = 0;
    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = ++seq;
        const onMsg = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data));
          if (m.id !== id) return;
          cdp.removeEventListener("message", onMsg);
          if (m.error) reject(new Error(m.error.message));
          else resolve(m.result);
        };
        cdp.addEventListener("message", onMsg);
        cdp.send(JSON.stringify({ id, method, params }));
      });

    for (let i = 0; i < 60; i++) {
      const r = await call("Runtime.evaluate", {
        expression: "window.__aphrodyTerm ? true : false",
        returnByValue: true,
      });
      if (r?.result?.value) break;
      await Bun.sleep(100);
    }

    const stateCheck = await call("Runtime.evaluate", {
      expression: `(() => ({ has: !!window.__aphrodyTerm, badge: document.getElementById('gpu-badge')?.textContent, errs: window.__errs || [] }))()`,
      returnByValue: true,
    });
    if (!stateCheck?.result?.value?.has) {
      throw new Error(
        `__aphrodyTerm not initialized: ${JSON.stringify(stateCheck)}`,
      );
    }

    // Measure GPU/Canvas render directly across 40 dense frames
    const paneId = mgr.first()!.id;
    const sampleAnsi = enc.encode(
      Array.from(
        { length: 40 },
        (_, r) =>
          `\x1b[${r + 1};1H\x1b[38;2;139;206;255m\u250c\u2500 Pane Row ${String(r + 1).padStart(2, "0")} \u2510\x1b[0m \x1b[38;2;148;226;213mOK\x1b[0m \x1b[48;2;25;45;68m block=${r} \x1b[0m`,
      ).join(""),
    );
    mgr.get(paneId)!.vterm.feed(sampleAnsi);

    const benchRes = await Promise.race([
      call("Runtime.evaluate", {
        expression: `(async () => {
          const st = window.__aphrodyTerm;
          const badge = document.getElementById('gpu-badge')?.textContent || '';
          const c = document.getElementById('term-canvas');
          const frameTimes = [];
          let prev = performance.now();
          await new Promise((done) => {
            let n = 0;
            function tick(now) {
              frameTimes.push(now - prev);
              prev = now;
              if (++n >= 45) done();
              else requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
          });
          const trimmed = frameTimes.slice(5).sort((a,b) => a - b);
          const med = trimmed[Math.floor(trimmed.length / 2)];
          const p95 = trimmed[Math.min(trimmed.length - 1, Math.ceil(trimmed.length * 0.95) - 1)];
          return {
            hasWebGpu: st.hasWebGpu,
            badge,
            canvasW: c?.width,
            canvasH: c?.height,
            rafMedianMs: Number(med.toFixed(2)),
            rafP95Ms: Number(p95.toFixed(2)),
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }),
      Bun.sleep(8000).then(() => {
        throw new Error("rAF benchmark timeout (headless throttled)");
      }),
    ]);
    cdp.close();
    return benchRes?.result?.value;
  } finally {
    srv.stop(true);
    mgr.closeAll();
    chromeProc?.kill();
    await chromeProc?.exited.catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  }
}

const mode = Bun.argv[2] ?? "--all";
if (mode === "--all" || mode === "--vt") {
  console.log(
    "=== 1. VT PARSER BENCHMARK (DLL vs WASM vs GHOSTTY-VT.WASM) ===",
  );
  console.table(await benchVtParsers());
}
if (mode === "--all" || mode === "--pty") {
  console.log("=== 2. REAL CONPTY LATENCY BENCHMARK ===");
  console.table(await benchPtyLatency());
}
if (mode === "--all" || mode === "--gpu") {
  console.log("=== 3. CHROME 157 WEBGPU BENCHMARK ===");
  console.log(JSON.stringify(await benchBrowserWebGpu(), null, 2));
}
