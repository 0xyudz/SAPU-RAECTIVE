import { describe, expect, it, vi } from "vitest";
import { getRawLogs, getDecodedLogs } from "@/infrastructure/logs";
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

  it("does not grow the log cache without bound as the scan window slides", async () => {
    // The ledger scans `head - 50_000 .. head`, and the head moves every block, so every
    // poll is a new cache key. Before the bound was added this map grew for the life of the
    // process — each entry a full log array — and eventually exhausted the server heap.
    // The per-chain gate paces requests at 120 ms, so this walks just past the bound rather
    // than simulating hours of polling.
    const getLogs = vi.fn(async () => []);
    const client = clientWith(getLogs);

    for (let i = 0; i < 40; i += 1) {
      await getRawLogs({
        client,
        address: TOKEN,
        fromBlock: BigInt(i),
        toBlock: BigInt(i + 10),
        cacheKeySuffix: "sliding",
      });
    }

    // Every window was fetched once...
    expect(getLogs).toHaveBeenCalledTimes(40);
    // ...and re-reading the oldest one re-scans, proving it was evicted rather than kept.
    await getRawLogs({ client, address: TOKEN, fromBlock: 0n, toBlock: 10n, cacheKeySuffix: "sliding" });
    expect(getLogs).toHaveBeenCalledTimes(41);
  }, 60_000);
});

/**
 * `getDecodedLogs` is the path the sweep orchestrator and the callback lookup use. It
 * shares `scanLogs` with `getRawLogs`, so the chunking/retry behaviour is covered above;
 * what is specific to it is that it must forward `args` to the node *and* key the cache by
 * them, or two burners would be served each other's callbacks.
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

    await readDecoded(clientWith(getLogs), { recipient });

    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKEN, args: { recipient }, fromBlock: 0n, toBlock: 10n }),
    );
  });

  it("does not serve one recipient's logs from another recipient's cache entry", async () => {
    const getLogs = vi.fn(async ({ args }: { args: { recipient: string } }) => [
      { ...log(1n), args },
    ]);
    const client = clientWith(getLogs);

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
    const client = clientWith(getLogs);
    const args = { recipient: "0x00000000000000000000000000000000000000aa" };

    await readDecoded(client, args);
    await readDecoded(client, args);

    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  it("chunks a lookback larger than one span instead of sending it in one request", async () => {
    const getLogs = vi.fn(async (request: { fromBlock: bigint; toBlock: bigint }) => {
      void request;
      return [] as unknown[];
    });

    await readDecoded(clientWith(getLogs), { recipient: "0x00000000000000000000000000000000000000aa" }, 0n, 1_200_000n);

    expect(getLogs.mock.calls.length).toBeGreaterThan(1);
    for (const call of getLogs.mock.calls) {
      const { fromBlock, toBlock } = call[0];
      expect(toBlock - fromBlock).toBeLessThan(500_000n);
    }
  });
});
