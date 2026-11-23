import { describe, expect, it } from "vitest";
import { classifyResidue, strandedAmount, summarizeResidue, type Residue } from "@/domain/residue";

describe("strandedAmount", () => {
  it("treats an unswept deposit as fully stranded", () => {
    expect(strandedAmount("1000", null)).toBe("1000");
  });

  it("reports zero when the sweep matched the deposit", () => {
    expect(strandedAmount("1000", "1000")).toBe("0");
  });

  it("reports the clamped remainder when the sweep moved less", () => {
    expect(strandedAmount("1000", "400")).toBe("600");
  });

  it("never reports a negative remainder when a sweep exceeded the deposit", () => {
    expect(strandedAmount("1000", "1500")).toBe("0");
  });

  it("returns null for a non-numeric deposit", () => {
    expect(strandedAmount("not-a-number", null)).toBeNull();
  });
});

describe("classifyResidue", () => {
  it("marks a funded burner as held", () => {
    const residue = classifyResidue({ liveBalance: 1_000n, depositAmount: "1000", sweptAmount: null });
    expect(residue).toEqual({ state: "held", liveBalance: "1000", stranded: "1000" });
  });

  it("marks an empty burner as cleared", () => {
    const residue = classifyResidue({ liveBalance: 0n, depositAmount: "1000", sweptAmount: "1000" });
    expect(residue).toEqual({ state: "cleared", liveBalance: "0", stranded: "0" });
  });

  it("does not claim a stranded amount when the read failed", () => {
    const residue = classifyResidue({ liveBalance: null, depositAmount: "1000", sweptAmount: null });
    expect(residue).toEqual({ state: "unread", liveBalance: null, stranded: null });
  });
});

describe("summarizeResidue", () => {
  const row = (burner: string, residue: Residue) => ({ burner, residue });

  it("counts held burners and totals their live balances", () => {
    const summary = summarizeResidue([
      row("0xaaa", { state: "held", liveBalance: "1000", stranded: "1000" }),
      row("0xbbb", { state: "cleared", liveBalance: "0", stranded: "0" }),
      row("0xccc", { state: "held", liveBalance: "250", stranded: "250" }),
    ]);
    expect(summary).toEqual({ heldBurners: 2, unreadBurners: 0, totalHeld: "1250" });
  });

  it("counts a burner once even when it appears in several rows", () => {
    const held: Residue = { state: "held", liveBalance: "1000", stranded: "1000" };
    const summary = summarizeResidue([row("0xAAA", held), row("0xaaa", held)]);
    expect(summary).toEqual({ heldBurners: 1, unreadBurners: 0, totalHeld: "1000" });
  });

  it("refuses to total a set that contains an unread burner", () => {
    const summary = summarizeResidue([
      row("0xaaa", { state: "held", liveBalance: "1000", stranded: "1000" }),
      row("0xbbb", { state: "unread", liveBalance: null, stranded: null }),
    ]);
    expect(summary).toEqual({ heldBurners: 1, unreadBurners: 1, totalHeld: null });
  });

  it("reports an empty ledger as zero held", () => {
    expect(summarizeResidue([])).toEqual({ heldBurners: 0, unreadBurners: 0, totalHeld: "0" });
  });
});
