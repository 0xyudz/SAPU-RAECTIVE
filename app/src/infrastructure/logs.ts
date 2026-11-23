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

/**
 * Upper bound on cached log windows.
 *
 * The key contains the block range, and the ledger scans `head - 50_000 .. head`. The head
 * advances every block, so the key changes on every poll: without eviction the map grows
 * for as long as the process lives, each entry holding a full decoded log array. That is
 * what ran the server out of memory. The cache is an optimisation, not a source of truth,
 * so dropping old windows only costs a re-scan.
 */
const CACHE_MAX_ENTRIES = 32;

function remember(cacheKey: string, logs: unknown): void {
  const now = Date.now();
  cache.set(cacheKey, { at: now, logs });

  if (cache.size <= CACHE_MAX_ENTRIES) return;

  // Drop expired windows first, then the oldest insertions, until back under the bound.
  for (const [key, value] of cache) {
    if (now - value.at >= CACHE_TTL_MS) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

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

  remember(options.cacheKey, logs);
  return logs;
}

/**
 * Cache key shared by `getRawLogs` and `getDecodedLogs`.
 *
 * `args` must be part of the key: the callback lookup filters by recipient, so two
 * burners querying the same block range would otherwise collide and be served each
 * other's logs. It is serialised with sorted keys so the key is stable.
 */
function cacheKeyFor(window: {
  readonly client: PublicClient;
  readonly address: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly cacheKeySuffix: string;
  readonly event?: unknown;
  readonly args?: Record<string, unknown>;
}): string {
  const args = window.args;
  const argsKey =
    args === undefined
      ? ""
      : Object.keys(args)
          .sort()
          .map((key) => `${key}=${String(args[key])}`)
          .join(",");

  return [
    window.client.uid,
    window.address,
    window.fromBlock,
    window.toBlock,
    window.cacheKeySuffix,
    String((window.event as { name?: string } | undefined)?.name ?? ""),
    argsKey,
  ].join("|");
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
    cacheKey: cacheKeyFor(window),
    client: window.client,
    address: window.address,
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    event: window.event,
  });
}

/**
 * Typed `getLogs` for callers that want viem's decoded logs rather than `RawLog`.
 *
 * ## Why this exists next to `getRawLogs`
 *
 * `getRawLogs` returns the raw shape the ledger decoder wants, but the sweep orchestrator
 * and the callback lookup need viem's decoded `args`. Calling `client.getLogs` directly —
 * which is what they used to do — skipped every protection `scanLogs` provides, so a
 * 50,000-block lookback was sent as one request and Lasna rejected it outright
 * ("getLogs request exceeded max allowed range"). Routing through `scanLogs` means these
 * callers get the same chunking, pacing, retry and range-bisect behaviour as the ledger,
 * and the node's limit stops being something each call site has to know about.
 */
export async function getDecodedLogs<TReturn>(window: {
  readonly client: PublicClient;
  readonly address: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly cacheKeySuffix: string;
  readonly event: unknown;
  readonly args?: Record<string, unknown>;
}): Promise<TReturn[]> {
  return scanLogs<TReturn>({
    cacheKey: cacheKeyFor(window),
    client: window.client,
    address: window.address,
    fromBlock: window.fromBlock,
    toBlock: window.toBlock,
    event: window.event,
    args: window.args,
  });
}
