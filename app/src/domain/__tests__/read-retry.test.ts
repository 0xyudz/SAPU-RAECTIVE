import { describe, expect, it, vi } from "vitest";
import type { Address } from "@/domain/burner-route";

/**
 * The reads that convert a transport failure into `null`.
 *
 * ## The bug this pins
 *
 * `readDebt` and `readOwner` deliberately answer `null` when the chain cannot be read, because
 * "unreadable" and "zero" are different claims and the UI renders them differently. But the
 * `try/catch` that produces that `null` used to sit *outside* the retry, so callers wrapped the
 * call in `withRpcRetry` and it could never fire: the catch swallowed the error first and the
 * retry saw a call that had succeeded with `null`.
 *
 * Measured live: `/api/budget` answered `forwarderDebt: null` on a deployment whose
 * `debt(forwarder)` was `0`. The public gateway had returned "HTTP request failed" for the first
 * attempt and the value was published as unreadable instead of being retried. `readOwner` had the
 * same shape, which made the arm page report "owner could not be read — not a verdict" for a
 * transient 429.
 *
 * The fix is that the retry lives *inside* the try. These tests pin that ordering, because it is
 * invisible from the call site and therefore easy to undo.
 */

const FORWARDER = "0x3ec83c9b41457b7b40e3c5f2dd107a52e48d4027" as Address;

const { readDebt, readOwner } = await import("@/infrastructure/chain-reads");

/**
 * A contract-target double whose first `failures` reads reject with a retryable transport error
 * and whose later reads return `value`.
 *
 * `contracts.ts` is mocked rather than the RPC client so the production `withRpcRetry` path is
 * the one under test — mocking the retry itself would make the assertion vacuous.
 */
function targetDouble(value: unknown, failures: number) {
  let calls = 0;
  return {
    client: {
      readContract: vi.fn(async () => {
        calls += 1;
        if (calls <= failures) throw new Error("HTTP request failed.");
        return value;
      }),
    },
    address: FORWARDER,
    abi: [],
    chainId: 84532,
    get calls() {
      return calls;
    },
  };
}

vi.mock("@/infrastructure/contracts", async () => {
  const actual = await vi.importActual<typeof import("@/infrastructure/contracts")>(
    "@/infrastructure/contracts",
  );
  return {
    ...actual,
    // Both `payerTarget` (debt) and `contractTarget` (owner) hand back the same double; the
    // value under test is the read, not which resolver produced the client.
    payerTarget: () => double,
    contractTarget: () => double,
  };
});

let double = targetDouble(0n, 0);

describe("readDebt retries before declaring a value unreadable", () => {
  it("returns the value when a transport failure is followed by a success", async () => {
    double = targetDouble(0n, 1);

    const debt = await readDebt("callback-proxy", FORWARDER);

    // The regression: this used to be `null`, because the retry was outside the catch.
    expect(debt).toBe(0n);
    expect(double.calls).toBe(2);
  });

  it("still answers null when every attempt fails, rather than inventing zero", async () => {
    double = targetDouble(0n, 99);

    const debt = await readDebt("callback-proxy", FORWARDER);

    expect(debt).toBeNull();
    expect(double.calls).toBeGreaterThan(1);
  });

  it("does not retry a permanent error the node will answer the same way", async () => {
    // A contract revert is chain state, not transport. Retrying it would only add latency.
    double = targetDouble(0n, 0);
    double.client.readContract.mockImplementation(async () => {
      throw new Error('The contract function "debt" reverted.');
    });

    const debt = await readDebt("callback-proxy", FORWARDER);

    expect(debt).toBeNull();
    expect(double.client.readContract).toHaveBeenCalledTimes(1);
  });
});

describe("readOwner retries before reporting an owner as unreadable", () => {
  it("returns the owner when a transport failure is followed by a success", async () => {
    double = targetDouble(FORWARDER, 1);

    const owner = await readOwner("forwarder");

    expect(owner).toBe(FORWARDER);
    expect(double.calls).toBe(2);
  });

  it("still answers null when every attempt fails", async () => {
    double = targetDouble(FORWARDER, 99);

    expect(await readOwner("forwarder")).toBeNull();
  });
});
