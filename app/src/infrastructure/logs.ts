import type { PublicClient } from "viem";
import type { Address } from "@/domain/burner-route";

export interface DecodedLog {
  readonly blockNumber: bigint;
  readonly transactionHash: `0x${string}`;
  readonly logIndex: number;
  readonly data?: `0x${string}`;
  readonly args: Record<string, unknown>;
}

export interface RawLog {
  readonly blockNumber: bigint;
  readonly transactionHash: `0x${string}`;
  readonly logIndex: number;
  readonly topics: readonly `0x${string}`[];
  readonly data: `0x${string}`;
}

const SPAN = 500_000n;
const MAX_ATTEMPTS = 4;
const MIN_GAP_MS = 120;
const COOLDOWN_MS = 1_500;
const CACHE_TTL_MS = 20_000;

const RETRYABLE =
  /429|too many requests|rate limit|exceeds defined limit|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|502|503|504|bad gateway|service unavailable/i;

const RANGE_LIMIT =
  /block range|range is too large|too many blocks|query returned more than|exceeds the block range|range too wide|max block range|block range limit|exceeded max allowed range|exceeds max allowed range|max allowed range/i;

function matches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    const parts = [record.message, record.shortMessage, record.details];
    if (parts.some((part) => typeof part === "string" && pattern.test(part))) return true;
    current = record.cause;
  }
  return false;
}

function isRetryable(error: unknown): boolean {
  return matches(error, RETRYABLE);
}

function isRangeLimit(error: unknown): boolean {
  return matches(error, RANGE_LIMIT);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Gate {
  tail: Promise<void>;
  lastAt: number;
}

const gates = new Map<string, Gate>();

function gateFor(key: string): Gate {
  let gate = gates.get(key);
  if (!gate) {
    gate = { tail: Promise.resolve(), lastAt: 0 };
    gates.set(key, gate);
  }
  return gate;
}

async function rateLimited<T>(key: string, action: () => Promise<T>): Promise<T> {
  const gate = gateFor(key);
  const run = gate.tail.then(async () => {
    const wait = gate.lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await action();
    } finally {
      gate.lastAt = Date.now();
    }
  });
  gate.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const cache = new Map<string, { readonly at: number; readonly logs: unknown }>();

type Fetch<T> = (from: bigint, to: bigint) => Promise<T[]>;

async function withRetry<T>(fetch: Fetch<T>, from: bigint, to: bigint): Promise<T[]> {
  let delay = 900;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(from, to);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await sleep(COOLDOWN_MS + delay);
      delay = Math.min(delay * 2, 6_000);
    }
  }

  throw lastError;
}

async function collect<T>(
  gateKey: string,
  fetch: Fetch<T>,
  from: bigint,
  to: bigint,
): Promise<T[]> {
  try {
    return await rateLimited(gateKey, () => withRetry(fetch, from, to));
  } catch (error) {
    if (from === to || !isRangeLimit(error)) throw error;
    const mid = from + (to - from) / 2n;
    return [
      ...(await collect(gateKey, fetch, from, mid)),
      ...(await collect(gateKey, fetch, mid + 1n, to)),
    ];
  }
}

async function scan<T>(gateKey: string, fetch: Fetch<T>, fromBlock: bigint, toBlock: bigint): Promise<T[]> {
  const out: T[] = [];
  for (let start = fromBlock; start <= toBlock; start += SPAN) {
    const end = start + SPAN - 1n > toBlock ? toBlock : start + SPAN - 1n;
    out.push(...(await collect(gateKey, fetch, start, end)));
  }
  return out;
}

async function scanLogs<T>(options: {
  readonly cacheKey: string;
  readonly client: PublicClient;
  readonly address: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly event?: unknown;
  readonly args?: Record<string, unknown>;
}): Promise<T[]> {
  const hit = cache.get(options.cacheKey);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.logs as T[];

  const logs = await scan<T>(options.client.uid, async (from, to) => {
    const request = {
      address: options.address,
      event: options.event,
      args: options.args,
      fromBlock: from,
      toBlock: to,
    };
    return (await options.client.getLogs(request as never)) as unknown as T[];
  }, options.fromBlock, options.toBlock);

  cache.set(options.cacheKey, { at: Date.now(), logs });
  return logs;
}

export async function getRawLogs(window: {
  readonly client: PublicClient;
  readonly address: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly cacheKeySuffix: string;
  readonly event?: unknown;
}): Promise<RawLog[]> {
  return scanLogs<RawLog>({
    cacheKey: [
      window.client.uid,
      window.address,
      window.fromBlock,
      window.toBlock,
      window.cacheKeySuffix,
      String((window.event as { name?: string } | undefined)?.name ?? ""),
    ].join("|"),
    client: window.client,
    address: window.address,
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    event: window.event,
  });
}
