import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface MwgConfig {
  allowOriginTrials?: boolean;
  allowVolatileFeatures?: boolean;
  baseline?: string;
  [key: string]: unknown;
}

export class FeatureGateError extends Error {
  readonly gateKey: "allowOriginTrials" | "allowVolatileFeatures";

  constructor(
    message: string,
    gateKey: "allowOriginTrials" | "allowVolatileFeatures",
  ) {
    super(message);
    this.name = "FeatureGateError";
    this.gateKey = gateKey;
  }
}

export class OriginTrialGateError extends FeatureGateError {
  constructor(message: string) {
    super(message, "allowOriginTrials");
    this.name = "OriginTrialGateError";
  }
}

export class VolatileFeatureGateError extends FeatureGateError {
  constructor(message: string) {
    super(message, "allowVolatileFeatures");
    this.name = "VolatileFeatureGateError";
  }
}

export function normalizeBaselineTarget(
  raw: string | undefined,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === "widely" || trimmed === "baseline widely available")
    return "widely";
  if (
    trimmed === "newly" ||
    trimmed === "baseline" ||
    trimmed === "baseline newly available"
  )
    return "newly";
  if (trimmed === "limited" || trimmed === "limited availability")
    return "limited";
  const yearMatch = trimmed.match(/^(?:baseline\s+)?(\d{4})$/);
  if (yearMatch) return yearMatch[1];
  return undefined;
}

const CONFIG_FILENAME = ".mwgrc";

export function resolveMwgrcPath(startDir = process.cwd()): string {
  let dir = resolve(startDir);
  while (true) {
    if (
      existsSync(join(dir, CONFIG_FILENAME)) ||
      existsSync(join(dir, ".git"))
    ) {
      return join(dir, CONFIG_FILENAME);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      const homeConfig = join(homedir(), CONFIG_FILENAME);
      if (existsSync(homeConfig)) return homeConfig;
      return join(resolve(startDir), CONFIG_FILENAME);
    }
    dir = parent;
  }
}

function readMwgrcFile(filePath: string): MwgConfig {
  if (!existsSync(filePath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${CONFIG_FILENAME} at ${filePath}`);
  }
  return parsed as MwgConfig;
}

export function readMwgrc(startDir = process.cwd()): MwgConfig {
  return readMwgrcFile(resolveMwgrcPath(startDir));
}

export function writeMwgrc(
  patch: Partial<MwgConfig>,
  startDir = process.cwd(),
): string {
  const targetPath = resolveMwgrcPath(startDir);
  const existing = readMwgrcFile(targetPath);
  writeFileSync(
    targetPath,
    JSON.stringify({ ...existing, ...patch }, null, 2) + "\n",
    "utf8",
  );
  return targetPath;
}

export function formatBaselineTargetBanner(
  rawBaseline: string | undefined,
): string {
  const normalized = normalizeBaselineTarget(rawBaseline);
  if (!normalized || normalized === "widely") return "";
  if (normalized === "newly") {
    return (
      "> [!IMPORTANT]\n" +
      "> **Project Baseline Target (`.mwgrc`):** `newly` (Baseline Newly available). " +
      "Features that are Baseline Newly or Widely available satisfy this target.\n\n"
    );
  }
  if (normalized === "limited") {
    return (
      "> [!IMPORTANT]\n" +
      "> **Project Baseline Target (`.mwgrc`):** `limited` (Limited availability). " +
      "All features covered in this guide satisfy this target.\n\n"
    );
  }
  return (
    `> [!IMPORTANT]\n> **Project Baseline Target (\`.mwgrc\`):** \`Baseline ${normalized}\`. ` +
    `Features with a Baseline date of \`${normalized}-12-31\` or earlier satisfy this target.\n\n`
  );
}
