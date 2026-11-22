import type { PublicClient } from "viem";
import type { Address } from "@/domain/burner-route";

export interface DecodedLog {
  readonly blockNumber: bigint;
  readonly transactionHash: `0x${string}`;
  readonly logIndex: number;
  readonly data?: `0x${string}`;
  readonly args: Record<string, unknown>;
}

const CHUNK = 10_000n;
const MAX_PARALLEL_CHUNKS = 3;
const MAX_ATTEMPTS = 5;

const RETRYABLE =
  /429|too many requests|rate limit|exceeds defined limit|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|502|503|504|bad gateway|service unavailable/i;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(action: () => Promise<T>): Promise<T> {
  let delay = 750;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await sleep(delay);
      delay = Math.min(Math.round(delay * 2), 8_000);
    }
  }

  throw lastError;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await run(items[index]!);
    }
  });

  await Promise.all(workers);
  return out;
}

export async function getLogsChunked(params: {
  readonly client: PublicClient;
  readonly address: Address;
  readonly event: unknown;
  readonly args?: Record<string, unknown>;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}): Promise<DecodedLog[]> {
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  for (let start = params.fromBlock; start <= params.toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n > params.toBlock ? params.toBlock : start + CHUNK - 1n;
    ranges.push({ from: start, to: end });
  }

  const chunks = await mapWithConcurrency(ranges, MAX_PARALLEL_CHUNKS, ({ from, to }) =>
    withRetry(
      () =>
        params.client.getLogs({
          address: params.address,
          event: params.event,
          args: params.args,
          fromBlock: from,
          toBlock: to,
        } as never) as unknown as Promise<DecodedLog[]>,
    ),
  );

  return chunks.flat();
}
