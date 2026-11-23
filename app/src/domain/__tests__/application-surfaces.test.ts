import { describe, expect, it, vi } from "vitest";
import {
  applyBudgetAction,
  type BudgetContract,
  type BudgetOutcome,
  type BudgetPort,
  type BudgetSnapshot,
} from "@/application/budget-controls";
import {
  runRefusalLab,
  type RefusalInput,
  type RefusalPort,
} from "@/application/refusal-lab";
import type { RefusalCaseId } from "@/domain/refusal";
import {
  applyRouteRepair,
  type LifecycleInput,
  type LifecycleOutcome,
  type LifecyclePort,
} from "@/application/route-lifecycle";
import {
  observe,
  type SweepObservationPort,
  type WatchParams,
} from "@/application/sweep-orchestrator";
import type { Address } from "@/domain/burner-route";
import type { PreflightDiff, TxReceipt } from "@/domain/tx-receipt";

const RSC: Address = "0x1111111111111111111111111111111111111111";
const FORWARDER: Address = "0x2222222222222222222222222222222222222222";
const BURNER: Address = "0x3333333333333333333333333333333333333333";
const COLD: Address = "0x4444444444444444444444444444444444444444";
const TOKEN: Address = "0x6666666666666666666666666666666666666666";

/** A `Transfer`-shaped log whose `data` carries the amount in the first word. */
function transferLog(txHash: `0x${string}`, blockNumber: bigint, amount: bigint) {
  return {
    txHash,
    blockNumber,
    logIndex: 0,
    topics: [] as readonly `0x${string}`[],
    data: `0x${amount.toString(16).padStart(64, "0")}` as `0x${string}`,
  };
}

function watchParams(): WatchParams {
  return {
    token: TOKEN,
    burner: BURNER,
    coldWallet: COLD,
    tokenSymbol: "SAPU",
    tokenDecimals: 18,
    forwarder: FORWARDER,
    fromBlock: 1n,
    originChainId: 84532,
    reactiveChainId: 5318007,
    onUpdate: () => {},
  };
}

