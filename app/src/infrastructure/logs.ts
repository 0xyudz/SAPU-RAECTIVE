import type { PublicClient } from "viem";
import type { Address } from "@/domain/burner-route";
import { logChunkBlocks } from "@/config/log-ranges";
import { chainIdForClient } from "./rpc-clients";

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

const MAX_ATTEMPTS = 4;
const MIN_GAP_MS = 120;
const COOLDOWN_MS = 1_500;

/**
 * How far behind the window tip a chunk must end before it is treated as immutable.
 *
 * A chunk inside this distance can still be reorged, so it is cached only briefly; anything
 * older is history and is cached for minutes. 64 blocks is comfortably deeper than the
 * shallow reorgs these chains produce.
 */
const SETTLED_DEPTH = 64n;

/** A chunk near the tip changes; re-read it often. */
const TIP_TTL_MS = 5_000;

/**
 * A settled chunk cannot change, so it is worth keeping.
 *
 * The ledger scans a 50,000-block lookback and the route index scans from the deploy block —
 * on the live deployment that is a 776,515-block window. With a per-window cache every poll
 * was a cache miss, because the window's own bounds slide with the head: the app re-fetched
 * ~776k blocks of logs every 15 seconds to learn that one block had been added. Caching per
 * *chunk* turns that into "fetch the one chunk that changed", which is what these TTLs are
 * for.
 */
const SETTLED_TTL_MS = 600_000;

/**
 * Transport failures worth retrying.
 *
 * The status codes are `\b`-delimited for the reason documented in `rpc-retry.ts`: a bare `429`
 * also matches the hex of an address inside viem's error message, which made permanent errors
 * look like rate limits.
 */
const RETRYABLE =
  /\b429\b|too many requests|rate limit|exceeds defined limit|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|\b50[234]\b|bad gateway|service unavailable/i;

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
  /** Resolves when the next request may start. Chained so starts stay spaced. */
  nextStart: Promise<void>;
  lastAt: number;
}

const gates = new Map<string, Gate>();

function gateFor(key: string): Gate {
  let gate = gates.get(key);
  if (!gate) {
    gate = { nextStart: Promise.resolve(), lastAt: 0 };
    gates.set(key, gate);
  }
  return gate;
}

/**
 * Spaces request *starts* by `MIN_GAP_MS` without serialising the requests themselves.
 *
 * The first version chained the whole request onto `gate.tail`, so a second caller waited for
 * the first to finish rather than merely to start. That silently defeated the concurrency limit
 * above it — two slots were granted and only one was ever used. Pacing is about the rate at
 * which requests leave, not about holding the next one until the previous response arrives.
 */
async function pace(key: string): Promise<void> {
  const gate = gateFor(key);
  const start = gate.nextStart.then(async () => {
    const wait = gate.lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    gate.lastAt = Date.now();
  });
  gate.nextStart = start.catch(() => undefined);
  return start;
}

/**
 * Per-chain limit on requests in flight at once.
 *
 * ## Why two, and why measured
 *
 * The cold ledger build was 34.6 s, and almost all of it was *waiting*: each chunk request
 * takes 0.75–3.4 s of network time, and the scan issued them strictly one at a time. Raising
 * concurrency helps, but not without bound — the same endpoints answer differently under load:
 *
 *   Base Sepolia, 100k-block token scan:  1 request 1386 ms | 2 → 811 ms | 4 → 1504 ms | 8 → 2915 ms
 *   Lasna, 30k-block system-contract scan: 1 request 3488 ms | 2 → 3930 ms (no gain)
 *
 * So two is the value that helps where it helps and costs nothing where it does not. It is not
 * a guess at what a provider tolerates: Base Sepolia's gateway is known to 429 on bursts of
 * concurrent `eth_call`, and four requests already doubled the latency, which is the shape of a
 * server queueing rather than serving. Being deliberately modest here is what keeps the retry
 * path — and therefore the user-visible latency — from becoming the failure mode.
 */
const MAX_IN_FLIGHT = 2;

interface InFlight {
  active: number;
  readonly waiting: Array<() => void>;
}

const inFlight = new Map<string, InFlight>();

async function acquire(key: string): Promise<void> {
  let state = inFlight.get(key);
  if (state === undefined) {
    state = { active: 0, waiting: [] };
    inFlight.set(key, state);
  }
  if (state.active < MAX_IN_FLIGHT) {
    state.active += 1;
    return;
  }
  await new Promise<void>((resolve) => state!.waiting.push(resolve));
  state.active += 1;
}

