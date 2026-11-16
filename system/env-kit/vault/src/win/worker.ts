// SPDX-License-Identifier: Apache-2.0
// Worker of win/pool.ts: runs the blocking Win32 crypto calls off the main event loop.
import {
  dpapiProtect,
  dpapiUnprotect,
  helloEnroll,
  helloStatus,
  helloUnwrap,
  helloWrap,
} from "./ffi.ts";

declare const self: Worker;

export type Op =
  | { op: "protect" | "unprotect"; data: Uint8Array; entropy?: Uint8Array }
  | { op: "hello-status"; name: string }
  | { op: "hello-enroll"; name: string; context: string }
  | { op: "hello-wrap"; name: string; data: Uint8Array }
  | { op: "hello-unwrap"; name: string; data: Uint8Array; context: string };

self.onmessage = (ev: MessageEvent<{ id: number } & Op>) => {
  const m = ev.data;
  try {
    let out: unknown;
    switch (m.op) {
      case "protect":
        out = dpapiProtect(m.data, m.entropy);
        break;
      case "unprotect":
        out = dpapiUnprotect(m.data, m.entropy);
        break;
      case "hello-status":
        out = helloStatus(m.name);
        break;
      case "hello-enroll":
        helloEnroll(m.name, m.context);
        out = true;
        break;
      case "hello-wrap":
        out = helloWrap(m.name, m.data);
        break;
      case "hello-unwrap":
        out = helloUnwrap(m.name, m.data, m.context);
        break;
    }
    if ("data" in m) m.data.fill(0);
    const transfer =
      out instanceof Uint8Array ? [out.buffer as ArrayBuffer] : [];
    self.postMessage({ id: m.id, ok: true, out }, transfer);
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: (e as Error).message });
  }
};
