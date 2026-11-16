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
import { DEFAULT_STITCH_API_URL } from "../constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. INPUT SCHEMA - What the client receives for configuration
// ─────────────────────────────────────────────────────────────────────────────
export type StitchRetry =
  false | { attempts: number; baseMs: number; maxMs: number };
export type StitchConfig = {
  /** API key for simple API access. Falls back to STITCH_API_KEY. */
  apiKey?: string | undefined;
  /** OAuth access token for user-authenticated requests. Falls back to STITCH_ACCESS_TOKEN. */
  accessToken?: string | undefined;
  /** Google Cloud project ID. Required for OAuth, optional for API Key. Falls back to STITCH_PROJECT_ID, then GOOGLE_CLOUD_PROJECT. */
  projectId?: string | undefined;
  /** Base URL for the Stitch MCP server. Falls back to STITCH_BASE_URL (legacy alias STITCH_HOST). */
  baseUrl: string;
  /** Request timeout in milliseconds. Default: 300000 (5 min). */
  timeout: number;
  /** Additional HTTP headers merged case-insensitively onto outbound MCP and REST requests. */
  headers?: Record<string, string> | undefined;
  /** Identity-map toggle (default true). */
  entityCache: boolean;
  /** Retry policy for RATE_LIMITED failures on idempotent reads (get_* / list_*); false disables. */
  retry: StitchRetry;
};
/** Input type for StitchConfig - fields with defaults are optional */
export type StitchConfigInput = {
  apiKey?: string | undefined;
  accessToken?: string | undefined;
  projectId?: string | undefined;
  baseUrl?: string | undefined;
  timeout?: number | undefined;
  headers?: Record<string, string> | undefined;
  entityCache?: boolean | undefined;
  retry?:
    false | { attempts?: number; baseMs?: number; maxMs?: number } | undefined;
};

export const StitchConfigSchema = schema<StitchConfig>((v) => {
  const opt = (x: unknown, p: string) =>
    x === undefined ? undefined : check.str(x, p);
  let retry: StitchRetry = { attempts: 3, baseMs: 250, maxMs: 4000 };
  if (v.retry === false) retry = false;
  else if (v.retry !== undefined) {
    const r = check.obj(v.retry, "retry");
    const extra = Object.keys(r).filter(
      (k) => !["attempts", "baseMs", "maxMs"].includes(k),
    );
    if (extra.length)
      check.fail("retry", `no unrecognized keys (${extra.join(", ")})`);
    const attempts =
      r.attempts === undefined ? 3 : check.int(r.attempts, "retry.attempts");
    if (attempts < 1 || attempts > 10) check.fail("retry.attempts", "1..10");
    retry = {
      attempts,
      baseMs:
        r.baseMs === undefined ? 250 : check.num(r.baseMs, "retry.baseMs"),
      maxMs: r.maxMs === undefined ? 4000 : check.num(r.maxMs, "retry.maxMs"),
    };
  }
  const out: StitchConfig = {
    apiKey: opt(v.apiKey, "apiKey"),
    accessToken: opt(v.accessToken, "accessToken"),
    projectId: opt(v.projectId, "projectId"),
    baseUrl:
      v.baseUrl === undefined
        ? DEFAULT_STITCH_API_URL
        : check.str(v.baseUrl, "baseUrl"),
    timeout:
      v.timeout === undefined ? 300_000 : check.num(v.timeout, "timeout"),
    headers:
      v.headers === undefined
        ? undefined
        : check.strRecord(v.headers, "headers"),
    entityCache:
      v.entityCache === undefined
        ? true
        : check.bool(v.entityCache, "entityCache"),
    retry,
  };
  if (!out.apiKey && !(out.accessToken && out.projectId))
    check.fail(
      "",
      "Invalid configuration: provide either 'apiKey' OR ('accessToken' + 'projectId').",
      true,
    );
  return out;
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. OUTPUT SCHEMAS - What the client produces
// ─────────────────────────────────────────────────────────────────────────────
export type ToolResult = {
  success: boolean;
  data?: unknown;
  error?: string | undefined;
};

export type Tools = {
  tools: Array<{
    name: string;
    description?: string | undefined;
    inputSchema?: unknown;
  }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. BEHAVIOR INTERFACE - The contract
// ─────────────────────────────────────────────────────────────────────────────
export interface StitchToolClientSpec {
  name: "stitch-tool-client";
  description: "Authenticated tool pipe for Stitch MCP Server";

  /**
   * Identity-map manager. ALL entity instances (Project, Screen, ...)
   * must be obtained through entities.resolve — never constructed
   * directly — so reference keys are hydrated and instances deduplicated.
   */
  entities: import("../entity-manager.js").EntityManager;

  /**
   * Validate configuration and establish connection.
   * MUST handle auth header injection based on config.
   * - API Key: Inject `X-Goog-Api-Key` header.
   * - OAuth: Inject `Authorization: Bearer` and `X-Goog-User-Project` headers.
   */
  connect: () => Promise<void>;

  /**
   * Call a tool on the MCP server.
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns Parsed tool result
   */
  callTool: <T>(name: string, args: Record<string, unknown>) => Promise<T>;

  /**
   * Get available tools from the server.
   */
  listTools: () => Promise<Tools>;

  /**
   * Make a direct REST POST to the Stitch API.
   * Used for endpoints not available as MCP tools (e.g. BatchCreateScreens).
   * Throws StitchError on HTTP error responses.
   */
  httpPost: <T>(path: string, body: unknown) => Promise<T>;

  /**
   * Close the connection.
   */
  close: () => Promise<void>;
}

export interface VirtualToolDefinition {
  name: string;
  description: string;
  source?: string;
  inputSchema: any;
  execute: (client: StitchToolClientSpec, args: any) => Promise<any>;
}
