import { openKnowledgeDatabase } from "../db/sqlite.ts";
import { getSecretKeyValue, redactSecretsFromText } from "../env/safe-env.ts";
import { blake3Hex } from "../ffi/blake3.ts";

export const CONTEXT7_DEFAULT_BASE_URL = "https://context7.com/api/v2";
export const CONTEXT7_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface Context7LibraryCandidate {
  id: string;
  title: string;
  description: string;
  branch?: string;
  lastUpdateDate?: string;
  totalTokens?: number;
  totalSnippets?: number;
  trustScore?: number;
  versions?: string[];
}

export interface Context7SearchResult {
  libraryName: string;
  query: string;
  cached: boolean;
  cacheKey: string;
  results: Context7LibraryCandidate[];
}

export interface Context7CitationChunk {
  title: string;
  sourceUrl: string;
  snippet: string;
  fingerprint: string;
}

export interface Context7DocsResult {
  libraryId: string;
  query: string;
  version?: string;
  cached: boolean;
  cacheKey: string;
  rawText: string;
  chunks: Context7CitationChunk[];
}

export interface Context7ClientOptions {
  dbPath?: string;
  baseUrl?: string;
  envPath?: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  bypassCache?: boolean;
}

interface CacheRow {
  response_json: string;
  expires_at_ms: number;
}

function readCache<T>(
  dbPath: string | undefined,
  cacheKey: string,
  nowMs = Date.now(),
): T | null {
  const db = openKnowledgeDatabase(dbPath);
  const row = db
    .prepare<CacheRow, [string]>(
      "SELECT response_json, expires_at_ms FROM context7_cache WHERE cache_key = ?",
    )
    .get(cacheKey);
  if (!row || row.expires_at_ms <= nowMs) {
    return null;
  }
  try {
    return JSON.parse(row.response_json) as T;
  } catch {
    return null;
  }
}

function writeCache(
  dbPath: string | undefined,
  params: {
    cacheKey: string;
    endpointKind: "libs_search" | "context_docs";
    libraryId: string;
    queryText: string;
    payload: unknown;
    ttlMs: number;
  },
): void {
  const db = openKnowledgeDatabase(dbPath);
  const nowMs = Date.now();
  const expiresAtMs = nowMs + params.ttlMs;
  const serialized = redactSecretsFromText(JSON.stringify(params.payload));
  db.prepare(
    `INSERT INTO context7_cache (
      cache_key, endpoint_kind, library_id, query_text, response_json, created_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      response_json = excluded.response_json,
      created_at_ms = excluded.created_at_ms,
      expires_at_ms = excluded.expires_at_ms`,
  ).run(
    params.cacheKey,
    params.endpointKind,
    params.libraryId,
    params.queryText,
    serialized,
    nowMs,
    expiresAtMs,
  );
}

/**
 * Parses Context7 `type=txt` Markdown output (`### Title\n\nSource: https://...\n\n...`)
 * into structured citation chunks with canonical URLs and Blake3 content fingerprints.
 */
