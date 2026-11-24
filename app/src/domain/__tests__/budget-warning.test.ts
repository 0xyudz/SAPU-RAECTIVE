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
    // `computeSweepBudget` reports that as `sweepsRemaining: null`, which is the only way this
    // state reaches `assessBudget` — a non-null zero here would mean the loop really is out.
    const warning = assessBudget(budget({ gasLimit: 0n, sweepsRemaining: null }), noDebt);
    expect(warning.level).toBe("unknown");
  });

  it("does not confuse an unknown runway with an exhausted one", () => {
    // The regression: `sweepsRemaining` used to be `0n` when the cost was unknown, so this
    // returned "exhausted" — a red, actionable claim that the loop had stopped.
    const unknown = assessBudget(budget({ sweepsRemaining: null }), noDebt);
    const exhausted = assessBudget(budget({ sweepsRemaining: 0n }), noDebt);
    expect(unknown.level).toBe("unknown");
    expect(exhausted.level).toBe("exhausted");
    expect(unknown.headline).not.toMatch(/cannot pay/);
  });

  it("reports an unread debt as unknown, never as healthy", () => {
    // A swallowed `debt()` failure used to arrive here as `0n`, i.e. as "owes nothing".
    const warning = assessBudget(budget(), { rscDebt: null, forwarderDebt: 0n });
    expect(warning.level).toBe("unknown");
    expect(warning.headline).toMatch(/could not be read/);
  });

  it("reports an unread forwarder debt as unknown too", () => {
    const warning = assessBudget(budget(), { rscDebt: 0n, forwarderDebt: null });
    expect(warning.level).toBe("unknown");
  });

  it("lets a known debt outrank an unread one, because debt is the actionable fact", () => {
    const warning = assessBudget(budget(), { rscDebt: 5n, forwarderDebt: null });
    expect(warning.level).toBe("exhausted");
    expect(warning.headline).toMatch(/RSC is in debt/);
  });
});
