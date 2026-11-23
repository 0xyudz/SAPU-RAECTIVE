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
});