export function parseContext7TextChunks(
  rawText: string,
  fallbackLibraryId: string,
): Context7CitationChunk[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const blocks = trimmed.split(/\n(?=###\s+)|(?:\r?\n---+\r?\n)/g);
  const chunks: Context7CitationChunk[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    const lines = block.split(/\r?\n/);
    let title = fallbackLibraryId;
    let bodyStart = 0;

    if (lines[0]?.startsWith("### ")) {
      title = lines[0].slice(4).trim();
      bodyStart = 1;
    } else if (lines[0]?.startsWith("TITLE:")) {
      title = lines[0].slice(6).trim();
      bodyStart = 1;
    }

    let sourceUrl = `https://context7.com${fallbackLibraryId.startsWith("/") ? fallbackLibraryId : `/${fallbackLibraryId}`}`;
    for (let i = bodyStart; i < Math.min(lines.length, bodyStart + 6); i++) {
      const m = lines[i]!.match(/^(?:Source|SOURCE):\s*(https?:\/\/\S+)/i);
      if (m?.[1]) {
        sourceUrl = m[1].trim();
        break;
      }
    }

    const snippet = redactSecretsFromText(block);
    chunks.push({
      title,
      sourceUrl,
      snippet,
      fingerprint: blake3Hex(`${sourceUrl}\n${snippet}`),
    });
  }

  return chunks;
}

/**
 * Searches Context7 v2 `/libs/search` for official upstream library IDs and metadata,
 * caching responses in `C:\aphrody\var\knowledge.sqlite` keyed by Blake3 digest (TTL 24h).
 */
export async function searchLibraries(
  libraryName: string,
  query = "",
  options: Context7ClientOptions = {},
): Promise<Context7SearchResult> {
  const normLib = libraryName.trim();
  const normQuery = (query || normLib).trim();
  const cacheKey = blake3Hex(
    `ctx7:v2:search:${normLib.toLowerCase()}:${normQuery.toLowerCase()}`,
  );

  if (!options.bypassCache) {
    const hit = readCache<Context7LibraryCandidate[]>(options.dbPath, cacheKey);
    if (hit) {
      return {
        libraryName: normLib,
        query: normQuery,
        cached: true,
        cacheKey,
        results: hit,
      };
    }
  }

  const baseUrl = options.baseUrl ?? CONTEXT7_DEFAULT_BASE_URL;
  const fetchFn = options.fetchImpl ?? fetch;
  const apiKey = getSecretKeyValue("CTX7_API_KEY", options.envPath);

  const url = new URL(`${baseUrl}/libs/search`);
  url.searchParams.set("libraryName", normLib);
  url.searchParams.set("query", normQuery);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchFn(url.toString(), { method: "GET", headers });
  if (!res.ok) {
    throw new Error(`Context7 libs/search HTTP ${res.status} for "${normLib}"`);
  }

  const data = (await res.json()) as {
    results?: Array<Record<string, unknown>>;
    libraries?: Array<Record<string, unknown>>;
  };
  const rawList = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.libraries)
      ? data.libraries
      : [];

  const results: Context7LibraryCandidate[] = rawList
    .map((item) => ({
      id: String(item.id ?? ""),
      title: String(item.title ?? normLib),
      description: redactSecretsFromText(String(item.description ?? "")),
      branch: typeof item.branch === "string" ? item.branch : undefined,
      lastUpdateDate:
        typeof item.lastUpdateDate === "string"
          ? item.lastUpdateDate
          : undefined,
      totalTokens:
        typeof item.totalTokens === "number" ? item.totalTokens : undefined,
      totalSnippets:
        typeof item.totalSnippets === "number" ? item.totalSnippets : undefined,
      trustScore:
        typeof item.trustScore === "number" ? item.trustScore : undefined,
      versions: Array.isArray(item.versions)
        ? item.versions.map((v) => String(v))
        : undefined,
    }))
    .filter((r) => r.id.length > 0);

  writeCache(options.dbPath, {
    cacheKey,
    endpointKind: "libs_search",
    libraryId: normLib,
    queryText: normQuery,
    payload: results,
    ttlMs: options.ttlMs ?? CONTEXT7_CACHE_TTL_MS,
  });

  return {
    libraryName: normLib,
    query: normQuery,
    cached: false,
    cacheKey,
    results,
  };
}

/**
 * Fetches official library documentation snippets from Context7 v2 `/context?type=txt`,
 * returning structured citation chunks with source URLs and library version metadata.
 */
export async function getLibraryDocs(
  libraryId: string,
  query: string,
  tokens = 4000,
  options: Context7ClientOptions = {},
): Promise<Context7DocsResult> {
  const normId = libraryId.trim().startsWith("/")
    ? libraryId.trim()
    : `/${libraryId.trim()}`;
  const normQuery = query.trim();
  const cacheKey = blake3Hex(
    `ctx7:v2:context:${normId.toLowerCase()}:${normQuery.toLowerCase()}:${tokens}`,
  );

  if (!options.bypassCache) {
    const hit = readCache<{
      rawText: string;
      version?: string;
      chunks: Context7CitationChunk[];
    }>(options.dbPath, cacheKey);
    if (hit) {
      return {
        libraryId: normId,
        query: normQuery,
        version: hit.version,
        cached: true,
        cacheKey,
        rawText: hit.rawText,
        chunks: hit.chunks,
      };
    }
  }

  const baseUrl = options.baseUrl ?? CONTEXT7_DEFAULT_BASE_URL;
  const fetchFn = options.fetchImpl ?? fetch;
  const apiKey = getSecretKeyValue("CTX7_API_KEY", options.envPath);

  const url = new URL(`${baseUrl}/context`);
  url.searchParams.set("libraryId", normId);
  url.searchParams.set("query", normQuery);
  url.searchParams.set("type", "txt");
  if (tokens > 0) {
    url.searchParams.set("tokens", String(tokens));
  }

  const headers: Record<string, string> = {
    Accept: "text/plain, application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchFn(url.toString(), { method: "GET", headers });
  if (!res.ok) {
    throw new Error(`Context7 context HTTP ${res.status} for "${normId}"`);
  }

  const rawBody = redactSecretsFromText(await res.text());
  const versionMatch = normId.match(/^\/[^/]+\/[^/]+\/([^/]+)$/);
  const version =
    versionMatch?.[1] ?? res.headers.get("x-context7-version") ?? undefined;
  const chunks = parseContext7TextChunks(rawBody, normId);

  writeCache(options.dbPath, {
    cacheKey,
    endpointKind: "context_docs",
    libraryId: normId,
    queryText: normQuery,
    payload: { rawText: rawBody, version, chunks },
    ttlMs: options.ttlMs ?? CONTEXT7_CACHE_TTL_MS,
  });

  return {
    libraryId: normId,
    query: normQuery,
    version,
    cached: false,
    cacheKey,
    rawText: rawBody,
    chunks,
  };
}
