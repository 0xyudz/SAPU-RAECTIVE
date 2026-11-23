import { describe, expect, it } from "vitest";
import { assessBudget, LOW_SWEEPS_THRESHOLD } from "@/domain/budget-warning";
import type { SweepBudget } from "@/domain/budget";

function budget(overrides: Partial<SweepBudget> = {}): SweepBudget {
  return {
    balanceWei: 10n ** 18n,
    gasLimit: 400_000n,
    gasPriceWei: 6_000_000n,
    sweepsRemaining: 4_165n,
    costPerSweepWei: 2_400_000_000_000n,
    ...overrides,
  };
}

const noDebt = { rscDebt: 0n, forwarderDebt: 0n };

describe("assessBudget", () => {
  it("reports a healthy budget as healthy", () => {
    expect(assessBudget(budget(), noDebt).level).toBe("healthy");
  });

  it("warns when the runway drops below the threshold", () => {
    const warning = assessBudget(budget({ sweepsRemaining: LOW_SWEEPS_THRESHOLD - 1n }), noDebt);
    expect(warning.level).toBe("low");
    expect(warning.headline).toContain("24");
  });

  it("treats the threshold itself as still healthy", () => {
    expect(assessBudget(budget({ sweepsRemaining: LOW_SWEEPS_THRESHOLD }), noDebt).level).toBe("healthy");
  });

  it("reports exhaustion at zero remaining sweeps", () => {
    expect(assessBudget(budget({ sweepsRemaining: 0n }), noDebt).level).toBe("exhausted");
  });

  it("puts RSC debt ahead of everything, because the loop is not watching at all", () => {
    const warning = assessBudget(budget(), { rscDebt: 1n, forwarderDebt: 1n });
    expect(warning.level).toBe("exhausted");
    expect(warning.headline).toMatch(/RSC is in debt/);
  });

  it("reports forwarder debt as exhausted even with budget remaining", () => {
    const warning = assessBudget(budget(), { rscDebt: 0n, forwarderDebt: 1n });
    expect(warning.level).toBe("exhausted");
    expect(warning.headline).toMatch(/forwarder is in debt/);
  });

  it("refuses to invent a runway when the cost per sweep is zero", () => {
    // A zero gas limit or gas price would make "remaining sweeps" a division by zero.
    const warning = assessBudget(budget({ gasLimit: 0n, sweepsRemaining: 0n }), noDebt);
    expect(warning.level).toBe("unknown");
  });
});
