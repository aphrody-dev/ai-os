// Reproducible rescan of all NHITL sources (called by `ai-os nhitl scan` and the scheduled task).
import type { Index, Source } from "./index";
import {
  scanCode,
  scanDocs,
  scanHook,
  scanLedger,
  scanQueues,
  scanSettings,
  scanTranscripts,
} from "./scanners";

export const ALL: Source[] = [
  "transcript",
  "settings",
  "code",
  "queue",
  "docs",
  "hook",
  "ledger",
];

export async function scan(ix: Index, only: Source[] = ALL, local = false) {
  const report: Record<string, { n: number; ms: number; error?: string }> = {};
  const run = async (src: Source, f: () => Promise<any> | any) => {
    if (!only.includes(src)) return;
    const t0 = performance.now();
    try {
      const r = await f();
      const items = Array.isArray(r) ? r : r.items;
      ix.replace(src, items, r.keep ?? [], r.stamps ?? {});
      const n = items.length + (r.keep?.length ?? 0);
      const error =
        r.errors && Object.keys(r.errors).length
          ? JSON.stringify(r.errors)
          : undefined;
      const ms = Math.round(performance.now() - t0);
      ix.logScan(src, n, ms, error);
      report[src] = { n, ms, ...(error ? { error } : {}) };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      ix.logScan(src, 0, ms, String(e));
      report[src] = { n: 0, ms, error: String(e) };
    }
  };
  await Promise.all([
    run("code", () => scanCode()),
    run("docs", () => scanDocs()),
    run("queue", () => scanQueues(local)),
  ]);
  await run("transcript", () => scanTranscripts(ix));
  await run("settings", () => scanSettings());
  await run("hook", () => scanHook());
  await run("ledger", () => scanLedger());
  return report;
}
