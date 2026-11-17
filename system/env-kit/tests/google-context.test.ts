import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextEnv,
  detectContext,
  GCLOUD_CONTEXTS,
  ROSEGRIFFON_PROJECT,
  exportLines,
} from "../src/google-context";

test("contexts are ordered with a catch-all default last", () => {
  const last = GCLOUD_CONTEXTS[GCLOUD_CONTEXTS.length - 1]!;
  expect(last.pathMatches).toContain(require("node:path").sep);
  expect(GCLOUD_CONTEXTS.find((c) => c.name === "rosegriffon")?.project).toBe(
    ROSEGRIFFON_PROJECT,
  );
});

test("detectContext picks rosegriffon by path fragment and falls through to aphrody", () => {
  const base = mkdtempSync(join(tmpdir(), "ctx-"));
  try {
    const site = join(base, "apps", "rosegriffon", "rg-website");
    const other = join(base, "unrelated");
    mkdirSync(site, { recursive: true });
    mkdirSync(other, { recursive: true });
    expect(detectContext(site).name).toBe("rosegriffon");
    // A path with no rosegriffon fragment falls through to the default aphrody context.
    expect(detectContext(other).name).toBe("aphrody");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("contextEnv points every SDK var at the context project and omits a missing key file", () => {
  const ctx = GCLOUD_CONTEXTS.find((c) => c.name === "rosegriffon")!;
  const env = contextEnv(ctx, {
    GOOGLE_APPLICATION_CREDENTIALS_RGFR: join(tmpdir(), "nope", "missing.json"),
  });
  expect(env.GOOGLE_CLOUD_PROJECT).toBe(ROSEGRIFFON_PROJECT);
  expect(env.CLOUDSDK_ACTIVE_CONFIG_NAME).toBe("rosegriffon");
  expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  expect(exportLines(env)).toContain("export GOOGLE_CLOUD_PROJECT=");
});
