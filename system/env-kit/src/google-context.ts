// SPDX-License-Identifier: Apache-2.0
/**
 * Context-aware Google / gcloud selection.
 *
 * One workstation serves several GCP projects (aphrody, rosegriffon, ...).
 * The right project, account, gcloud configuration and service-account key depend on which repo the
 * command runs in. This module detects that context from the execution directory — git remote first,
 * then the path — and returns the environment that points every Google SDK and the gcloud CLI at the
 * matching project, with no per-shell manual `gcloud config activate`.
 *
 * Add a project by appending to {@link GCLOUD_CONTEXTS}; order matters (first match wins), so keep the
 * catch-all default last.
 */

import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { siteGet } from "./discover.ts";

/** GCP project id of the Rose Griffon context: GOOGLE_CLOUD_PROJECT_RGFR (vault or .env), else a neutral name. */
export const ROSEGRIFFON_PROJECT = process.env.GOOGLE_CLOUD_PROJECT_RGFR ?? "rosegriffon";

export interface GcloudContext {
  /** Short id, also the gcloud configuration name. */
  readonly name: string;
  /** Substrings matched against the git remote URL (any match wins). */
  readonly remoteMatches: readonly string[];
  /** Path fragments matched against the execution directory (any match wins). */
  readonly pathMatches: readonly string[];
  readonly project: string;
  readonly projectNumber: string;
  readonly account: string;
  /** Service-account key path env var name whose value feeds GOOGLE_APPLICATION_CREDENTIALS. */
  readonly credentialsEnv: string;
  readonly region: string;
}

/** First match wins; the last entry is the catch-all default. */
export const GCLOUD_CONTEXTS: readonly GcloudContext[] = [
  {
    name: "rosegriffon",
    remoteMatches: [
      "rosegriffon",
      "aphrody-labs/rosegriffon",
      "aphrody-labs/shenron",
    ],
    pathMatches: [`${sep}apps${sep}rosegriffon`, `${sep}apps${sep}shenron`],
    project: ROSEGRIFFON_PROJECT,
    projectNumber: process.env.GOOGLE_CLOUD_PROJECT_NUMBER_RGFR ?? "",
    account: `admin-sa@${ROSEGRIFFON_PROJECT}.iam.gserviceaccount.com`,
    credentialsEnv: "GOOGLE_APPLICATION_CREDENTIALS_RGFR",
    region: "europe-west1",
  },
  {
    name: "aphrody",
    remoteMatches: ["aphrody-dev/", "aphrody-labs/"],
    pathMatches: [sep],
    project: "aphrody",
    projectNumber: process.env.APHRODY_GCP_PROJECT_NUMBER ?? siteGet("accounts.gcp_project_number") ?? "",
    account: "yolo-automation@aphrody.iam.gserviceaccount.com",
    credentialsEnv: "GOOGLE_APPLICATION_CREDENTIALS_APHRODY",
    region: "europe-west1",
  },
];

type Env = Readonly<Record<string, string | undefined>>;

/** Nearest ancestor directory that is a git repo root (holds a `.git`), or null. */
function gitRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function gitRemote(root: string): string {
  try {
    const r = Bun.spawnSync(
      ["git", "-C", root, "config", "--get", "remote.origin.url"],
      { stdin: "ignore", stderr: "ignore" },
    );
    return r.exitCode === 0 ? r.stdout.toString("utf8").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Detects the context for a directory. Precedence: the git remote URL (authoritative — a checkout
 * keeps its identity wherever it sits on disk), then the path, then the default. Always returns a
 * context because the list ends with a catch-all.
 */
export function detectContext(cwd: string = process.cwd()): GcloudContext {
  const root = gitRoot(cwd);
  const remote = root ? gitRemote(root) : "";
  const here = resolve(cwd);
  if (remote) {
    const byRemote = GCLOUD_CONTEXTS.find((c) =>
      c.remoteMatches.some((m) => remote.includes(m)),
    );
    if (byRemote) return byRemote;
  }
  const byPath = GCLOUD_CONTEXTS.find((c) =>
    c.pathMatches.some((m) => here.includes(m)),
  );
  return byPath ?? GCLOUD_CONTEXTS[GCLOUD_CONTEXTS.length - 1]!;
}

/**
 * Environment that points every Google SDK and the gcloud CLI at the detected context's project.
 * `GOOGLE_APPLICATION_CREDENTIALS` is set only when the context's key env var resolves to an existing
 * file, so a missing key degrades to Application Default Credentials instead of a dangling path.
 */
export function contextEnv(
  ctx: GcloudContext,
  env: Env = process.env,
): Record<string, string> {
  const out: Record<string, string> = {
    CLOUDSDK_ACTIVE_CONFIG_NAME: ctx.name,
    CLOUDSDK_CORE_PROJECT: ctx.project,
    CLOUDSDK_CORE_ACCOUNT: ctx.account,
    CLOUDSDK_COMPUTE_REGION: ctx.region,
    GOOGLE_CLOUD_PROJECT: ctx.project,
    GCLOUD_PROJECT: ctx.project,
    GOOGLE_CLOUD_QUOTA_PROJECT: ctx.project,
  };
  const keyPath = env[ctx.credentialsEnv] ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath && existsSync(keyPath))
    out.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
  return out;
}

/** POSIX/pwsh-free `KEY=value` export lines for `eval`-ing into a shell. */
export function exportLines(envObj: Record<string, string>): string {
  return Object.entries(envObj)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n");
}
