import { describe, expect, it } from "vitest";
import type { Address } from "@/domain/burner-route";
import {
  CUSTOM_TOKEN_VALUE,
  tokenChoiceLabel,
  tokenChoices,
} from "@/domain/token-choices";

/**
 * The Arm form used to be a raw hex box for the token, which meant an operator had to know a
 * 42-character contract address by heart to arm anything. The picker replaces it — but only if
 * its options come from the chain.
 *
 * A hardcoded USDC/WETH table would be the fixture this codebase forbids, and it would name the
 * wrong addresses on every chain except the one it was copied from. So these tests pin that the
 * options are derived from what the registry actually observed, that the configured token is a
 * seed rather than the answer, and that the free-text escape hatch survives — because a token
 * nobody has armed yet cannot appear in a list built from arming history.
 */

const SAPU = "0x6dec8e5106f1858aa85fd39363eeebd4400c78ad" as Address;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;

function row(token: Address, symbol: string | null, decimals: number | null) {
  return { token, tokenSymbol: symbol, tokenDecimals: decimals };
}

describe("tokenChoices", () => {
  it("lists every token the registry observed, with its own metadata", () => {
    const choices = tokenChoices([row(USDC, "USDC", 6), row(WETH, "WETH", 18)], SAPU);

    expect(choices.map((choice) => choice.address)).toEqual([SAPU, USDC, WETH]);
    expect(choices.find((c) => c.address === USDC)).toMatchObject({
      symbol: "USDC",
      decimals: 6,
      source: "registry",
    });
    expect(choices.find((c) => c.address === WETH)).toMatchObject({
      symbol: "WETH",
      decimals: 18,
    });
  });

  it("seeds the configured token even when no route for it was ever observed", () => {
    // A fresh deployment has no events yet. Without this seed the picker would be empty and
    // the operator could not arm the token the deployment was actually configured for.
    const choices = tokenChoices([], SAPU);

    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ address: SAPU, source: "configured" });
  });

  it("does not fabricate a symbol for the configured token", () => {
    // The configured token's symbol is NOT copied from env. If no row described it, it is
    // unknown, and an unknown symbol must render as such rather than as a borrowed ticker.
    const choices = tokenChoices([], SAPU);
    expect(choices[0]?.symbol).toBeNull();
    expect(tokenChoiceLabel(choices[0]!)).toBe("symbol unreadable");
  });

  it("takes the configured token's metadata from the registry row when one exists", () => {
    const choices = tokenChoices([row(SAPU, "SAPU", 18)], SAPU);

    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({
      address: SAPU,
      symbol: "SAPU",
      decimals: 18,
      source: "configured",
    });
  });

  it("collapses duplicate tokens across burners into one asset", () => {
    // Two burners routing SAPU are one token, not two options.
    const choices = tokenChoices([row(SAPU, "SAPU", 18), row(SAPU, "SAPU", 18)], SAPU);
    expect(choices).toHaveLength(1);
  });

  it("collapses addresses that differ only in case", () => {
    const choices = tokenChoices(
      [row(USDC, "USDC", 6), row(USDC.toUpperCase().replace("0X", "0x") as Address, "USDC", 6)],
      null,
    );
    expect(choices).toHaveLength(1);
  });

  it("puts the configured token first, because it is the default", () => {
    const choices = tokenChoices([row(USDC, "USDC", 6), row(WETH, "WETH", 18)], SAPU);
    expect(choices[0]?.source).toBe("configured");
  });

  it("orders the rest by symbol so the list does not reshuffle between polls", () => {
    const choices = tokenChoices([row(WETH, "WETH", 18), row(USDC, "USDC", 6)], null);
    expect(choices.map((c) => c.symbol)).toEqual(["USDC", "WETH"]);
  });

  it("keeps a token whose symbol could not be read, ordered by address", () => {
    const choices = tokenChoices([row(USDC, null, null)], null);
    expect(choices).toHaveLength(1);
    expect(tokenChoiceLabel(choices[0]!)).toBe("symbol unreadable");
  });

  it("returns nothing when there is neither history nor a configured token", () => {
    expect(tokenChoices([], null)).toEqual([]);
  });

  it("never returns a hardcoded token, so it cannot drift from the deployment", () => {
    // Guards the anti-fixture rule directly: with no inputs there are no options at all.
    expect(tokenChoices([], null)).toHaveLength(0);
  });
});

describe("tokenChoiceLabel", () => {
  it("shows symbol and decimals when both were read", () => {
    const choices = tokenChoices([row(USDC, "USDC", 6)], null);
    expect(tokenChoiceLabel(choices[0]!)).toBe("USDC · 6 dp");
  });

  it("shows zero decimals, because 0 is a legal value and not a missing one", () => {
    // A 0-decimal token is real. `decimals: 0` must render as `0 dp`, not be dropped as falsy.
    const choices = tokenChoices([row(USDC, "USDC", 0)], null);
    expect(tokenChoiceLabel(choices[0]!)).toBe("USDC · 0 dp");
  });

  it("omits decimals when only the symbol was read", () => {
    const choices = tokenChoices([row(USDC, "USDC", null)], null);
    expect(tokenChoiceLabel(choices[0]!)).toBe("USDC");
  });

  it("says the symbol is unreadable rather than showing a blank label", () => {
    // A bare address looks like a token that simply has no ticker; naming the failure says
    // the picker is showing hex for a reason.
    const choices = tokenChoices([row(USDC, null, 6)], null);
    expect(tokenChoiceLabel(choices[0]!)).toBe("symbol unreadable");
  });
});

describe("CUSTOM_TOKEN_VALUE", () => {
  it("cannot collide with a real option value, which is always an address", () => {
    expect(CUSTOM_TOKEN_VALUE.startsWith("0x")).toBe(false);
    expect(CUSTOM_TOKEN_VALUE).toBe("__custom__");
  });
});
