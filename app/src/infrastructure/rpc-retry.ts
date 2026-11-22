const RETRYABLE =
  /429|too many requests|rate limit|exceeds defined limit|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|502|503|504|bad gateway|service unavailable|missing response/i;

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
