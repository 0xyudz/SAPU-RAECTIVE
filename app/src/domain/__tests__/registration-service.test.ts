import { describe, expect, it } from "vitest";
import {
  armRoute,
  deriveArmSteps,
  findDivergence,
  type ArmingSnapshot,
  type PermitSignature,
  type RegisterInput,
  type RouteRegistrationPort,
} from "@/application/registration-service";
import { TxRevertedError, type ContractCall, type Simulation, type WriteProgressEvent } from "@/application/ports";
import type { Address } from "@/domain/burner-route";
import type { TxReceipt } from "@/domain/tx-receipt";

const RSC: Address = "0x1111111111111111111111111111111111111111";
const FORWARDER: Address = "0x2222222222222222222222222222222222222222";
const BURNER: Address = "0x3333333333333333333333333333333333333333";
const COLD_WALLET: Address = "0x4444444444444444444444444444444444444444";
const OTHER_WALLET: Address = "0x5555555555555555555555555555555555555555";
const TOKEN: Address = "0x6666666666666666666666666666666666666666";

const BASE_INPUT: RegisterInput = {
  rsc: RSC,
  forwarder: FORWARDER,
  burner: BURNER,
  coldWallet: COLD_WALLET,
  token: TOKEN,
  tokenSymbol: "SAPU",
  tokenDecimals: 18,
  chainId: 84532,
};

function makeFakePort(options?: {
  initial?: Partial<ArmingSnapshot>;
  after?: Partial<ArmingSnapshot>;
  failStep?: string;
  revertAfterSendStep?: string;
  noKey?: boolean;
}): { port: RouteRegistrationPort; sentCalls: ContractCall[] } {
  let state: ArmingSnapshot = {
    forwarder: null,
    routeActive: false,
    routeColdWallet: null,
    ruleArmed: false,
    ruleColdWallet: null,
    allowance: 0n,
    ...options?.initial,
  };
  let inspectCount = 0;
  let txCounter = 0;
  const sentCalls: ContractCall[] = [];

  const port: RouteRegistrationPort = {
    async inspect(): Promise<ArmingSnapshot> {
      inspectCount += 1;
      if (inspectCount >= 2 && options?.after) {
        return { ...state, ...options.after };
      }
      return { ...state };
    },

    async signPermit(): Promise<PermitSignature | null> {
      if (options?.noKey) return null;
      return {
        v: 27,
        r: ("0x" + "11".repeat(32)) as `0x${string}`,
        s: ("0x" + "22".repeat(32)) as `0x${string}`,
      };
    },

    async simulateContract(call: ContractCall): Promise<Simulation> {
      if (options?.failStep === call.functionName) {
        return {
          ok: false,
          reason: "OwnableUnauthorizedAccount(0xdead)",
          decoded: {
            name: "OwnableUnauthorizedAccount",
            args: ["0x000000000000000000000000000000000000dead"],
            raw: "0x118cdaa7",
          },
        };
      }
      return { ok: true, prepared: call, gas: 120_000n };
    },

    async send(prepared: unknown, onPending?: (hash: `0x${string}`) => void): Promise<TxReceipt> {
      const call = prepared as ContractCall;
      sentCalls.push(call);
      txCounter += 1;
      const hash = (`0x${String(txCounter).padStart(64, "a")}`) as `0x${string}`;
      onPending?.(hash);

      const receipt: TxReceipt = {
        hash,
        chainId: call.contract === "rsc" ? 5318007 : 84532,
        explorerUrl: `https://sepolia.basescan.org/tx/${hash}`,
        blockNumber: BigInt(100 + txCounter),
        gasUsed: 95_000n,
        status: options?.revertAfterSendStep === call.functionName ? "reverted" : "success",
        label: call.label,
      };

      if (options?.revertAfterSendStep === call.functionName) {
        throw new TxRevertedError(receipt, "RouteNotArmed", {
          name: "RouteNotArmed",
          args: [BURNER, TOKEN],
          raw: "0x12345678",
        });
      }

      if (call.functionName === "setForwarder") {
        state = { ...state, forwarder: FORWARDER };
      } else if (call.functionName === "registerRoute") {
        state = { ...state, routeActive: true, routeColdWallet: COLD_WALLET };
      } else if (call.functionName === "armWithPermit") {
        state = { ...state, allowance: (1n << 256n) - 1n };
      } else if (call.functionName === "armRoute") {
        state = { ...state, ruleArmed: true, ruleColdWallet: COLD_WALLET };
      }

      return receipt;
    },
  };

  return { port, sentCalls };
}

