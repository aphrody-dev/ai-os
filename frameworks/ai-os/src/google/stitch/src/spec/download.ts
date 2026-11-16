// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { schema, check } from "./validate.js";
import type { StitchToolClientSpec } from "./client.js";

// ── Input ──────────────────────────────────────────────────────────────────────

export type DownloadAssetsInput = {
  projectId: string;
  outputDir: string;
  fileMode?: number | undefined;
  tempDir?: string | undefined;
  assetsSubdir?: string | undefined;
};
/** Type passed by callers — fields with defaults (fileMode, assetsSubdir) are optional. */
/** Fully-resolved input after schema.parse() — all fields present. */
export type DownloadAssetsInputParsed = {
  projectId: string;
  outputDir: string;
  fileMode: number;
  tempDir?: string | undefined;
  assetsSubdir: string;
};
export const DownloadAssetsInputSchema = schema<DownloadAssetsInputParsed>(
  (v) => ({
    projectId: check.str(v.projectId, "projectId", 1),
    outputDir: check.str(v.outputDir, "outputDir", 1),
    fileMode:
      v.fileMode === undefined ? 0o600 : check.int(v.fileMode, "fileMode"),
    ...(v.tempDir !== undefined && {
      tempDir: check.str(v.tempDir, "tempDir"),
    }),
    assetsSubdir:
      v.assetsSubdir === undefined
        ? "assets"
        : check.str(v.assetsSubdir, "assetsSubdir"),
  }),
);

// ── Error Codes ────────────────────────────────────────────────────────────────

export const DownloadAssetsErrorCode = {
  options: [
    "PROJECT_NOT_FOUND",
    "FETCH_FAILED",
    "WRITE_FAILED",
    "PATH_TRAVERSAL_ATTEMPT",
    "UNKNOWN_ERROR",
  ] as const,
};
export type DownloadAssetsErrorCode =
  (typeof DownloadAssetsErrorCode.options)[number];

// ── Result ─────────────────────────────────────────────────────────────────────

export interface DownloadedScreenTrace {
  screenId: string;
  screenSlug: string;
  filePath: string;
}

export type DownloadAssetsResult =
  | {
      success: true;
      downloadedScreens: DownloadedScreenTrace[];
      warnings?: string[];
    }
  | {
      success: false;
      error: {
        code: DownloadAssetsErrorCode;
        message: string;
        recoverable: boolean;
      };
    };

// ── Interface ──────────────────────────────────────────────────────────────────

/**
 * Contract for the downloadAssets operation.
 * Implementations must never throw — all failures return DownloadAssetsResult.
 */
export interface DownloadAssetsSpec {
  execute(input: DownloadAssetsInput): Promise<DownloadAssetsResult>;
}

// ── Public Output ─────────────────────────────────────────────────────────────

/** Return type for Project.downloadAssets(). */
export interface DownloadAssetsOutput {
  screens: DownloadedScreenTrace[];
  warnings: string[];
}
