export type SpecId = "seo" | "aiseo" | "mwg" | "cwv" | "lh" | "wasm" | "webgpu";

export type CheckStatus = "pass" | "fail" | "warn";

export interface SpecCheck {
  id: string;
  name: string;
  description: string;
  status: CheckStatus;
  details?: string;
  metric?: string;
}

export interface SpecResult {
  specId: SpecId;
  title: string;
  score: number; // 0..100
  passed: boolean;
  checks: SpecCheck[];
  errors: string[];
}

export interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

export interface ValidationReport {
  targetPath: string;
  timestamp: string;
  allPassed: boolean;
  overallScore: number;
  specs: Record<SpecId, SpecResult>;
  summary: string;
}

export interface ValidateOptions {
  specFilter?: SpecId | "all";
  quiet?: boolean;
  json?: boolean;
  baseUrl?: string;
}

export interface WebFilesContext {
  targetPath: string;
  isSingleFile: boolean;
  htmlFiles: Array<{ path: string; relPath: string; content: string }>;
  cssFiles: Array<{
    path: string;
    relPath: string;
    content: string;
    size: number;
  }>;
  jsFiles: Array<{
    path: string;
    relPath: string;
    content: string;
    size: number;
  }>;
  wasmFiles: Array<{ path: string; relPath: string; bytes: Uint8Array }>;
  wgslFiles: Array<{ path: string; relPath: string; content: string }>;
  robotsTxt?: string;
  sitemapXml?: string;
  llmsTxt?: string;
}