describe("application surface coverage", () => {
  it("applyRouteRepair simulates, shows preflight diff, and returns LifecycleOutcome", async () => {
    const diffs: PreflightDiff[] = [];
    const receipt: TxReceipt = {
      hash: ("0x" + "ab".repeat(32)) as `0x${string}`,
      chainId: 84532,
      explorerUrl: "https://sepolia.basescan.org/tx/0x",
      blockNumber: 10n,
      gasUsed: 42_000n,
      status: "success",
      label: "Disarm the destination rule on SapuForwarder",
    };

    const port: LifecyclePort = {
      async simulateContract(call) {
        return { ok: true, prepared: call, gas: 45_000n };
      },
      async send() {
        return receipt;
      },
    };

    const input: LifecycleInput = {
      rsc: RSC,
      forwarder: FORWARDER,
      burner: BURNER,
      token: TOKEN,
      action: "disarm-forwarder",
    };

    const outcome: LifecycleOutcome = await applyRouteRepair(port, input, {
      confirm: async (diff) => {
        diffs.push(diff);
        return true;
      },
    });

    expect(outcome.ok).toBe(true);
    expect(diffs[0]?.changes.some((c) => c.label === "estimated gas")).toBe(true);
  });

  it("applyBudgetAction includes live gas estimate in preflight diff", async () => {
    const diffs: PreflightDiff[] = [];
    const targetContract: BudgetContract = "rsc";
    const snapshot: BudgetSnapshot = {
      callbackGasLimit: 150_000n,
      rscBalance: 1_000_000n,
      forwarderBalance: 2_000_000n,
      gasPrice: 1_000_000_000n,
      rscDebt: 0n,
      forwarderDebt: 0n,
    };

    const port: BudgetPort = {
      async simulateContract(call) {
        return { ok: true, prepared: call, gas: 33_000n };
      },
      async send() {
        return {
          hash: ("0x" + "cd".repeat(32)) as `0x${string}`,
          chainId: 5318007,
          explorerUrl: "https://lasna.reactscan.net/tx/0x",
          blockNumber: 5n,
          gasUsed: 31_000n,
          status: "success",
          label: "Settle callback debt on SapuRSC",
        };
      },
    };

    const outcome: BudgetOutcome = await applyBudgetAction(
      port,
      { kind: "cover-debt", contract: targetContract },
      snapshot,
      {
        confirm: async (diff) => {
          diffs.push(diff);
          return true;
        },
      },
    );

    expect(outcome.ok).toBe(true);
    expect(diffs[0]?.changes.find((c) => c.label === "estimated gas")?.after).toBe("33000 gas");
  });

  it("runRefusalLab returns all four RefusalCaseIds", async () => {
    const port: RefusalPort = {
      async simulateContract(call) {
        return {
          ok: false,
          kind: "reverted",
          reason: "reverted",
          decoded: { name: call.functionName === "registerRoute" ? "OwnableUnauthorizedAccount" : "RouteNotArmed", raw: "0xdeadbeef" },
        };
      },
    };
    const input: RefusalInput = {
      rsc: RSC,
      forwarder: FORWARDER,
      token: TOKEN,
      callbackProxy: "0x476f44b11f5c942c58f4c8e3d0300e5710743585",
      nonOwner: "0x000000000000000000000000000000000000dead",
      disarmedBurner: BURNER,
      disarmedColdWallet: COLD,
      zeroBalanceBurner: BURNER,
      zeroBalanceColdWallet: COLD,
    };

    const results = await runRefusalLab(port, input);
    const ids: RefusalCaseId[] = results.map((r) => r.id);
    expect(ids).toEqual(["non-owner-register", "non-provider-sweep", "disarmed-route", "zero-balance"]);
    expect(results.every((r) => r.outcome === "reverted")).toBe(true);
  });

  it("observe stitches a deposit, its callback request, and its sweep into one receipt", async () => {
    const port: SweepObservationPort = {
      findDeposits: vi.fn(async () => [transferLog(`0x${"11".repeat(32)}`, 5n, 1n)]),
      findCallbackRequests: vi.fn(async () => [
        {
          txHash: `0x${"22".repeat(32)}` as `0x${string}`,
          blockNumber: 3n,
          logIndex: 0,
          sender: RSC,
          recipient: FORWARDER,
          payload: "0x" as `0x${string}`,
        },
      ]),
      findSweeps: vi.fn(async () => [transferLog(`0x${"33".repeat(32)}`, 7n, 1n)]),
      getBlockTimestamp: vi.fn(async () => 1000),
    };

    // This is the function `/api/watch` actually calls, so this test covers the shipped
    // path rather than a polling wrapper that nothing imported.
    const receipts = await observe(port, watchParams(), []);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.deposit.txHash).toBe(`0x${"11".repeat(32)}`);
    expect(receipts[0]?.reactive?.txHash).toBe(`0x${"22".repeat(32)}`);
    expect(receipts[0]?.sweep?.txHash).toBe(`0x${"33".repeat(32)}`);
  });

  it("observe does not invent a sweep leg when no sweep was observed", async () => {
    const port: SweepObservationPort = {
      findDeposits: vi.fn(async () => [transferLog(`0x${"11".repeat(32)}`, 5n, 1n)]),
      findCallbackRequests: vi.fn(async () => []),
      findSweeps: vi.fn(async () => []),
      getBlockTimestamp: vi.fn(async () => 1000),
    };

    const receipts = await observe(port, watchParams(), []);

    expect(receipts[0]?.sweep).toBeNull();
    expect(receipts[0]?.reactive).toBeNull();
  });

  it("observe anchors the callback scan to the RSC deploy block when one is known", async () => {
    const findCallbackRequests = vi.fn(async () => []);
    const port: SweepObservationPort = {
      findDeposits: vi.fn(async () => []),
      findCallbackRequests,
      findSweeps: vi.fn(async () => []),
      getBlockTimestamp: vi.fn(async () => 1000),
    };

    await observe(port, { ...watchParams(), reactiveFromBlock: 8_950_150n }, []);

    expect(findCallbackRequests).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 8_950_150n, lookbackBlocks: undefined }),
    );
  });

  it("observe still bounds the callback scan when no deploy block is known", async () => {
    const findCallbackRequests = vi.fn(async () => []);
    const port: SweepObservationPort = {
      findDeposits: vi.fn(async () => []),
      findCallbackRequests,
      findSweeps: vi.fn(async () => []),
      getBlockTimestamp: vi.fn(async () => 1000),
    };

    await observe(port, watchParams(), []);

    expect(findCallbackRequests).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 0n, lookbackBlocks: 50_000n }),
    );
  });

  it("keeps the deposit and sweep legs even when the callback is out of scan range", async () => {
    // Regression: a receipt used to lose its reactive leg silently when the callback was
    // older than the scan window, so a completed sweep looked like it had no reactive hop.
    const port: SweepObservationPort = {
      findDeposits: vi.fn(async () => [transferLog(`0x${"11".repeat(32)}`, 5n, 1n)]),
      findCallbackRequests: vi.fn(async () => []),
      findSweeps: vi.fn(async () => [transferLog(`0x${"33".repeat(32)}`, 7n, 1n)]),
      getBlockTimestamp: vi.fn(async () => 1000),
    };

    const receipts = await observe(port, watchParams(), []);

    expect(receipts[0]?.deposit.txHash).toBe(`0x${"11".repeat(32)}`);
    expect(receipts[0]?.reactive).toBeNull();
    expect(receipts[0]?.sweep?.txHash).toBe(`0x${"33".repeat(32)}`);
  });
});

