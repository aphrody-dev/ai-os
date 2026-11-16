import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mwgFeatureLookup } from "../mwg-ffi";
import {
  OriginTrialGateError,
  VolatileFeatureGateError,
  formatBaselineTargetBanner,
  readMwgrc,
} from "./mwgrc";
import { defaultDataDir } from "./static-embedder";

export interface OriginTrialMetadata {
  readonly id: string;
  name?: string;
  chromestatus_url?: string;
}

export interface VolatileFeatureMetadata {
  readonly id: string;
  reason?: string;
}

export interface GuideRecord {
  id: string;
  description: string;
  category: string;
  featuresUsed: string[];
  tokenCount: number;
  originTrials?: OriginTrialMetadata[];
  volatileFeatures?: VolatileFeatureMetadata[];
  content: string;
}

export interface BaselineFeatureEntry {
  id: string;
  name: string;
  baseline: "widely" | "newly" | "limited";
  category: string;
  guides: string[];
}

let cachedGuides: GuideRecord[] | null = null;
let cachedBaseline: Record<string, BaselineFeatureEntry> | null = null;

export function loadGuides(dataDir = defaultDataDir()): GuideRecord[] {
  if (cachedGuides) return cachedGuides;
  const gzPath = join(dataDir, "gen", "guides.json.gz");
  if (!existsSync(gzPath)) {
    throw new Error(`guides.json.gz not found at ${gzPath}`);
  }
  const raw = new TextDecoder().decode(Bun.gunzipSync(readFileSync(gzPath)));
  cachedGuides = JSON.parse(raw) as GuideRecord[];
  return cachedGuides;
}

export function getUseCase(
  useCaseId: string,
  dataDir = defaultDataDir(),
): GuideRecord | undefined {
  return loadGuides(dataDir).find((g) => g.id === useCaseId);
}

export function listUseCases(
  category?: string,
  dataDir = defaultDataDir(),
): GuideRecord[] {
  const all = loadGuides(dataDir);
  if (!category) return all;
  return all.filter((g) => g.category === category);
}

export function getGuideContent(
  useCaseId: string,
  dataDir = defaultDataDir(),
): string | null {
  return getUseCase(useCaseId, dataDir)?.content ?? null;
}

export async function retrieveUseCase(
  useCaseId: string,
  options?: { cwd?: string; dataDir?: string },
): Promise<string> {
  const guide = getUseCase(useCaseId, options?.dataDir);
  if (!guide) {
    throw new Error(`No guide found for use case: ${useCaseId}`);
  }

  const config = readMwgrc(options?.cwd);
  const originTrials = guide.originTrials ?? [];
  const volatileFeatures = guide.volatileFeatures ?? [];

  if (originTrials.length > 0 && config.allowOriginTrials !== true) {
    const ids = originTrials.map((f) => f.id).join(", ");
    throw new OriginTrialGateError(
      `Origin Trial features require explicit opt-in (.mwgrc allowOriginTrials: true) for ${useCaseId}: ${ids}. Run 'wck set-allow-origin-trials' to opt in.`,
    );
  }
  if (volatileFeatures.length > 0 && config.allowVolatileFeatures !== true) {
    const ids = volatileFeatures.map((f) => f.id).join(", ");
    throw new VolatileFeatureGateError(
      `Volatile features require explicit opt-in (.mwgrc allowVolatileFeatures: true) for ${useCaseId}: ${ids}. Run 'wck set-allow-volatile-features' to opt in.`,
    );
  }

  const banner = formatBaselineTargetBanner(
    typeof config.baseline === "string" ? config.baseline : undefined,
  );
  return banner + guide.content;
}

export function loadBaselineFeatures(
  dataDir = defaultDataDir(),
): Record<string, BaselineFeatureEntry> {
  if (cachedBaseline) return cachedBaseline;
  const gzPath = join(dataDir, "features", "baseline-features.json.gz");
  if (!existsSync(gzPath)) return {};
  const raw = new TextDecoder().decode(Bun.gunzipSync(readFileSync(gzPath)));
  cachedBaseline = JSON.parse(raw) as Record<string, BaselineFeatureEntry>;
  return cachedBaseline;
}

export function lookupBaselineStatus(
  query: string,
  dataDir = defaultDataDir(),
): Array<{
  featureId: string;
  name: string;
  baseline: string;
  category: string;
  guides: string[];
  guidance?: string;
}> {
  const q = query.trim().toLowerCase();
  const map = loadBaselineFeatures(dataDir);
  const results: Array<{
    featureId: string;
    name: string;
    baseline: string;
    category: string;
    guides: string[];
    guidance?: string;
  }> = [];

  for (const [id, entry] of Object.entries(map)) {
    if (
      !q ||
      id.toLowerCase().includes(q) ||
      entry.name.toLowerCase().includes(q)
    ) {
      const nativeInfo = mwgFeatureLookup(id);
      results.push({
        featureId: id,
        name: entry.name,
        baseline:
          nativeInfo.found && nativeInfo.baseline !== "unknown"
            ? nativeInfo.baseline
            : entry.baseline,
        category: entry.category,
        guides: entry.guides,
        ...(nativeInfo.guidance ? { guidance: nativeInfo.guidance } : {}),
      });
    }
  }

  if (results.length === 0 && q) {
    const nativeInfo = mwgFeatureLookup(q);
    if (nativeInfo.found) {
      results.push({
        featureId: nativeInfo.id,
        name: nativeInfo.id.replace(/-/g, " "),
        baseline: nativeInfo.baseline,
        category: nativeInfo.category ?? "web",
        guides: [],
        guidance: nativeInfo.guidance,
      });
    }
  }

  return results.sort((a, b) => a.featureId.localeCompare(b.featureId));
}
