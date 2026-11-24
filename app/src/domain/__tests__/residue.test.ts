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
  const TOKEN_A = "0xaaaa000000000000000000000000000000000001";
  const TOKEN_B = "0xbbbb000000000000000000000000000000000002";
  const row = (token: string, burner: string, residue: Residue) => ({ token, burner, residue });

  it("counts held positions and totals their live balances", () => {
    const summary = summarizeResidue([
      row(TOKEN_A, "0xaaa", { state: "held", liveBalance: "1000", stranded: "1000" }),
      row(TOKEN_A, "0xbbb", { state: "cleared", liveBalance: "0", stranded: "0" }),
      row(TOKEN_A, "0xccc", { state: "held", liveBalance: "250", stranded: "250" }),
    ]);
    expect(summary.heldBurners).toBe(2);
    expect(summary.unreadBurners).toBe(0);
    expect(summary.totals).toEqual([
      { token: TOKEN_A, totalHeld: "1250", heldPositions: 2, unreadPositions: 0 },
    ]);
  });

  it("counts a position once even when it appears in several rows", () => {
    const held: Residue = { state: "held", liveBalance: "1000", stranded: "1000" };
    const summary = summarizeResidue([row(TOKEN_A, "0xAAA", held), row(TOKEN_A, "0xaaa", held)]);
    expect(summary.heldBurners).toBe(1);
    expect(summary.totals).toEqual([
      { token: TOKEN_A, totalHeld: "1000", heldPositions: 1, unreadPositions: 0 },
    ]);
  });

  it("refuses to total a token that contains an unread position", () => {
    const summary = summarizeResidue([
      row(TOKEN_A, "0xaaa", { state: "held", liveBalance: "1000", stranded: "1000" }),
      row(TOKEN_A, "0xbbb", { state: "unread", liveBalance: null, stranded: null }),
    ]);
    expect(summary.heldBurners).toBe(1);
    expect(summary.unreadBurners).toBe(1);
    expect(summary.totals).toEqual([
      { token: TOKEN_A, totalHeld: null, heldPositions: 1, unreadPositions: 1 },
    ]);
  });

  it("reports an empty ledger as zero held", () => {
    expect(summarizeResidue([])).toEqual({ heldBurners: 0, unreadBurners: 0, totals: [] });
  });

  // The bug this pins: totalling across tokens adds base units of different scales and prints
  // a single number that means nothing. Two tokens must stay two totals.
  it("never adds different tokens into one total", () => {
    const summary = summarizeResidue([
      row(TOKEN_A, "0xaaa", { state: "held", liveBalance: "1000", stranded: "1000" }),
      row(TOKEN_B, "0xaaa", { state: "held", liveBalance: "2000", stranded: "2000" }),
    ]);

    expect(summary.totals).toHaveLength(2);
    expect(summary.totals).toEqual([
      { token: TOKEN_A, totalHeld: "1000", heldPositions: 1, unreadPositions: 0 },
      { token: TOKEN_B, totalHeld: "2000", heldPositions: 1, unreadPositions: 0 },
    ]);
    // The same burner armed for two tokens is two positions, not one.
    expect(summary.heldBurners).toBe(2);
  });

  it("keeps one token's total when a different token's read failed", () => {
    const summary = summarizeResidue([
      row(TOKEN_A, "0xaaa", { state: "held", liveBalance: "1000", stranded: "1000" }),
      row(TOKEN_B, "0xaaa", { state: "unread", liveBalance: null, stranded: null }),
    ]);

    // A failure on token B must not blank out token A's honest total.
    expect(summary.totals).toEqual([
      { token: TOKEN_A, totalHeld: "1000", heldPositions: 1, unreadPositions: 0 },
      { token: TOKEN_B, totalHeld: null, heldPositions: 0, unreadPositions: 1 },
    ]);
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