describe("refusal lab honesty", () => {
  const INPUT = {
    rsc: "0x1111111111111111111111111111111111111111" as const,
    forwarder: "0x2222222222222222222222222222222222222222" as const,
    token: "0x3333333333333333333333333333333333333333" as const,
    callbackProxy: "0x4444444444444444444444444444444444444444" as const,
    nonOwner: "0x5555555555555555555555555555555555555555" as const,
    disarmedBurner: "0x6666666666666666666666666666666666666666" as const,
    disarmedColdWallet: "0x7777777777777777777777777777777777777777" as const,
    zeroBalanceBurner: "0x8888888888888888888888888888888888888888" as const,
    zeroBalanceColdWallet: "0x9999999999999999999999999999999999999999" as const,
  };

  it("never publishes an unreachable node as an on-chain revert", async () => {
    // This was a real bug: `simulateCall` caught every error and decoded it, so an RPC that
    // never answered produced `outcome: "reverted"` with `decodedName: "reverted"`. The lab
    // is used as evidence, so a flaky node must read as an error, not as contract behaviour.
    const port: RefusalPort = {
      async simulateContract() {
        return { ok: false, kind: "unreachable", reason: "HTTP request failed." };
      },
    };

    const cases = await runRefusalLab(port, INPUT);

    expect(cases).toHaveLength(4);
    for (const item of cases) {
      expect(item.outcome).toBe("error");
      expect(item.decodedName).toBeNull();
      expect(item.raw).toBe("0x");
      expect(item.detail).toBe("HTTP request failed.");
    }
  });

  it("still reports a real revert with its decoded name and raw data", async () => {
    const port: RefusalPort = {
      async simulateContract() {
        return {
          ok: false,
          kind: "reverted",
          reason: "NotAuthorized()",
          decoded: { name: "NotAuthorized", raw: "0xc55ddc97" },
        };
      },
    };

    const cases = await runRefusalLab(port, INPUT);

    for (const item of cases) {
      expect(item.outcome).toBe("reverted");
      expect(item.decodedName).toBe("NotAuthorized");
      expect(item.raw).toBe("0xc55ddc97");
      expect(item.detail).toBeUndefined();
    }
  });

  it("reports an accepted call as unexpected-success, not as a refusal", async () => {
    const port: RefusalPort = {
      async simulateContract() {
        return { ok: true, prepared: {}, gas: 1n };
      },
    };

    const cases = await runRefusalLab(port, INPUT);

    for (const item of cases) {
      expect(item.outcome).toBe("unexpected-success");
      expect(item.decodedName).toBeNull();
    }
  });
});
