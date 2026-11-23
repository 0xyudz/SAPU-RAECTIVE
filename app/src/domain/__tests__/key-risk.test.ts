import { describe, expect, it } from "vitest";
import { assessKeyRisk } from "@/domain/key-risk";

describe("assessKeyRisk", () => {
  it("keeps the guard off when no key is held, whatever the balance says", () => {
    expect(assessKeyRisk({ holdsKey: false, armed: true, balance: "1000" })).toEqual({
      atRisk: false,
      reason: "no-key",
    });
  });

  it("keeps the guard off for an empty, disarmed burner so a tab of empties closes silently", () => {
    expect(assessKeyRisk({ holdsKey: true, armed: false, balance: "0" })).toEqual({
      atRisk: false,
      reason: "empty-and-disarmed",
    });
  });

  it("warns when the burner holds a balance, even if it is not armed", () => {
    expect(assessKeyRisk({ holdsKey: true, armed: false, balance: "1" })).toEqual({
      atRisk: true,
      reason: "funded",
    });
  });

  it("warns when the burner is armed, even if it is empty right now", () => {
    expect(assessKeyRisk({ holdsKey: true, armed: true, balance: "0" })).toEqual({
      atRisk: true,
      reason: "armed",
    });
  });

  it("treats an unreadable balance as at risk, because unknown is not empty", () => {
    expect(assessKeyRisk({ holdsKey: true, armed: false, balance: null })).toEqual({
      atRisk: true,
      reason: "balance-unknown",
    });
  });

  it("prefers the funded reason over armed when both are true", () => {
    expect(assessKeyRisk({ holdsKey: true, armed: true, balance: "5" }).reason).toBe("funded");
  });
});
