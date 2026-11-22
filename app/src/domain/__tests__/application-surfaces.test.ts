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
  incompleteCount,
  watchBurner,
  type SweepObservationPort,
  type WatchParams,
} from "@/application/sweep-orchestrator";
import type { Address } from "@/domain/burner-route";
import type { PreflightDiff, TxReceipt } from "@/domain/tx-receipt";
import type { SweepReceipt } from "@/domain/sweep-receipt";

const RSC: Address = "0x1111111111111111111111111111111111111111";
const FORWARDER: Address = "0x2222222222222222222222222222222222222222";
const BURNER: Address = "0x3333333333333333333333333333333333333333";
const COLD: Address = "0x4444444444444444444444444444444444444444";
const TOKEN: Address = "0x6666666666666666666666666666666666666666";

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

  it("watchBurner polls and incompleteCount counts incomplete receipts", async () => {
    const port: SweepObservationPort = {
      findDeposits: vi.fn(async () => []),
      findCallbackRequests: vi.fn(async () => []),
      findSweeps: vi.fn(async () => []),
      getBlockTimestamp: vi.fn(async () => 1000),
    };

    let updates = 0;
    const params: WatchParams = {
      token: TOKEN,
      burner: BURNER,
      coldWallet: COLD,
      tokenSymbol: "SAPU",
      tokenDecimals: 18,
      forwarder: FORWARDER,
      fromBlock: 1n,
      pollIntervalMs: 60_000,
      onUpdate: () => {
        updates += 1;
      },
    };

    const stop = watchBurner(port, params);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(updates).toBeGreaterThanOrEqual(1);
    const sample: SweepReceipt = {
      id: "0x1",
      burner: BURNER,
      coldWallet: COLD,
      token: TOKEN,
      tokenSymbol: "SAPU",
      tokenDecimals: 18,
      depositAmount: "100",
      sweptAmount: null,
      deposit: { txHash: "0x1", chainId: 84532, blockNumber: "1", timestamp: 1, explorerUrl: "https://x" },
      reactive: null,
      sweep: null,
    };
    expect(incompleteCount([sample])).toBe(1);
  });
});
