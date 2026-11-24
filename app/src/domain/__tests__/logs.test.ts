import { describe, expect, it, vi } from "vitest";
import type { Address } from "@/domain/burner-route";
import { logChunkBlocks } from "@/config/log-ranges";

/**
 * `logs.ts` asks `rpc-clients` which chain a client belongs to, in order to pick a chunk size
 * that fits that node's `eth_getLogs` cap. The real mapping is populated only by `getClient`,
 * so a test double has no chain. This mock lets each case declare one, which is what makes the
 * per-chain behaviour testable at all — without it every test would silently exercise the
 * conservative fallback and the measured Lasna/Base limits would go unverified.
 */
vi.mock("@/infrastructure/rpc-clients", () => ({
  chainIdForClient: (client: { chainId?: number }) => client.chainId ?? null,
}));

const { getRawLogs, getDecodedLogs } = await import("@/infrastructure/logs");

const TOKEN = "0x3333333333333333333333333333333333333333" as Address;

/** Measured caps from the live endpoints; see `config/log-ranges.ts`. */
const LASNA = 5318007;
const BASE_SEPOLIA = 84532;

function log(blockNumber: bigint) {
  return {
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`,
    logIndex: 0,
    topics: [`0x${"cd".repeat(32)}` as `0x${string}`],
    data: "0x" as `0x${string}`,
  };
}

function rateLimitError(): Error {
  const error = new Error("Request exceeds defined limit.");
  (error as unknown as Record<string, unknown>).details = "rate limit exceeded";
  return error;
}

/**
 * Every test gets its own client, because the cache and the rate-limit gate are keyed by
 * `client.uid`. That is what isolates the cases from each other — no cache-clearing hook is
 * needed, and none is exported for tests to reach for.
 *
 * `chainId` selects the chunk size under test. Distinct ids per case also isolate the
 * per-chain "learned smaller chunk" state, which is module-level by design.
 */
function clientWith(getLogs: unknown, chainId?: number) {
  return {
    uid: `test-${Math.random().toString(16).slice(2)}`,
    chainId,
    getLogs,
  } as never;
}

/** The one production log reader; every scan behaviour below is exercised through it. */
function read(client: unknown, fromBlock: bigint, toBlock: bigint) {
  return getRawLogs({
    client: client as never,
    address: TOKEN,
    fromBlock,
    toBlock,
    cacheKeySuffix: "events",
  });
}

describe("logChunkBlocks", () => {
  it("uses the measured Lasna cap, which the node enforces exactly", () => {
    // Measured live: 29,999 accepted, 30,000 rejected. One block above this is a wasted
    // request on every scan, so the number is pinned rather than "about 30k".
    expect(logChunkBlocks(LASNA)).toBe(29_999n);
  });

  it("uses a chosen chunk for Base Sepolia, well under its much higher cap", () => {
    expect(logChunkBlocks(BASE_SEPOLIA)).toBe(100_000n);
  });

  it("falls back to a conservative chunk for a chain nobody measured", () => {
    // Not a guess at a provider limit: a value below every cap seen in the wild, so an
    // unmeasured chain never starts by wasting a rejected request.
    expect(logChunkBlocks(999_001)).toBe(10_000n);
    expect(logChunkBlocks(null)).toBe(10_000n);
  });
});

describe("getRawLogs chunking", () => {
  it("asks for one request when the window fits a single chunk", async () => {
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [log(fromBlock)]);

    const out = await read(clientWith(getLogs, LASNA), 0n, 24_999n);

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
  });

  it("splits a window larger than the chain's chunk", async () => {
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [log(fromBlock)]);

    const out = await read(clientWith(getLogs, LASNA), 0n, 59_997n);

    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
  });

  it("never asks for a range wider than the chain's cap", async () => {
    // The regression this guards: a span above the node cap makes every scan pay for a
    // bisect, which is what made a cold ledger build take ~50 s.
    const getLogs = vi.fn(async (request: { fromBlock: bigint; toBlock: bigint }) => { void request; return [] as unknown[]; });

    await read(clientWith(getLogs, LASNA), 0n, 500_000n);

    for (const call of getLogs.mock.calls) {
      const { fromBlock, toBlock } = call[0];
      expect(toBlock - fromBlock).toBeLessThan(30_000n);
    }
  });

  it("retries a 429 instead of silently returning no logs", async () => {
    let calls = 0;
    const getLogs = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw rateLimitError();
      return [log(1n)];
    });

    const out = await read(clientWith(getLogs, LASNA), 0n, 1n);

    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
  });

  it("bounds how many requests are in flight per chain instead of firing them all", async () => {
    // The scan is concurrent now, so "one at a time" is no longer the property. What must hold
    // is the bound: measured latency doubles at four concurrent requests on these endpoints
    // (see `MAX_IN_FLIGHT`), so the scan must never reach that.
    let inFlight = 0;
    let peak = 0;

    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Longer than the 120 ms start-to-start pace, like a real request (750–3400 ms). With a
      // shorter delay the requests would never overlap and this test could not observe the
      // bound at all — it would pass even if the limit were removed.
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight -= 1;
      return [log(fromBlock)];
    });

    // Six chunks at the Lasna size. The point is the overlap, not the window length.
    await read(clientWith(getLogs, LASNA), 0n, 6n * 29_999n - 1n);

    expect(getLogs.mock.calls.length).toBe(6);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("propagates a non-retryable error so the caller can report it", async () => {
    const getLogs = vi.fn(async () => {
      throw new Error("execution reverted");
    });

    await expect(read(clientWith(getLogs, LASNA), 0n, 1n)).rejects.toThrow("execution reverted");
  });

  it("gives up after bounded retries rather than looping forever", async () => {
    vi.useFakeTimers();
    const getLogs = vi.fn(async () => {
      throw rateLimitError();
    });

    const pending = read(clientWith(getLogs, LASNA), 0n, 1n);
    const assertion = expect(pending).rejects.toThrow("Request exceeds defined limit.");

    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    vi.useRealTimers();

    expect(getLogs).toHaveBeenCalledTimes(4);
  });

  it("splits a range the RPC rejects as too large instead of giving up", async () => {
    let calls = 0;
    const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls += 1;
      if (toBlock - fromBlock > 1_000n) {
        throw new Error("block range is too large");
      }
      return [log(fromBlock)];
    });

    const out = await read(clientWith(getLogs, 999_002), 0n, 10_000n);

    expect(calls).toBeGreaterThan(1);
    expect(out.length).toBeGreaterThan(1);
  });

  it("remembers a learned chunk size so the rejection is paid once, not per scan", async () => {
    // A provider tighter than anything recorded in config. The first scan must discover the
    // limit; the second must not repeat a single rejected request.
    const rejected: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock > 1_000n) {
        rejected.push({ fromBlock, toBlock });
        throw new Error("block range is too large");
      }
      return [log(fromBlock)];
    });
    const client = clientWith(getLogs, 999_003);

    // 2,000 blocks against a 1,000-block provider limit: five shrink levels, which is enough
    // to prove the size is learned without spending a minute in the 120 ms per-request pace.
    await read(client, 0n, 1_999n);
    // The first scan necessarily pays for discovery.
    expect(rejected.length).toBeGreaterThan(0);

    const firstScanRejections = rejected.length;
    const callsBeforeSecond = getLogs.mock.calls.length;
    await read(client, 20_000n, 21_999n);

    // The whole point: the second scan repeats no rejected request. Without the learned size
    // it would start at the configured chunk again and pay the same discovery cost on every
    // poll — which is what made a cold ledger build take ~35 s.
    expect(rejected.length).toBe(firstScanRejections);

    // And it stays near the minimum the provider's limit allows (2 requests of 1,000 blocks).
    const secondScan = getLogs.mock.calls.length - callsBeforeSecond;
    expect(secondScan).toBeGreaterThanOrEqual(2);
    expect(secondScan).toBeLessThanOrEqual(4);
  });
});

describe("getRawLogs chunk caching", () => {
  it("fetches unfiltered logs for one address so many events share one request", async () => {
    const getLogs = vi.fn(async () => [log(5n)]);

    const out = await read(clientWith(getLogs, LASNA), 0n, 10n);

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs).toHaveBeenCalledWith({ address: TOKEN, fromBlock: 0n, toBlock: 10n });
    expect(out).toHaveLength(1);
  });

  it("shares one cache entry between route and ledger scans of the same window", async () => {
    const getLogs = vi.fn(async () => []);
    const client = clientWith(getLogs, LASNA);

    await getRawLogs({ client, address: TOKEN, fromBlock: 0n, toBlock: 10n, cacheKeySuffix: "rsc-events" });
    await getRawLogs({ client, address: TOKEN, fromBlock: 0n, toBlock: 10n, cacheKeySuffix: "rsc-events" });

    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  /**
   * The latency fix, stated as a test.
   *
   * The ledger scans `head - lookback .. head`. With a per-window cache, the head advancing by
   * one block changed the cache key, so every poll re-fetched the whole window — 776,515
   * blocks of `eth_getLogs` every 15 seconds on the live deployment, to learn about one new
   * block. Chunks are aligned to absolute multiples now, so a slide re-uses every chunk that
   * did not change.
   */
  it("re-reads only the chunk a sliding window enters, not the whole window", async () => {
    const getLogs = vi.fn(async (request: { fromBlock: bigint; toBlock: bigint }) => { void request; return [] as unknown[]; });
    const client = clientWith(getLogs, BASE_SEPOLIA);

    // A 400,000-block window over a 100,000-block chunk: four chunks.
    await read(client, 0n, 399_999n);
    expect(getLogs).toHaveBeenCalledTimes(4);

    // The head advances by 1 block. Only the last chunk's tail is new, so only the tip chunk
    // (which is also not yet settled) may be requested again.
    await read(client, 1n, 400_000n);

    expect(getLogs).toHaveBeenCalledTimes(5);
  });

  it("does not re-read a settled chunk when the window grows past it", async () => {
    const getLogs = vi.fn(async (request: { fromBlock: bigint; toBlock: bigint }) => { void request; return [] as unknown[]; });
    const client = clientWith(getLogs, BASE_SEPOLIA);

    await read(client, 0n, 199_999n);
    expect(getLogs).toHaveBeenCalledTimes(2);

    // Extending the window into a third chunk must not touch the first two.
    await read(client, 0n, 299_999n);

    expect(getLogs).toHaveBeenCalledTimes(3);
  });

  it("never widens the caller's window, even though chunks are aligned", async () => {
    // Chunk alignment reaches back before `fromBlock` (a cache decision). Those logs must not
    // leak into the result: the caller asked for a range, and the answer must be that range.
    const getLogs = vi.fn(async () => [log(5n), log(150n), log(250n)]);
    const client = clientWith(getLogs, BASE_SEPOLIA);

    const out = await read(client, 200n, 250n);

    expect(out.map((entry) => (entry as { blockNumber: bigint }).blockNumber)).toEqual([250n]);
  });

  it("does not grow the log cache without bound as the scan window slides", async () => {
    // The cache is an optimisation, not a source of truth: entries are evicted under a bound,
    // so an old window re-scans rather than the map growing for the life of the process.
    //
    // Fake timers keep this honest and fast: the per-chain gate paces requests at 120 ms, so
    // 300 real requests would spend 36 s waiting. Advancing the clock also makes the TTL
    // checks deterministic instead of dependent on how long the test actually took.
    vi.useFakeTimers();
    const getLogs = vi.fn(async (request: { fromBlock: bigint; toBlock: bigint }) => { void request; return [] as unknown[]; });
    const client = clientWith(getLogs, 999_004);

    const readAndAdvance = async (from: bigint, to: bigint) => {
      const pending = read(client, from, to);
      // Enough to clear the gate for every chunk in the window, then settle the promises.
      await vi.advanceTimersByTimeAsync(1_000);
      return pending;
    };

    // Each call covers three chunks (fallback chunk is 10,000 blocks), so 100 calls insert 300
    // entries — past the 256-entry bound.
    for (let i = 0; i < 100; i += 1) {
      const base = BigInt(i) * 30_000n;
      await readAndAdvance(base, base + 29_999n);
    }
    expect(getLogs).toHaveBeenCalledTimes(300);

    // The newest window is still cached: serving it costs nothing.
    await readAndAdvance(2_970_000n, 2_999_999n);
    expect(getLogs).toHaveBeenCalledTimes(300);

    // The oldest window was evicted, so it must be re-scanned rather than served from memory.
    const before = getLogs.mock.calls.length;
    await readAndAdvance(0n, 29_999n);
    expect(getLogs.mock.calls.length).toBeGreaterThan(before);

    vi.useRealTimers();
  }, 60_000);
});

/**
 * `getDecodedLogs` is the path the sweep orchestrator and the callback lookup use. It shares
 * the scan with `getRawLogs`, so the chunking/retry behaviour is covered above; what is
 * specific to it is that it must forward `args` to the node *and* key the cache by them, or
 * two burners would be served each other's callbacks.
 */
describe("getDecodedLogs", () => {
  const event = { name: "CallbackRequest", type: "event", inputs: [] };

  function readDecoded(client: unknown, args: Record<string, unknown>, fromBlock = 0n, toBlock = 10n) {
    return getDecodedLogs({
      client: client as never,
      address: TOKEN,
      fromBlock,
      toBlock,
      cacheKeySuffix: "callback-requests",
      event,
      args,
    });
  }

  it("forwards the args filter to the node", async () => {
    const getLogs = vi.fn(async () => []);
    const recipient = "0x00000000000000000000000000000000000000aa";

    await readDecoded(clientWith(getLogs, LASNA), { recipient });

    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKEN, args: { recipient }, fromBlock: 0n, toBlock: 10n }),
    );
  });

  it("does not serve one recipient's logs from another recipient's cache entry", async () => {
    const getLogs = vi.fn(async ({ args }: { args: { recipient: string } }) => [
      { ...log(1n), args },
    ]);
    const client = clientWith(getLogs, LASNA);

    const first = await readDecoded(client, { recipient: "0x00000000000000000000000000000000000000aa" });
    const second = await readDecoded(client, { recipient: "0x00000000000000000000000000000000000000bb" });

    // Two distinct recipients must cost two requests and return their own rows.
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect((first[0] as { args: { recipient: string } }).args.recipient).toBe(
      "0x00000000000000000000000000000000000000aa",
    );
    expect((second[0] as { args: { recipient: string } }).args.recipient).toBe(
      "0x00000000000000000000000000000000000000bb",
    );
  });

  it("still shares one cache entry for the same recipient and window", async () => {
    const getLogs = vi.fn(async () => []);
    const client = clientWith(getLogs, LASNA);
    const args = { recipient: "0x00000000000000000000000000000000000000aa" };

    await readDecoded(client, args);
    await readDecoded(client, args);

    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  it("chunks a lookback larger than one chunk instead of sending it in one request", async () => {
    const getLogs = vi.fn(async (request: { fromBlock: bigint; toBlock: bigint }) => { void request; return [] as unknown[]; });

    // Three Lasna-sized chunks. The assertion is about the split, not the window length; a
    // multi-million-block window would spend its whole budget in the 120 ms per-request gate.
    await readDecoded(
      clientWith(getLogs, LASNA),
      { recipient: "0x00000000000000000000000000000000000000aa" },
      0n,
      60_000n,
    );

    expect(getLogs.mock.calls.length).toBeGreaterThan(1);
    for (const call of getLogs.mock.calls) {
      const { fromBlock, toBlock } = call[0];
      expect(toBlock - fromBlock).toBeLessThan(30_000n);
    }
  });
});
