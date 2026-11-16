// Extracted from third_party/vercel-ai (Apache-2.0):
// - packages/ai/src/util/retry-with-exponential-backoff.ts
// - packages/provider/src/errors/api-call-error.ts

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function getRetryDelayInMs(
  headers: Headers | Record<string, string> | undefined,
  exponentialBackoffDelay: number,
): number {
  if (!headers) return exponentialBackoffDelay;
  const get = (k: string) =>
    headers instanceof Headers ? headers.get(k) : headers[k];
  let ms: number | undefined;
  const retryAfterMs = get("retry-after-ms");
  if (retryAfterMs) {
    const parsed = parseFloat(retryAfterMs);
    if (!Number.isNaN(parsed)) ms = parsed;
  }
  const retryAfter = get("retry-after");
  if (retryAfter && ms === undefined) {
    const seconds = parseFloat(retryAfter);
    if (!Number.isNaN(seconds)) ms = seconds * 1000;
    else ms = Date.parse(retryAfter) - Date.now();
  }
  if (
    ms !== undefined &&
    !Number.isNaN(ms) &&
    ms >= 0 &&
    (ms < 60_000 || ms < exponentialBackoffDelay)
  )
    return ms;
  return exponentialBackoffDelay;
}

export class RetryableHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers?: Headers,
  ) {
    super(message);
  }
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number;
    initialDelayInMs?: number;
    backoffFactor?: number;
    signal?: AbortSignal;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const initial = opts.initialDelayInMs ?? 1000;
  const factor = opts.backoffFactor ?? 2;
  const shouldRetry =
    opts.shouldRetry ??
    ((e) => e instanceof RetryableHttpError && isRetryableStatus(e.status));
  let attempt = 0;
  while (true) {
    opts.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error)) throw error;
      const exp = initial * factor ** attempt++;
      const headers =
        error instanceof RetryableHttpError ? error.headers : undefined;
      const delay = getRetryDelayInMs(headers, exp);
      await Bun.sleep(delay);
    }
  }
}
