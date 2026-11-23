import { describe, expect, it } from "vitest";
import {
  createRoute,
  InvalidRouteError,
  isAddress,
  toAddress,
  transition,
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
  it("normalises a valid route", () => {
    const { route } = createRoute(baseInput());

    expect(route.burner).toBe(BURNER);
    expect(route.coldWallet).toBe(COLD);
    expect(route.token).toBe(TOKEN);
    expect(route.tokenSymbol).toBe("SAPU");
    expect(route.status).toBe("draft");
    expect(route.armedAt).toBe(0);
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
});

describe("route policy", () => {
  it("carries no rule fields, because nothing could enforce them", () => {
    // `minDeposit` and `maxSweeps` used to live here. Both were validated and tested but
    // never read by anything: `SapuRSC.react` requests a callback for any non-zero amount,
    // and no per-route sweep counter exists. Keeping them made the app look like it
    // filtered dust when it did not. This assertion fails loudly if either returns without
    // an enforcement path.
    const { route } = createRoute(baseInput());
    const keys = Object.keys(route);
    expect(keys).not.toContain("minDeposit");
    expect(keys).not.toContain("maxSweeps");
    expect(keys).not.toContain("rules");
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