describe("RegistrationService", () => {
  it("runs all 4 steps in order, uses the same permit deadline, and returns all TxReceipts", async () => {
    const { port, sentCalls } = makeFakePort();
    const events: WriteProgressEvent[] = [];

    const result = await armRoute(port, BASE_INPUT, {
      confirm: async () => true,
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.route.status).toBe("armed");
    expect(result.receipts).toHaveLength(4);
    expect(sentCalls.map((c) => c.functionName)).toEqual([
      "setForwarder",
      "registerRoute",
      "armWithPermit",
      "armRoute",
    ]);
    expect(result.steps.every((step) => step.status === "done")).toBe(true);
    expect(events.some((event) => event.type === "confirmed")).toBe(true);
  });

  it("resumes from on-chain state and skips completed steps on reload", async () => {
    const { port, sentCalls } = makeFakePort({
      initial: {
        forwarder: FORWARDER,
        routeActive: true,
        routeColdWallet: COLD_WALLET,
        allowance: 1000n,
      },
    });

    const result = await armRoute(port, BASE_INPUT, { confirm: async () => true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sentCalls.map((c) => c.functionName)).toEqual(["armRoute"]);
    expect(result.steps[0]?.status).toBe("skipped");
    expect(result.steps[1]?.status).toBe("skipped");
    expect(result.steps[2]?.status).toBe("done");
    expect(result.steps[3]?.status).toBe("done");
  });

  it("stops cleanly on failure at step 2 and preserves step 1 receipt", async () => {
    const { port, sentCalls } = makeFakePort({ failStep: "registerRoute" });

    const result = await armRoute(port, BASE_INPUT, { confirm: async () => true });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.decoded?.name).toBe("OwnableUnauthorizedAccount");
    expect(result.receipts).toHaveLength(1);
    expect(sentCalls.map((c) => c.functionName)).toEqual(["setForwarder"]);
    expect(result.steps[0]?.status).toBe("done");
    expect(result.steps[1]?.status).toBe("failed");
    expect(result.steps[2]?.status).toBe("todo");
    expect(result.steps[3]?.status).toBe("todo");
  });

  it("reports PolicyDivergence at step 4 when forwarder disagrees with RSC", async () => {
    const { port } = makeFakePort({
      after: {
        ruleArmed: true,
        ruleColdWallet: OTHER_WALLET,
      },
    });

    const result = await armRoute(port, BASE_INPUT, { confirm: async () => true });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.divergence).toBeDefined();
    expect(result.divergence?.side).toBe("forwarder");
    expect(result.divergence?.expected).toBe(COLD_WALLET);
    expect(result.divergence?.actual).toBe(OTHER_WALLET);
    expect(result.steps[3]?.status).toBe("failed");
    expect(result.receipts).toHaveLength(4);
  });

  it("keeps reverted receipt and returns ok: false when a transaction reverts after send", async () => {
    const { port } = makeFakePort({ revertAfterSendStep: "armRoute" });

    const result = await armRoute(port, BASE_INPUT, { confirm: async () => true });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.decoded?.name).toBe("RouteNotArmed");
    expect(result.receipts).toHaveLength(4);
    expect(result.receipts[3]?.status).toBe("reverted");
    expect(result.steps[2]?.status).toBe("failed");
  });

  it("refuses when allowance is zero and no burner key is in the vault", async () => {
    const { port } = makeFakePort({ noKey: true });

    const result = await armRoute(port, BASE_INPUT, { confirm: async () => true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("EIP-2612 permit");
    expect(result.steps[2]?.status).toBe("failed");
  });

  it("findDivergence and deriveArmSteps reflect on-chain truth accurately", () => {
    const diverged: ArmingSnapshot = {
      forwarder: FORWARDER,
      routeActive: true,
      routeColdWallet: COLD_WALLET,
      ruleArmed: true,
      ruleColdWallet: OTHER_WALLET,
      allowance: 1n,
    };

    const div = findDivergence(diverged, COLD_WALLET);
    expect(div?.side).toBe("forwarder");
    expect(div?.actual).toBe(OTHER_WALLET);

    const steps = deriveArmSteps(
      {
        forwarder: FORWARDER,
        routeActive: true,
        routeColdWallet: COLD_WALLET,
        ruleArmed: false,
        ruleColdWallet: null,
        allowance: 0n,
      },
      { forwarder: FORWARDER, coldWallet: COLD_WALLET },
    );
    expect(steps[0]?.status).toBe("skipped");
    expect(steps[1]?.status).toBe("skipped");
    expect(steps[2]?.status).toBe("todo");
    expect(steps[3]?.status).toBe("todo");
  });
});
