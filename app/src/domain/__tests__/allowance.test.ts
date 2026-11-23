import { describe, expect, it } from "vitest";
import { assessAllowance, summarizeStrandRisk } from "@/domain/allowance";

describe("assessAllowance", () => {
  it("reports a zero allowance as missing, which is what stalls a sweep", () => {
    expect(assessAllowance({ allowance: 0n, liveBalance: 1_000n })).toEqual({
      state: "missing",
      allowance: "0",
    });
  });

  it("reports granted when the allowance covers the whole balance", () => {
    expect(assessAllowance({ allowance: 1_000n, liveBalance: 1_000n })).toEqual({
      state: "granted",
      allowance: "1000",
    });
  });

  it("reports granted for an unlimited allowance", () => {
    const max = 2n ** 256n - 1n;
    expect(assessAllowance({ allowance: max, liveBalance: 1_000n }).state).toBe("granted");
  });

  it("reports insufficient when the allowance is smaller than the balance", () => {
    // Non-zero is not enough: the forwarder pulls min(amount, balance), so a short
    // allowance leaves a remainder behind rather than failing outright.
    expect(assessAllowance({ allowance: 400n, liveBalance: 1_000n })).toEqual({
      state: "insufficient",
      allowance: "400",
    });
  });

  it("does not call a failed read a missing allowance", () => {
    expect(assessAllowance({ allowance: null, liveBalance: 1_000n })).toEqual({
      state: "unread",
      allowance: null,
    });
  });

  it("does not claim granted when the balance is unreadable", () => {
    expect(assessAllowance({ allowance: 1_000n, liveBalance: null })).toEqual({
      state: "unread",
      allowance: "1000",
    });
  });

  it("still reports missing when the balance is unreadable but the allowance is zero", () => {
    // Zero is a fact on its own, independent of the balance.
    expect(assessAllowance({ allowance: 0n, liveBalance: null }).state).toBe("missing");
  });
});

describe("summarizeStrandRisk", () => {
  const row = (burner: string, held: boolean, allowance: ReturnType<typeof assessAllowance>) => ({
    burner,
    residue: { state: held ? "held" : "cleared" },
    allowance,
  });

  const granted = assessAllowance({ allowance: 1_000n, liveBalance: 1_000n });
  const missing = assessAllowance({ allowance: 0n, liveBalance: 1_000n });
  const insufficient = assessAllowance({ allowance: 1n, liveBalance: 1_000n });
  const unread = assessAllowance({ allowance: null, liveBalance: 1_000n });

  it("counts a funded burner with no allowance as at risk", () => {
    expect(summarizeStrandRisk([row("0xaaa", true, missing)])).toEqual({
      atRiskBurners: 1,
      unknownBurners: 0,
    });
  });

  it("counts a partial allowance as at risk, because a residue would remain", () => {
    expect(summarizeStrandRisk([row("0xaaa", true, insufficient)]).atRiskBurners).toBe(1);
  });

  it("does not count an empty burner, even with no allowance", () => {
    expect(summarizeStrandRisk([row("0xaaa", false, missing)])).toEqual({
      atRiskBurners: 0,
      unknownBurners: 0,
    });
  });

  it("does not count a funded burner whose allowance covers it", () => {
    expect(summarizeStrandRisk([row("0xaaa", true, granted)]).atRiskBurners).toBe(0);
  });

  it("separates unread allowances from confirmed risk", () => {
    expect(summarizeStrandRisk([row("0xaaa", true, unread)])).toEqual({
      atRiskBurners: 0,
      unknownBurners: 1,
    });
  });

  it("counts a burner once across several deposits", () => {
    expect(
      summarizeStrandRisk([row("0xAAA", true, missing), row("0xaaa", true, missing)]).atRiskBurners,
    ).toBe(1);
  });
});
