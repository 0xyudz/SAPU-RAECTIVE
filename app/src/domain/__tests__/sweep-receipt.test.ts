import { describe, expect, it } from "vitest";
import {
  formatAmount,
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

  it("returns null for a value it cannot scale, instead of pretending it is zero", () => {
    // `0` is a real balance. Using it as the error sentinel made a malformed read render as an
    // empty position — a claim about the chain that nothing observed.
    expect(formatUnits("abc", 18)).toBeNull();
    expect(formatUnits("1.5", 18)).toBeNull();
    expect(formatUnits("", 18)).toBeNull();
    expect(formatUnits("1", -1)).toBeNull();
  });

  it("does not treat a negative string as a signed amount", () => {
    // ERC-20 balances are uint256. The old implementation had a sign branch that could never
    // run, because the digits-only guard rejected the minus sign first.
    expect(formatUnits("-1", 18)).toBeNull();
  });
});

/**
 * The ledger has three places that print an amount, and all three need the same answer to
 * "what do we show when `decimals()` could not be read?". They used to answer it separately, with
 * a `?? 0` fallback — which turned 1230000 base units of a 6-decimal token into a displayed
 * `1230000 USDC`, a million times the real amount, with nothing marking it as unscaled.
 */
describe("formatAmount", () => {
  it("scales when decimals are known", () => {
    expect(formatAmount("1500000", 6, "USDC")).toBe("1.5 USDC");
    expect(formatAmount("1000000000000000000", 18, "SAPU")).toBe("1 SAPU");
  });

  it("treats 0 decimals as a real scale, not as unknown", () => {
    // A 0-decimal token's amount IS its base units, so it must render as a plain integer — and
    // must not be labelled, because there is nothing unscaled about it.
    expect(formatAmount("1230000", 0, "PEPE")).toBe("1230000 PEPE");
  });

  it("names base units when decimals are unreadable, so the integer cannot pass for a scale", () => {
    expect(formatAmount("1230000", null, "USDC")).toBe("1230000 base units USDC");
  });

  it("never guesses 18 for an unreadable scale", () => {
    // The other tempting fallback. `formatUnits("1230000", 18)` is `0.00000000000123`, which is a
    // fabricated number twelve orders of magnitude from the truth.
    expect(formatAmount("1230000", null, "USDC")).not.toContain("0.000");
  });

  it("renders a failed read as an em dash, never as zero", () => {
    // `0 USDC` is a claim about the chain; a failed read is not.
    expect(formatAmount(null, 6, "USDC")).toBe("—");
    expect(formatAmount(null, null, "USDC")).toBe("—");
  });

  it("shows an unparsable value verbatim rather than as zero", () => {
    // Reaching here means the index produced something that is not base units. Printing `0 USDC`
    // would report a malformed read as an empty position.
    expect(formatAmount("not-a-number", 6, "USDC")).toBe("not-a-number base units USDC");
  });
});
