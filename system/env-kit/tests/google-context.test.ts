import { expect, test } from "bun:test";
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

// Needs the real checkout layout (../rosegriffon is its own repository): skipped elsewhere (CI Linux).
const SRC = require("node:path").resolve(import.meta.dir, "..", "..", "..");
test.skipIf(!require("node:fs").existsSync(`${SRC}/../rosegriffon/.git`))(
  "detectContext picks rosegriffon inside the sibling rosegriffon checkout and aphrody at the src root",
  () => {
    expect(detectContext(`${SRC}/../rosegriffon/apps/rg-website`).name).toBe(
      "rosegriffon",
    );
    // A path with no rosegriffon fragment falls through to the default aphrody context.
    expect(detectContext("C:/tmp/unrelated").name).toBe("aphrody");
  },
);

test("contextEnv points every SDK var at the context project and omits a missing key file", () => {
  const ctx = GCLOUD_CONTEXTS.find((c) => c.name === "rosegriffon")!;
  const env = contextEnv(ctx, {
    GOOGLE_APPLICATION_CREDENTIALS_RGFR: "C:/nope/missing.json",
  });
  expect(env.GOOGLE_CLOUD_PROJECT).toBe(ROSEGRIFFON_PROJECT);
  expect(env.CLOUDSDK_ACTIVE_CONFIG_NAME).toBe("rosegriffon");
  expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  expect(exportLines(env)).toContain("export GOOGLE_CLOUD_PROJECT=");
});
