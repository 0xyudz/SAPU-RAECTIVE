import { describe, expect, it } from "vitest";
import { explainStrand, type SweepPreconditions } from "@/domain/strand-cause";

const healthy: SweepPreconditions = {
  allowance: "granted",
  forwarderArmed: true,
  rscActive: true,
  coldWalletAgrees: true,
};

function cause(
  residue: "cleared" | "held" | "unread",
  overrides: Partial<SweepPreconditions> = {},
  dustIgnored = false,
) {
  return explainStrand({ residue, dustIgnored, preconditions: { ...healthy, ...overrides } });
}

describe("explainStrand", () => {
  it("reports a cleared burner as resolved, regardless of preconditions", () => {
    expect(cause("cleared", { allowance: "missing" }).id).toBe("resolved");
  });

  it("reports an unreadable balance as a reading failure, not a cause", () => {
    expect(cause("unread").id).toBe("preconditions-unread");
  });

  it("blames a zero allowance first, because a sweep reverts there before anything else", () => {
    expect(cause("held", { allowance: "missing" }).id).toBe("allowance-missing");
  });

  it("reports a below-floor deposit from the DustIgnored event, before any other cause", () => {
    // A dust deposit never requested a callback, so the allowance and the rule were never
    // reached. Reporting them would send the operator to fix a blocker that is not in play.
    expect(cause("held", { allowance: "missing" }, true).id).toBe("below-dust-floor");
    expect(cause("held", { forwarderArmed: false }, true).id).toBe("below-dust-floor");
    expect(cause("held", {}, true).id).toBe("below-dust-floor");
  });

  it("does not claim a dust cause when the event was not observed", () => {
    // The flag has to come from the chain. A small balance with every precondition satisfied
    // is still reported as historical, never as dust, because nothing proved it was refused.
    expect(cause("held", {}, false).id).toBe("not-reproducible");
  });

  it("blames a disarmed forwarder rule", () => {
    expect(cause("held", { forwarderArmed: false }).id).toBe("rule-disarmed");
  });

  it("blames a revoked reactive route", () => {
    expect(cause("held", { rscActive: false }).id).toBe("route-inactive");
  });

  it("blames a destination disagreement between the two sides", () => {
    expect(cause("held", { coldWalletAgrees: false }).id).toBe("cold-wallet-mismatch");
  });

  it("refuses to name a cause when a precondition is unreadable", () => {
    expect(cause("held", { forwarderArmed: null }).id).toBe("preconditions-unread");
    expect(cause("held", { rscActive: null }).id).toBe("preconditions-unread");
    expect(cause("held", { allowance: "unread" }).id).toBe("preconditions-unread");
  });

  it("blames a partial allowance only after every hard blocker is cleared", () => {
    // A zero allowance is a harder blocker than a partial one, so it wins the ordering.
    expect(cause("held", { allowance: "insufficient" }).id).toBe("allowance-partial");
    expect(cause("held", { allowance: "insufficient", forwarderArmed: false }).id).toBe("rule-disarmed");
  });

  it("calls a residue historical when every precondition currently passes", () => {
    const explained = cause("held");
    expect(explained.id).toBe("not-reproducible");
    expect(explained.detail).toMatch(/rescue/);
  });

  it("gives each cause a headline and a detail, so the UI never renders an empty reason", () => {
    for (const overrides of [
      {},
      { allowance: "missing" as const },
      { allowance: "insufficient" as const },
      { forwarderArmed: false },
      { rscActive: false },
      { coldWalletAgrees: false },
      { forwarderArmed: null },
    ]) {
      const explained = cause("held", overrides);
      expect(explained.headline.length).toBeGreaterThan(10);
      expect(explained.detail.length).toBeGreaterThan(20);
    }
  });
});
