// src/util/retry.js
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry an async operation with exponential backoff.
 * @param {() => Promise<any>} fn
 * @param {{retries?: number, baseDelayMs?: number, factor?: number, onRetry?: (attempt: number, error: Error) => void}} [options]
 */
export async function withRetry(fn, options = {}) {
  const { retries = 2, baseDelayMs = 200, factor = 2, onRetry } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (onRetry) onRetry(attempt + 1, lastError);
      if (attempt < retries) await sleep(baseDelayMs * factor ** attempt);
    }
  }
  throw lastError;
}