function release(key: string): void {
  const state = inFlight.get(key);
  if (state === undefined) return;
  state.active -= 1;
  const next = state.waiting.shift();
  if (next !== undefined) next();
}

/** Paces and limits one request: at most `MAX_IN_FLIGHT` per chain, `MIN_GAP_MS` between starts. */
async function requestSlot<T>(key: string, action: () => Promise<T>): Promise<T> {
  await acquire(key);
  try {
    await pace(key);
    return await action();
  } finally {
    release(key);
  }
}

interface CacheEntry {
  readonly at: number;
  /** True when the chunk ended far enough behind the window tip to be treated as immutable. */
  readonly settled: boolean;
  readonly logs: unknown;
}

const cache = new Map<string, CacheEntry>();

/**
 * Upper bound on cached chunks.
 *
 * The key contains the block range, so a sliding window creates new keys forever. The bound
 * matters because each entry holds a decoded log array: without it this map grew for the life
 * of the process and eventually exhausted the server heap. It is larger than the old
 * window-level bound because the entries are now per chunk rather than per whole window, so
 * the same memory holds a far finer-grained index — and because dropping a chunk only costs
 * one re-fetch of that chunk, not of the entire window.
 */
const CACHE_MAX_ENTRIES = 256;

function remember(cacheKey: string, logs: unknown, settled: boolean): void {
  const now = Date.now();
  cache.set(cacheKey, { at: now, settled, logs });

  if (cache.size <= CACHE_MAX_ENTRIES) return;

  // Drop expired entries first, then the oldest insertions, until back under the bound.
  for (const [key, value] of cache) {
    const ttl = value.settled ? SETTLED_TTL_MS : TIP_TTL_MS;
    if (now - value.at >= ttl) cache.delete(key);
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

/**
 * Chunk size learned from a node that rejected the configured one.
 *
 * `config/log-ranges.ts` holds the measured caps, but a provider can be tighter than anything
 * recorded there. When that happens the node's own rejection is the only reliable signal, so
 * the working size is halved and remembered for the rest of the process. Without this the
 * shrink would be rediscovered on every scan, which is the cost this module exists to remove.
 */
const learnedChunks = new Map<number | null, bigint>();

function chunkFor(chainId: number | null): bigint {
  const learned = learnedChunks.get(chainId);
  const configured = logChunkBlocks(chainId);
  return learned === undefined || learned >= configured ? configured : learned;
}

function learnSmallerChunk(chainId: number | null, next: bigint): void {
  const current = chunkFor(chainId);
  if (next < current) learnedChunks.set(chainId, next);
}

/** Largest multiple of `chunk` at or below `block`, so chunk bounds do not move with the head. */
function alignDown(block: bigint, chunk: bigint): bigint {
  return (block / chunk) * chunk;
}

function chunkKeyFor(window: {
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

interface WindowRequest<T> {
  readonly client: PublicClient;
  readonly address: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly cacheKeySuffix: string;
  readonly event?: unknown;
  readonly args?: Record<string, unknown>;
  /** Narrowing hook so tests can assert the request shape the node actually receives. */
  readonly fetch: Fetch<T>;
}

/**
 * Reads every chunk covering the window, reusing cached chunks.
 *
 * ## Why the chunk bounds are absolute, not relative to the window
 *
 * The scan used to walk `fromBlock, fromBlock + SPAN, …`, so every bound was a function of the
 * caller's window. Since the ledger's window is `head - 50_000 .. head`, the head advancing by
 * one block changed *every* chunk key and the cache never hit. Aligning chunks to multiples of
 * the chunk size makes the bounds a property of the chain instead: as the window slides, only
 * the chunk it enters is new.
 *
 * The window is still honoured exactly — the first aligned chunk may start before `fromBlock`,
 * and logs below it are dropped after decoding. Aligning is a cache decision; it must not
 * silently widen the range the caller asked about.
 *
 * ## Why the chunks are fetched concurrently
 *
 * The requests are independent, and a cold build issues a dozen of them. Issuing them one at a
 * time made the build the sum of every request's network latency. `requestSlot` bounds how many
 * may be in flight per chain, so this is parallel without becoming a burst.
 *
 * Results are reassembled in chunk order, not completion order: the callers sort by block
 * anyway, but returning a stable order keeps a scan's output independent of network timing.
 */
async function scanWindow<T>(request: WindowRequest<T>, chunk: bigint): Promise<T[]> {
  const chunks: Array<{ start: bigint; end: bigint }> = [];
  const first = alignDown(request.fromBlock, chunk);
  for (let start = first; start <= request.toBlock; start += chunk) {
    const end = start + chunk - 1n > request.toBlock ? request.toBlock : start + chunk - 1n;
    chunks.push({ start, end });
  }

  const results = await Promise.all(
    chunks.map(async ({ start, end }) => {
      const key = chunkKeyFor({
        client: request.client,
        address: request.address,
        fromBlock: start,
        toBlock: end,
        cacheKeySuffix: request.cacheKeySuffix,
        event: request.event,
        args: request.args,
      });

      const settled = end + SETTLED_DEPTH < request.toBlock;
      const hit = cache.get(key);
      if (hit !== undefined && Date.now() - hit.at < (hit.settled ? SETTLED_TTL_MS : TIP_TTL_MS)) {
        return hit.logs as T[];
      }

      const logs = await requestSlot(request.client.uid, () =>
        withRetry(request.fetch, start, end),
      );
      remember(key, logs, settled);
      return logs;
    }),
  );

  // The aligned first chunk can reach back before the requested window. Drop what the caller
  // did not ask for, so aligning chunks never changes the result set.
  return results.flat().filter((log) => {
    const blockNumber = (log as { blockNumber?: bigint }).blockNumber;
    return blockNumber === undefined || blockNumber >= request.fromBlock;
  });
}

/**
 * Scans a window, shrinking the chunk when a node rejects it as too large.
 *
 * A rejected chunk is not a failure: it is the node telling us its actual limit. The scan is
 * restarted with half the chunk, and the smaller size is remembered per chain so the price is
 * paid once per process instead of once per scan.
 *
 * The restart is not free — the new chunk bounds are different keys, so chunks that already
 * succeeded are fetched again. That is precisely why the learned size is stored per chain:
 * paying it once is acceptable, paying it on every poll is what made the ledger slow.
 */
async function scan<T>(request: WindowRequest<T>): Promise<T[]> {
  const chainId = chainIdForClient(request.client);
  let chunk = chunkFor(chainId);

  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      return await scanWindow(request, chunk);
    } catch (error) {
      if (!isRangeLimit(error)) throw error;
      const smaller = chunk / 2n;
      if (smaller < 1n) throw error;
      learnSmallerChunk(chainId, smaller);
      chunk = smaller;
    }
  }

  throw new Error(
    `eth_getLogs for ${request.address} could not fit any block range after repeated shrinking`,
  );
}

export async function getRawLogs(window: {
  readonly client: PublicClient;
  readonly address: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly cacheKeySuffix: string;
  readonly event?: unknown;
  /**
   * Topic filter, forwarded to the node.
   *
   * Without this the ledger had to download every event the system contract emitted and then
   * discard all but a handful: measured on Lasna, one 30k-block page of unfiltered system logs
   * took 2,779 ms and returned 1,045 events, while the same page filtered to this deployment's
   * callbacks took 749 ms and returned none. The filter is 3.7x faster *and* it is part of the
   * cache key, so two deployments watching the same system contract cannot collide.
   */
  readonly args?: Record<string, unknown>;
}): Promise<RawLog[]> {
  return scan<RawLog>({
    ...window,
    fetch: async (from, to) => {
      const request = {
        address: window.address,
        event: window.event,
        args: window.args,
        fromBlock: from,
        toBlock: to,
      };
      return (await window.client.getLogs(request as never)) as unknown as RawLog[];
    },
  });
}

/**
 * Typed `getLogs` for callers that want viem's decoded logs rather than `RawLog`.
 *
 * ## Why this exists next to `getRawLogs`
 *
 * `getRawLogs` returns the raw shape the ledger decoder wants, but the sweep orchestrator
 * and the callback lookup need viem's decoded `args`. Calling `client.getLogs` directly —
 * which is what they used to do — skipped every protection this module provides, so a
 * 50,000-block lookback was sent as one request and Lasna rejected it outright
 * ("getLogs request exceeded max allowed range"). Routing through the same scan means these
 * callers get the same chunking, pacing, retry, range learning and chunk caching as the
 * ledger, and the node's limit stops being something each call site has to know about.
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
  return scan<TReturn>({
    ...window,
    fetch: async (from, to) => {
      const request = {
        address: window.address,
        event: window.event,
        args: window.args,
        fromBlock: from,
        toBlock: to,
      };
      return (await window.client.getLogs(request as never)) as unknown as TReturn[];
    },
  });
}
