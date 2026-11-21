import { describe, expect, it } from "vitest";
import {
  createRoute,
  DEFAULT_ROUTE_RULES,
  InvalidRouteError,
  isAddress,
  meetsMinimum,
  toAddress,
  transition,
  validateRules,
} from "@/domain/burner-route";

const BURNER = "0x1111111111111111111111111111111111111111";
const COLD = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";

function baseInput() {
  return {
    burner: BURNER,
    coldWallet: COLD,
    token: TOKEN,
    tokenSymbol: "sapu",
    tokenDecimals: 18,
    chainId: 84532,
  };
}

describe("isAddress", () => {
  it("accepts a valid checksummed or lowercase address", () => {
    expect(isAddress(BURNER)).toBe(true);
    expect(isAddress("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress("1111111111111111111111111111111111111111")).toBe(false);
    expect(isAddress("0x" + "g".repeat(40))).toBe(false);
    expect(isAddress(null)).toBe(false);
    expect(isAddress(42)).toBe(false);
  });
});

describe("toAddress", () => {
  it("normalises to lowercase", () => {
    expect(toAddress("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("throws on invalid input", () => {
    expect(() => toAddress("nope")).toThrow(InvalidRouteError);
  });
});

describe("createRoute", () => {
  it("normalises a valid route and applies default rules", () => {
    const { route, rules } = createRoute(baseInput());

    expect(route.burner).toBe(BURNER);
    expect(route.coldWallet).toBe(COLD);
    expect(route.token).toBe(TOKEN);
    expect(route.tokenSymbol).toBe("SAPU");
    expect(route.status).toBe("draft");
    expect(route.armedAt).toBe(0);
    expect(rules).toEqual(DEFAULT_ROUTE_RULES);
  });

  it("rejects a route whose burner equals its cold wallet", () => {
    expect(() => createRoute({ ...baseInput(), coldWallet: BURNER })).toThrow(/must be different/);
  });

  it("rejects a non-positive chain id", () => {
    expect(() => createRoute({ ...baseInput(), chainId: 0 })).toThrow(InvalidRouteError);
    expect(() => createRoute({ ...baseInput(), chainId: -1 })).toThrow(InvalidRouteError);
    expect(() => createRoute({ ...baseInput(), chainId: 1.5 })).toThrow(InvalidRouteError);
  });

  it("rejects out-of-range token decimals", () => {
    expect(() => createRoute({ ...baseInput(), tokenDecimals: -1 })).toThrow(InvalidRouteError);
    expect(() => createRoute({ ...baseInput(), tokenDecimals: 37 })).toThrow(InvalidRouteError);
  });

  it("rejects an empty token symbol", () => {
    expect(() => createRoute({ ...baseInput(), tokenSymbol: "   " })).toThrow(InvalidRouteError);
  });

  it("accepts rule overrides", () => {
    const { rules } = createRoute({ ...baseInput(), rules: { minDeposit: "1000", maxSweeps: 1 } });
    expect(rules.minDeposit).toBe("1000");
    expect(rules.maxSweeps).toBe(1);
    expect(rules.sweepContinuously).toBe(true);
  });

  it("rejects a malformed minDeposit", () => {
    expect(() => createRoute({ ...baseInput(), rules: { minDeposit: "1.5" } })).toThrow(InvalidRouteError);
    expect(() => createRoute({ ...baseInput(), rules: { minDeposit: "-1" } })).toThrow(InvalidRouteError);
  });
});

describe("validateRules", () => {
  it("accepts null maxSweeps", () => {
    expect(() => validateRules({ ...DEFAULT_ROUTE_RULES, maxSweeps: null })).not.toThrow();
  });

  it("rejects a zero or negative maxSweeps", () => {
    expect(() => validateRules({ ...DEFAULT_ROUTE_RULES, maxSweeps: 0 })).toThrow(InvalidRouteError);
    expect(() => validateRules({ ...DEFAULT_ROUTE_RULES, maxSweeps: -2 })).toThrow(InvalidRouteError);
  });
});

describe("meetsMinimum", () => {
  const rules = { ...DEFAULT_ROUTE_RULES, minDeposit: "1000" };

  it("compares using BigInt so large base-unit values do not lose precision", () => {
    expect(meetsMinimum("9007199254740993", rules)).toBe(true);
    expect(meetsMinimum("999", rules)).toBe(false);
    expect(meetsMinimum("1000", rules)).toBe(true);
  });

  it("rejects non-numeric amounts", () => {
    expect(meetsMinimum("1.5", rules)).toBe(false);
    expect(meetsMinimum("abc", rules)).toBe(false);
  });
});

describe("transition", () => {
  it("stamps armedAt only on the first transition to armed", () => {
    const { route } = createRoute(baseInput());
    const armed = transition(route, "armed", 1_700_000_000);
    expect(armed.armedAt).toBe(1_700_000_000);

    const watching = transition(armed, "watching", 1_700_000_500);
    expect(watching.armedAt).toBe(1_700_000_000);
  });

  it("does not stamp armedAt for other statuses", () => {
    const { route } = createRoute(baseInput());
    expect(transition(route, "revoked", 1_700_000_000).armedAt).toBe(0);
  });
});
