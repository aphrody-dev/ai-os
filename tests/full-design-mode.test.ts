import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GLOBAL_DESIGN_COLLECTIONS,
  enableFullDesignModeGlobal,
  getAiOsGlobalMode,
} from "../src/index.ts";

describe("ai-os Global Full Design Mode Default", () => {
  test("new nexus database defaults to full-design mode with pro-max-fullstack & google-labs enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "aios-design-mode-"));
    try {
      const dbPath = join(dir, "nexus.sqlite");
      const status = getAiOsGlobalMode(dbPath);
      expect(status.mode).toBe("full-design");
      for (const cid of DEFAULT_GLOBAL_DESIGN_COLLECTIONS) {
        expect(status.activeCollections).toContain(cid);
      }

      const skillsOutRoot = join(dir, "skills");
      const modeStatePath = join(dir, "agy-mode-state.json");
      const enabled = enableFullDesignModeGlobal({
        dbPath,
        skillsOutRoot,
        modeStatePath,
      });
      expect(enabled.ok).toBe(true);
      expect(enabled.mode).toBe("full-design");
      expect(enabled.umbrellaSkillsWritten.length).toBeGreaterThanOrEqual(5);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows SQLite WAL handle released on process exit
      }
    }
  });
});
