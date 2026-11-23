import { describe, expect, it, vi } from "vitest";
import { getRawLogs } from "@/infrastructure/logs";
import type { Address } from "@/domain/burner-route";

const TOKEN = "0x3333333333333333333333333333333333333333" as Address;

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
 * Every test gets its own client, because the cache and the rate-limit gate are keyed
 * by `client.uid`. That is what isolates the cases from each other — no cache-clearing
 * hook is needed, and none is exported for tests to reach for.
 */
function clientWith(getLogs: unknown) {
  return { uid: `test-${Math.random().toString(16).slice(2)}`, getLogs } as never;
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

describe("getRawLogs chunking", () => {
  it("asks for one request when the window fits a single span", async () => {
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [log(fromBlock)]);

    const out = await read(clientWith(getLogs), 0n, 24_999n);

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
  });

  it("splits a window larger than the span", async () => {
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [log(fromBlock)]);

    const out = await read(clientWith(getLogs), 0n, 500_000n);

    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
  });

  it("retries a 429 instead of silently returning no logs", async () => {
    let calls = 0;
    const getLogs = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw rateLimitError();
      return [log(1n)];
    });

    const out = await read(clientWith(getLogs), 0n, 1n);

    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
  });

  it("never runs two requests against the same chain at once", async () => {
    let inFlight = 0;
    let peak = 0;

    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [log(fromBlock)];
    });

    await read(clientWith(getLogs), 0n, 5_000_000n);

    expect(peak).toBe(1);
  });

  it("propagates a non-retryable error so the caller can report it", async () => {
    const getLogs = vi.fn(async () => {
      throw new Error("execution reverted");
    });

    await expect(read(clientWith(getLogs), 0n, 1n)).rejects.toThrow("execution reverted");
  });

  it("gives up after bounded retries rather than looping forever", async () => {
    vi.useFakeTimers();
    const getLogs = vi.fn(async () => {
      throw rateLimitError();
    });

    const pending = read(clientWith(getLogs), 0n, 1n);
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

    const out = await read(clientWith(getLogs), 0n, 10_000n);

    expect(calls).toBeGreaterThan(1);
    expect(out.length).toBeGreaterThan(1);
  });
});

describe("getRawLogs caching", () => {
  it("fetches unfiltered logs for one address so many events share one request", async () => {
    const getLogs = vi.fn(async () => [log(5n)]);

    const out = await read(clientWith(getLogs), 0n, 10n);

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs).toHaveBeenCalledWith({ address: TOKEN, fromBlock: 0n, toBlock: 10n });
    expect(out).toHaveLength(1);
  });

  it("shares one cache entry between route and ledger scans of the same window", async () => {
    const getLogs = vi.fn(async () => []);
    const client = clientWith(getLogs);

    await getRawLogs({ client, address: TOKEN, fromBlock: 0n, toBlock: 10n, cacheKeySuffix: "rsc-events" });
    await getRawLogs({ client, address: TOKEN, fromBlock: 0n, toBlock: 10n, cacheKeySuffix: "rsc-events" });

    expect(getLogs).toHaveBeenCalledTimes(1);
  });
});
