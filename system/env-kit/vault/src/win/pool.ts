// SPDX-License-Identifier: Apache-2.0
/**
 * Fixed pool of bun Workers for the blocking Win32 calls (DPAPI, NCrypt). The main thread only
 * posts messages and awaits replies: no FFI call ever runs on the event loop. Workers are unref'd,
 * so an idle pool never keeps a process alive. Size: VAULT_WORKERS, default 2.
 */
import type { Op } from "./worker.ts";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  w: Slot;
};
// Bun Workers have ref()/unref() (not in the DOM typings).
type BunWorker = Worker & { ref(): void; unref(): void };
type Slot = { worker: BunWorker; busy: number };

const pending = new Map<number, Pending>();
let slots: Slot[] | undefined;
let seq = 0;

function pool(): Slot[] {
  if (slots) return slots;
  const n = Math.max(1, Number(process.env.VAULT_WORKERS ?? 2));
  slots = Array.from({ length: n }, () => {
    const worker = new Worker(
      new URL("./worker.ts", import.meta.url).href,
    ) as BunWorker;
    worker.unref();
    const slot: Slot = { worker, busy: 0 };
    worker.onmessage = (
      ev: MessageEvent<{
        id: number;
        ok: boolean;
        out?: unknown;
        error?: string;
      }>,
    ) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (--p.w.busy === 0) p.w.worker.unref();
      ev.data.ok ? p.resolve(ev.data.out) : p.reject(new Error(ev.data.error));
    };
    worker.onerror = (ev) => {
      for (const [id, p] of pending)
        if (p.w === slot) {
          pending.delete(id);
          p.reject(new Error(`vault worker: ${ev.message}`));
        }
      slot.busy = 0;
    };
    return slot;
  });
  return slots;
}

export function run<T>(op: Op): Promise<T> {
  const s = pool().reduce((a, b) => (b.busy < a.busy ? b : a));
  const id = ++seq;
  if (s.busy++ === 0) s.worker.ref();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, w: s });
    // The worker owns the copy; the caller's buffer is left intact.
    if ("data" in op) {
      const data = op.data.slice();
      s.worker.postMessage({ id, ...op, data }, [data.buffer]);
    } else s.worker.postMessage({ id, ...op });
  });
}

export const dpapiProtect = (d: Uint8Array, entropy?: Uint8Array) =>
  run<Uint8Array>({ op: "protect", data: d, entropy });
export const dpapiUnprotect = (d: Uint8Array, entropy?: Uint8Array) =>
  run<Uint8Array>({ op: "unprotect", data: d, entropy });
export const helloStatus = (name: string) =>
  run<{ provider: boolean; key: boolean; error?: string }>({
    op: "hello-status",
    name,
  });
export const helloEnroll = (name: string, context: string) =>
  run<boolean>({ op: "hello-enroll", name, context });
export const helloWrap = (name: string, data: Uint8Array) =>
  run<Uint8Array>({ op: "hello-wrap", name, data });
export const helloUnwrap = (name: string, data: Uint8Array, context: string) =>
  run<Uint8Array>({ op: "hello-unwrap", name, data, context });
