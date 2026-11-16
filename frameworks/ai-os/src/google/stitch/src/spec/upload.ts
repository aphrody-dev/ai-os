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
import type { Screen } from "../screen-ext.js";

// ── Supported MIME types ───────────────────────────────────────────────────────

/**
 * File extensions supported by BatchCreateScreens and their MIME types.
 * The check is done in the handler (not as a Zod refinement) so failures
 * produce a typed UploadImageErrorCode instead of a generic ZodError.
 */
export const SUPPORTED_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".html": "text/html",
  ".htm": "text/html",
} as const;

export type SupportedExtension = keyof typeof SUPPORTED_MIME_TYPES;

// ── Input ──────────────────────────────────────────────────────────────────────

export type UploadInput = {
  filePath: string;
  title?: string | undefined;
  createScreenInstances: boolean;
};
export const UploadInputSchema = schema<UploadInput>((v) => ({
  filePath: check.str(v.filePath, "filePath", 1),
  ...(v.title !== undefined && { title: check.str(v.title, "title") }),
  createScreenInstances:
    v.createScreenInstances === undefined
      ? true
      : check.bool(v.createScreenInstances, "createScreenInstances"),
}));

// ── Error Codes ────────────────────────────────────────────────────────────────

export const UploadErrorCode = {
  options: [
    "FILE_NOT_FOUND",
    "UNSUPPORTED_FORMAT",
    "UPLOAD_FAILED",
    "AUTH_FAILED",
    "UNKNOWN_ERROR",
  ] as const,
};
export type UploadErrorCode = (typeof UploadErrorCode.options)[number];

// ── Result ─────────────────────────────────────────────────────────────────────

export type UploadResult =
  | { success: true; screens: Screen[] }
  | {
      success: false;
      error: {
        code: UploadErrorCode;
        message: string;
        recoverable: boolean;
      };
    };

// ── Interface ──────────────────────────────────────────────────────────────────

/**
 * Contract for the upload operation.
 * Implementations must never throw — all failures return UploadResult.
 */
export interface UploadSpec {
  execute(projectId: string, input: UploadInput): Promise<UploadResult>;
}
