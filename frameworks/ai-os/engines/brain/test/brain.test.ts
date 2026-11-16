import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBrainVaultStats,
  loadBrainSessions,
  queryBrainSessions,
} from "../src/index.ts";

describe("@aphrody/brain vault indexing & query API", () => {
  test("indexes and filters redacted vault sessions accurately", () => {
    const vault = mkdtempSync(join(tmpdir(), "brain-vault-"));
    try {
      mkdirSync(join(vault, "Sessions"), { recursive: true });
      writeFileSync(join(vault, "Sessions", "note-1.md"), "# Session 1\n");
      writeFileSync(
        join(vault, "sessions.json"),
        JSON.stringify([
          {
            id: "4b0b07e6-test",
            start: "2026-11-11T10:00:00Z",
            end: "2026-11-11T10:15:00Z",
            steps: 24,
            files: ["C:/aphrody/apps/web/server.ts"],
            subagents: ["Codebase Researcher"],
            toolErrors: 0,
            status: "completed",
            quota429: false,
            firstUser: "build sovereign search engine",
          },
          {
            id: "99112233-stop",
            start: "2026-11-10T22:00:00Z",
            end: "2026-11-10T22:42:00Z",
            steps: 12,
            files: ["C:/aphrody/apps/yolo/server.ts"],
            subagents: [],
            toolErrors: 1,
            status: "stopped-quota-429",
            quota429: true,
            firstUser: "yolo fullstack framework",
          },
        ]),
      );

      const all = loadBrainSessions(vault);
      expect(all.length).toBe(2);

      const hits = queryBrainSessions("aphrody", { vaultPath: vault });
      expect(hits.length).toBe(1);
      expect(hits[0]?.id).toBe("4b0b07e6-test");

      const stats = getBrainVaultStats(vault);
      expect(stats.exists).toBe(true);
      expect(stats.totalSessions).toBe(2);
      expect(stats.markdownNotesCount).toBe(1);
      expect(stats.statusBreakdown["completed"]).toBe(1);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
