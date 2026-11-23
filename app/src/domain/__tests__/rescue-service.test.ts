import { describe, expect, it } from "vitest";
import {
  rescueBlockedReason,
  rescueResidue,
  type RescueInput,
  type RescuePort,
} from "@/application/rescue-service";
import { TxRevertedError, type ContractCall } from "@/application/ports";
import type { Address } from "@/domain/burner-route";
import type { Residue } from "@/domain/residue";
import type { PreflightDiff, TxReceipt } from "@/domain/tx-receipt";

const FORWARDER: Address = "0x2222222222222222222222222222222222222222";
const BURNER: Address = "0x3333333333333333333333333333333333333333";
const COLD: Address = "0x4444444444444444444444444444444444444444";
const TOKEN: Address = "0x6666666666666666666666666666666666666666";

const held: Residue = {
  state: "held",
  liveBalance: "1000000000000000000",
  stranded: "1000000000000000000",
};

function baseInput(residue: Residue = held): RescueInput {
  return {
    forwarder: FORWARDER,
    token: TOKEN,
    burner: BURNER,
    coldWallet: COLD,
    residue,
    tokenSymbol: "SAPU",
    tokenDecimals: 18,
  };
}

function receipt(label: string): TxReceipt {
  return {
    hash: `0x${"ab".repeat(32)}`,
    chainId: 84532,
    explorerUrl: "https://sepolia.basescan.org/tx/0x",
    blockNumber: 10n,
    gasUsed: 42_000n,
    status: "success",
    label,
  };
}

function recordingPort(sent: ContractCall[]): RescuePort {
  return {
    async simulateContract(call) {
      return { ok: true, prepared: call, gas: 61_000n };
    },
    async send() {
      sent.push({ contract: "forwarder", functionName: "rescueSweep", args: [], label: "rescue" });
      return receipt("Rescue the stranded balance to the armed cold wallet");
    },
  };
}

describe("rescueBlockedReason", () => {
  it("allows a rescue when the burner holds a balance", () => {
    expect(rescueBlockedReason(baseInput())).toBeNull();
  });

  it("refuses to rescue an empty burner", () => {
    const input = baseInput({ state: "cleared", liveBalance: "0", stranded: "0" });
    expect(rescueBlockedReason(input)).toMatch(/already empty/);
  });

  it("refuses to rescue when the balance could not be read", () => {
    const input = baseInput({ state: "unread", liveBalance: null, stranded: null });
    expect(rescueBlockedReason(input)).toMatch(/could not be read/);
  });
});

describe("rescueResidue", () => {
  it("simulates, shows the diff, then sends exactly one rescue", async () => {
    const sent: ContractCall[] = [];
    const diffs: PreflightDiff[] = [];

    const outcome = await rescueResidue(recordingPort(sent), baseInput(), {
      confirm: async (diff) => {
        diffs.push(diff);
        return true;
      },
    });

    expect(outcome.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(diffs[0]?.changes.some((c) => c.label === "estimated gas")).toBe(true);
  });

  it("shows the armed cold wallet as the destination, not a typed address", async () => {
    const diffs: PreflightDiff[] = [];

    await rescueResidue(recordingPort([]), baseInput(), {
      confirm: async (diff) => {
        diffs.push(diff);
        return true;
      },
    });

    const destination = diffs[0]?.changes.find((change) => change.label === "destination");
    expect(destination?.after).toContain(COLD);
    expect(destination?.after).toContain("armed rule");
  });

  it("never sends when the operator cancels at the diff", async () => {
    const sent: ContractCall[] = [];

    const outcome = await rescueResidue(recordingPort(sent), baseInput(), {
      confirm: async () => false,
    });

    expect(outcome.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("never sends when the simulation fails, and reports the decoded reason", async () => {
    const sent: ContractCall[] = [];
    const port: RescuePort = {
      async simulateContract() {
        return {
          ok: false,
          reason: "RouteNotArmed",
          decoded: { name: "RouteNotArmed", raw: "0x" },
        };
      },
      async send() {
        sent.push({ contract: "forwarder", functionName: "rescueSweep", args: [], label: "rescue" });
        return receipt("rescue");
      },
    };

    const outcome = await rescueResidue(port, baseInput());

    expect(outcome.ok).toBe(false);
    expect(sent).toHaveLength(0);
    if (!outcome.ok) expect(outcome.decoded?.name).toBe("RouteNotArmed");
  });

  it("reports a reverted receipt instead of claiming success", async () => {
    const port: RescuePort = {
      async simulateContract(call) {
        return { ok: true, prepared: call, gas: null };
      },
      async send() {
        return { ...receipt("rescue"), status: "reverted" };
      },
    };

    const outcome = await rescueResidue(port, baseInput());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.receipts).toHaveLength(1);
  });

  it("returns the receipt of a transaction that reverted while mining", async () => {
    const reverted: TxReceipt = { ...receipt("rescue"), status: "reverted" };
    const port: RescuePort = {
      async simulateContract(call) {
        return { ok: true, prepared: call, gas: null };
      },
      async send() {
        throw new TxRevertedError(reverted, "NothingToSweep", { name: "NothingToSweep", raw: "0x" });
      },
    };

    const outcome = await rescueResidue(port, baseInput());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.receipts[0]?.hash).toBe(reverted.hash);
      expect(outcome.decoded?.name).toBe("NothingToSweep");
    }
  });
});
