/**
 * Transport failures that are worth retrying.
 *
 * The status codes are `\b`-delimited and must stay that way. Bare `429|502|503|504` matches
 * inside viem's error message, which embeds the request including the `to:` address — so an
 * address whose hex contains `429` (the live RSC's does) makes a permanent `TypeError`
 * ("account.signTransaction is not a function") look like a rate limit and be retried, turning a
 * one-shot programming error into six identical failures.
 *
 * The word boundaries require the digits to stand alone, so `Status: 429` still matches while a
 * hex address that contains `429` does not.
 */
const RETRYABLE =
  /\b429\b|too many requests|rate limit|exceeds defined limit|http request failed|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|\b50[234]\b|bad gateway|service unavailable|missing response/i;

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 350;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    const parts = [record.message, record.shortMessage, record.details];
    if (parts.some((part) => typeof part === "string" && RETRYABLE.test(part))) return true;
    current = record.cause;
  }
  return false;
}

export async function withRpcRetry<T>(action: () => Promise<T>): Promise<T> {
  let delay = BASE_DELAY_MS;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }

  throw lastError;
}
