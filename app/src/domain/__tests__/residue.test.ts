import { describe, expect, it } from "vitest";
import {
  burnerBalanceNotice,
  classifyResidue,
  strandedAmount,
  summarizeResidue,
  type Residue,
} from "@/domain/residue";

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

describe("burnerBalanceNotice", () => {
  it("calls a funded burner dangerous and states the raw amount", () => {
    expect(burnerBalanceNotice({ kind: "read", balance: "1000000000000000000" })).toEqual({
      note: "1000000000000000000 base units still in this burner",
      tone: "danger",
    });
  });

  it("calls a zero balance empty, and does not colour it as a warning", () => {
    expect(burnerBalanceNotice({ kind: "read", balance: "0" })).toEqual({
      note: "burner is empty",
      tone: "muted",
    });
  });

  it("treats a failed read as dangerous, never as empty", () => {
    const notice = burnerBalanceNotice({ kind: "failed", reason: "timeout" });
    expect(notice.tone).toBe("danger");
    expect(notice.note).toContain("timeout");
  });

  it("treats an unreadable balanceOf as dangerous, never as empty", () => {
    // The endpoint answered but balanceOf could not be read. Rendering this as
    // "burner is empty" would disarm the beforeunload guard on a funded burner.
    const notice = burnerBalanceNotice({ kind: "unread" });
    expect(notice.tone).toBe("danger");
    expect(notice.note).toContain("treat it as funded");
  });

  it("treats a non-numeric balance as unread rather than as zero", () => {
    const notice = burnerBalanceNotice({ kind: "read", balance: "not-a-number" });
    expect(notice.tone).toBe("danger");
    expect(notice.note).toContain("could not be read");
  });

  it("keeps the waiting states muted", () => {
    expect(burnerBalanceNotice({ kind: "no-burner" })).toEqual({
      note: "no burner selected",
      tone: "muted",
    });
    expect(burnerBalanceNotice({ kind: "no-token" }).tone).toBe("muted");
    expect(burnerBalanceNotice({ kind: "pending" }).tone).toBe("muted");
  });

  it("never derives the tone from the text, so rewording cannot repaint a warning", () => {
    // Guard against a regression to substring matching: every danger note is distinct.
    const dangerNotes = [
      burnerBalanceNotice({ kind: "read", balance: "1" }).note,
      burnerBalanceNotice({ kind: "failed", reason: "x" }).note,
      burnerBalanceNotice({ kind: "unread" }).note,
    ];
    expect(new Set(dangerNotes).size).toBe(3);
  });
});
