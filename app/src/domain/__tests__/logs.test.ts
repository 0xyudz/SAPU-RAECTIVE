import { describe, expect, it, vi } from "vitest";
import { getLogsChunked } from "@/infrastructure/logs";
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

describe("getLogsChunked", () => {
  it("splits the window into chunks and merges every result", async () => {
    const getLogs = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => [log(fromBlock, TOKEN)]);
    const client = { getLogs } as never;

    const out = await getLogsChunked({
      client,
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 24_999n,
    });

    expect(getLogs).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(3);
  });

  it("retries a 429 instead of silently returning no logs", async () => {
    let calls = 0;
    const getLogs = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw rateLimitError();
      return [log(1n, TOKEN)];
    });

    const out = await getLogsChunked({
      client: { getLogs } as never,
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 1n,
    });

    expect(calls).toBe(2);
    expect(out).toHaveLength(1);
  });

  it("caps concurrency so the gateway is not hammered", async () => {
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
      client: { getLogs } as never,
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 99_999n,
    });

    expect(peak).toBeLessThanOrEqual(3);
  });

  it("propagates a non-retryable error so the caller can report it", async () => {
    const getLogs = vi.fn(async () => {
      throw new Error("execution reverted");
    });

    await expect(
      getLogsChunked({
        client: { getLogs } as never,
        address: TOKEN,
        event: TRANSFER,
        fromBlock: 0n,
        toBlock: 1n,
      }),
    ).rejects.toThrow("execution reverted");
  });

  it("gives up after bounded retries rather than looping forever", async () => {
    vi.useFakeTimers();
    const getLogs = vi.fn(async () => {
      throw rateLimitError();
    });

    const pending = getLogsChunked({
      client: { getLogs } as never,
      address: TOKEN,
      event: TRANSFER,
      fromBlock: 0n,
      toBlock: 1n,
    });
    const assertion = expect(pending).rejects.toThrow("Request exceeds defined limit.");

    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    vi.useRealTimers();

    expect(getLogs).toHaveBeenCalledTimes(5);
  });
});
