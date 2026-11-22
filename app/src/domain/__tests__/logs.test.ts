import { describe, expect, it, vi } from "vitest";
import { clearLogCache, getLogsChunked, getRawLogs } from "@/infrastructure/logs";
import type { Address } from "@/domain/burner-route";

const TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const TRANSFER = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

function log(blockNumber: bigint, to: string) {
  return {
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`,
    logIndex: 0,
    args: { to },
  };
}

function rateLimitError(): Error {
  const error = new Error("Request exceeds defined limit.");
  (error as unknown as Record<string, unknown>).details = "rate limit exceeded";
  return error;
}

function clientWith(getLogs: unknown) {
  return { uid: `test-${Math.random().toString(16).slice(2)}`, getLogs } as never;
}

describe("getLogsChunked", () => {
  it("asks for one request when the window fits a single span", async () => {
    clearLogCache();
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [log(fromBlock, TOKEN)]);

    const out = await getLogsChunked({
      client: clientWith(getLogs),
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 24_999n,
    });

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
  });

  it("splits a window larger than the span", async () => {
    clearLogCache();
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [log(fromBlock, TOKEN)]);

    const out = await getLogsChunked({
      client: clientWith(getLogs),
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 500_000n,
    });

    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
  });

  it("retries a 429 instead of silently returning no logs", async () => {
    clearLogCache();
    let calls = 0;
    const getLogs = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw rateLimitError();
      return [log(1n, TOKEN)];
    });

    const out = await getLogsChunked({
      client: clientWith(getLogs),
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 1n,
    });

    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
  });

  it("never runs two requests against the same chain at once", async () => {
    clearLogCache();
    let inFlight = 0;
    let peak = 0;

    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [log(fromBlock, TOKEN)];
    });

    await getLogsChunked({
      client: clientWith(getLogs),
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 5_000_000n,
    });

    expect(peak).toBe(1);
  });

  it("propagates a non-retryable error so the caller can report it", async () => {
    clearLogCache();
    const getLogs = vi.fn(async () => {
      throw new Error("execution reverted");
    });

    await expect(
      getLogsChunked({
        client: clientWith(getLogs),
        address: TOKEN,
        event: TRANSFER,
        fromBlock: 0n,
        toBlock: 1n,
      }),
    ).rejects.toThrow("execution reverted");
  });

  it("gives up after bounded retries rather than looping forever", async () => {
    clearLogCache();
    vi.useFakeTimers();
    const getLogs = vi.fn(async () => {
      throw rateLimitError();
    });

    const pending = getLogsChunked({
      client: clientWith(getLogs),
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 1n,
    });
    const assertion = expect(pending).rejects.toThrow("Request exceeds defined limit.");

    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    vi.useRealTimers();

    expect(getLogs).toHaveBeenCalledTimes(4);
  });

  it("splits a range the RPC rejects as too large instead of giving up", async () => {
    clearLogCache();
    let calls = 0;
    const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls += 1;
      if (toBlock - fromBlock > 1_000n) {
        throw new Error("block range is too large");
      }
      return [log(fromBlock, TOKEN)];
    });

    const out = await getLogsChunked({
      client: clientWith(getLogs),
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 10_000n,
    });

    expect(calls).toBeGreaterThan(1);
    expect(out.length).toBeGreaterThan(1);
  });

  it("serves a repeat query from cache instead of rescanning", async () => {
    clearLogCache();
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [log(fromBlock, TOKEN)]);
    const client = clientWith(getLogs);
    const query = {
      client,
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 1_000n,
    } as const;

    await getLogsChunked(query);
    await getLogsChunked(query);

    expect(getLogs).toHaveBeenCalledTimes(1);
  });
});

describe("getRawLogs", () => {
  it("fetches unfiltered logs for one address so many events share one request", async () => {
    clearLogCache();
    const raw = {
      blockNumber: 5n,
      transactionHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      logIndex: 0,
      topics: [`0x${"cd".repeat(32)}` as `0x${string}`],
      data: "0x" as `0x${string}`,
    };
    const getLogs = vi.fn(async () => [raw]);

    const out = await getRawLogs({
      client: clientWith(getLogs),
      address: TOKEN,
      fromBlock: 0n,
      toBlock: 10n,
      cacheKeySuffix: "events",
    });

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs).toHaveBeenCalledWith({ address: TOKEN, fromBlock: 0n, toBlock: 10n });
    expect(out).toHaveLength(1);
  });

  it("shares one cache entry between route and ledger scans of the same window", async () => {
    clearLogCache();
    const getLogs = vi.fn(async () => []);
    const client = clientWith(getLogs);

    await getRawLogs({ client, address: TOKEN, fromBlock: 0n, toBlock: 10n, cacheKeySuffix: "rsc-events" });
    await getRawLogs({ client, address: TOKEN, fromBlock: 0n, toBlock: 10n, cacheKeySuffix: "rsc-events" });

    expect(getLogs).toHaveBeenCalledTimes(1);
  });
});
