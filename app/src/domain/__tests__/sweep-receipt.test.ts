import { describe, expect, it } from "vitest";
import {
  formatUnits,
  IncompleteReceiptError,
  withReactiveLeg,
  withSweepLeg,
  type ChainLeg,
  type SweepReceipt,
} from "@/domain/sweep-receipt";

const BURNER = "0x1111111111111111111111111111111111111111" as const;
const COLD = "0x2222222222222222222222222222222222222222" as const;
const TOKEN = "0x3333333333333333333333333333333333333333" as const;

function leg(overrides: Partial<ChainLeg> = {}): ChainLeg {
  return {
    txHash: "0xaaaa000000000000000000000000000000000000000000000000000000000001",
    chainId: 84532,
    blockNumber: "100",
    timestamp: 1_700_000_000,
    explorerUrl: "https://sepolia.basescan.org/tx/0xaaaa",
    ...overrides,
  };
}

function depositOnly(): SweepReceipt {
  return {
    id: "0xaaaa000000000000000000000000000000000000000000000000000000000001",
    burner: BURNER,
    coldWallet: COLD,
    token: TOKEN,
    tokenSymbol: "SAPU",
    tokenDecimals: 18,
    depositAmount: "1000000000000000000",
    sweptAmount: null,
    deposit: leg(),
    reactive: null,
    sweep: null,
  };
}

describe("withReactiveLeg / withSweepLeg", () => {
  it("records each leg without overwriting an earlier one", () => {
    const withReactive = withReactiveLeg(depositOnly(), leg({ chainId: 5318007 }));
    expect(withReactive.reactive?.chainId).toBe(5318007);

    const withSweep = withSweepLeg(withReactive, leg(), "1");
    expect(withSweep.sweep?.txHash).toBe(leg().txHash);
    expect(withSweep.sweptAmount).toBe("1");
  });

  it("refuses to overwrite an existing leg", () => {
    const withReactive = withReactiveLeg(depositOnly(), leg());
    expect(() => withReactiveLeg(withReactive, leg())).toThrow(IncompleteReceiptError);

    const withSweep = withSweepLeg(withReactive, leg(), "1");
    expect(() => withSweepLeg(withSweep, leg(), "2")).toThrow(IncompleteReceiptError);
  });

  it("does not mutate the input receipt", () => {
    const original = depositOnly();
    withReactiveLeg(original, leg());
    expect(original.reactive).toBeNull();
  });
});

describe("formatUnits", () => {
  it("renders 18-decimal amounts exactly", () => {
    expect(formatUnits("1000000000000000000", 18)).toBe("1");
    expect(formatUnits("1500000000000000000", 18)).toBe("1.5");
    expect(formatUnits("1", 18)).toBe("0.000000000000000001");
    expect(formatUnits("0", 18)).toBe("0");
  });

  it("handles 6-decimal tokens", () => {
    expect(formatUnits("1500000", 6)).toBe("1.5");
    expect(formatUnits("1", 6)).toBe("0.000001");
  });

  it("strips trailing zeros in the fraction", () => {
    expect(formatUnits("1230000000000000000", 18)).toBe("1.23");
  });

  it("preserves very large values without precision loss", () => {
    expect(formatUnits("123456789012345678901234567890", 18)).toBe("123456789012.34567890123456789");
  });

  it("returns 0 for non-numeric input", () => {
    expect(formatUnits("abc", 18)).toBe("0");
    expect(formatUnits("1.5", 18)).toBe("0");
  });
});
