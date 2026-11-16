import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllKnowledgeDatabases,
  DISTRO_PIPELINES,
  fetchLiveKernelData,
  generateLiveUpstreamMdx,
} from "../src/index.ts";

describe("kernel-crawler consolidated into @aphrody/knowledge-engine", () => {
  test("offline kernel feed + MDX emitter produces deterministic output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ske-kernel-"));
    try {
      const dbPath = join(dir, "knowledge.sqlite");
      const feed = await fetchLiveKernelData({ offline: true, dbPath });
      expect(feed.latest_stable.version.length).toBeGreaterThan(0);
      expect(feed.releases.length).toBeGreaterThanOrEqual(2);
      expect(DISTRO_PIPELINES.length).toBeGreaterThanOrEqual(6);

      const mdx = generateLiveUpstreamMdx(feed, "2026-11-11T12:00:00.000Z");
      expect(mdx).toContain("Current Latest Stable Kernel");
      expect(mdx).toContain("Arch Linux / CachyOS");
      expect(mdx).toContain("ABAF 11C6 5A29 70B1 30AB");
    } finally {
      closeAllKnowledgeDatabases();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
